// graph-builder.ts — pure translation from CePlan IR to bd create --graph JSON.
//
// Emits the GraphApplyPlan schema verified against
// upstream/beads/cmd/bd/graph_apply.go at the pinned commit:
//   - nodes: key, title, type, description, labels, metadata (map[string]string), parent_key
//   - edges: from_key (dependent), to_key (blocker), type "blocks"
//
// Node keys derive from stable identity (plan path hash + U-ID), not titles.
// All metadata values are strings (KTD10). The plan digest lives only on the
// epic (KTD12). This is a pure function: no bd invocation, fully unit-testable.

import { createHash } from "node:crypto";
import type { CePlan, CeUnit } from "./plan-parser.ts";

// --- Types: graph JSON schema (mirrors GraphApplyPlan in graph_apply.go) ----

export interface GraphApplyNode {
  key: string;
  title: string;
  type: "epic" | "task";
  description: string;
  labels: string[];
  metadata: Record<string, string>;
  parent_key?: string;
}

export interface GraphApplyEdge {
  from_key: string;
  to_key: string;
  type: "blocks";
}

export interface GraphApplyPlan {
  nodes: GraphApplyNode[];
  edges: GraphApplyEdge[];
}

// --- Identity / key derivation ---------------------------------------------

/**
 * Deterministic node key from plan path + U-ID. sha256 over
 * `${planPath}::${unitId}`, truncated to 16 hex chars. Stable across runs
 * and independent of titles or ordinal position.
 */
export function nodeKey(planPath: string, unitId: string): string {
  return createHash("sha256")
    .update(`${planPath}::${unitId}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/** Epic key from plan path. */
export function epicKey(planPath: string): string {
  return nodeKey(planPath, "__epic__");
}

// --- Canonical metadata helpers (KTD10, KTD12, KTD18) -----------------------

/** Sorted, deduplicated JSON-array string of U-IDs (KTD12 epic roster). */
export function canonicalUnitIds(units: CeUnit[]): string {
  const ids = units.map((u) => u.id).sort();
  return JSON.stringify(ids);
}

/**
 * Sorted, deduplicated JSON-array string of dependency U-IDs (KTD18).
 * `"[]"` when empty — never a missing key or bare empty string.
 */
export function canonicalDependencies(deps: string[]): string {
  const sorted = [...new Set(deps)].sort();
  return JSON.stringify(sorted);
}

/** Comma-joined requirement IDs (KTD10: compact string). */
export function canonicalRequirements(reqs: string[]): string {
  return [...new Set(reqs)].sort().join(",");
}

// --- Unit digest (KTD12) ----------------------------------------------------

/**
 * Versioned canonical projection of ce-beads-owned fields, hashed with sha256.
 * Excludes user-owned execution state (status, assignee, labels, notes, edges)
 * so execution activity never produces false content drift.
 *
 * Projection version is embedded in the hash input so a projection schema
 * change invalidates all stored digests (forcing re-sync, not silent trust).
 */
export const UNIT_DIGEST_PROJECTION_VERSION = "ce-beads-unit-digest/v1";

export function unitDigest(unit: CeUnit, planPath: string, epicKeyVal: string): string {
  const projection = {
    v: UNIT_DIGEST_PROJECTION_VERSION,
    title: unit.title,
    goal: unit.goal,
    requirements: canonicalRequirements(unit.requirements),
    dependencies: canonicalDependencies(unit.dependencies),
    files: unit.files,
    approach: unit.approach,
    executionNote: unit.executionNote ?? null,
    technicalDesign: unit.technicalDesign ?? null,
    patterns: unit.patterns,
    testScenarios: unit.testScenarios,
    verification: unit.verification,
    issueType: "task",
    parentKey: epicKeyVal,
    planPath,
    unitId: unit.id,
  };
  // Canonical serialization: sorted keys via JSON.stringify with a replacer
  // that produces stable key order.
  const canonical = stableJson(projection);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// --- Bounded description (KTD12: snapshot, not whole plan) -----------------

/**
 * Render the bounded execution snapshot for a unit task description.
 * Carries goal, requirement IDs, files, approach, execution note, patterns,
 * test scenarios, verification, and source plan path + U-ID. Never includes
 * the raw plan digest (that lives on the epic only).
 */
export function renderUnitDescription(unit: CeUnit, planPath: string): string {
  const lines: string[] = [
    `# ${unit.id}: ${unit.title}`,
    "",
    `**Source plan:** \`${planPath}\``,
    `**Unit ID:** ${unit.id}`,
    "",
    "## Goal",
    unit.goal,
    "",
    "## Requirements",
    unit.requirements.join(", "),
    "",
    "## Files",
    unit.files.map((f) => `- \`${f}\``).join("\n"),
    "",
    "## Approach",
    unit.approach,
  ];
  if (unit.executionNote) {
    lines.push("", "## Execution note", unit.executionNote);
  }
  if (unit.technicalDesign) {
    lines.push("", "## Technical design", unit.technicalDesign);
  }
  lines.push(
    "", "## Patterns to follow",
    unit.patterns.map((p) => `- ${p}`).join("\n"),
    "", "## Test scenarios",
    unit.testScenarios.map((s) => `- ${s}`).join("\n"),
    "", "## Verification",
    unit.verification.map((v) => `- ${v}`).join("\n"),
  );
  return lines.join("\n");
}

// --- Epic description -------------------------------------------------------

export function renderEpicDescription(plan: CePlan): string {
  return [
    `# ${plan.title}`,
    "",
    `**Plan path:** \`${plan.path}\``,
    `**Artifact contract:** ${plan.artifactContract}`,
    `**Readiness:** ${plan.readiness}`,
    `**Execution:** ${plan.execution}`,
    "",
    `Bound by ce-beads/v1. This epic represents the plan; each child task is one implementation unit.`,
    "",
    `## Units (${plan.units.length})`,
    ...plan.units.map((u) => `- **${u.id}:** ${u.title}`),
  ].join("\n");
}

// --- Graph builder (pure function) ------------------------------------------

/**
 * Build the complete GraphApplyPlan from a CePlan IR.
 *
 * Emits one epic node + one task node per unit, with parent_key linking
 * tasks to the epic, and blocking edges derived from CE unit dependencies
 * (from_key = dependent, to_key = blocker, type "blocks").
 *
 * Metadata (all string-valued per KTD10):
 *   Epic: integration, ce_plan_path, ce_plan_digest, ce_artifact_contract, ce_unit_ids
 *   Task: integration, ce_plan_path, ce_unit_id, ce_unit_digest, ce_requirements, ce_dependencies
 */
export function buildGraph(plan: CePlan): GraphApplyPlan {
  const eKey = epicKey(plan.path);
  const unitIds = canonicalUnitIds(plan.units);

  const epicNode: GraphApplyNode = {
    key: eKey,
    title: plan.title,
    type: "epic",
    description: renderEpicDescription(plan),
    labels: ["ce-beads"],
    metadata: {
      integration: "ce-beads/v1",
      ce_plan_path: plan.path,
      ce_plan_digest: plan.digest,
      ce_artifact_contract: plan.artifactContract,
      ce_unit_ids: unitIds,
    },
  };

  const taskNodes: GraphApplyNode[] = plan.units.map((unit) => {
    const tKey = nodeKey(plan.path, unit.id);
    return {
      key: tKey,
      title: `${unit.id}: ${unit.title}`,
      type: "task",
      description: renderUnitDescription(unit, plan.path),
      labels: ["ce-beads"],
      metadata: {
        integration: "ce-beads/v1",
        ce_plan_path: plan.path,
        ce_unit_id: unit.id,
        ce_unit_digest: unitDigest(unit, plan.path, eKey),
        ce_requirements: canonicalRequirements(unit.requirements),
        ce_dependencies: canonicalDependencies(unit.dependencies),
      },
      parent_key: eKey,
    };
  });

  // Edges: for each unit's dependency, from_key = dependent, to_key = blocker.
  const edges: GraphApplyEdge[] = [];
  for (const unit of plan.units) {
    for (const dep of unit.dependencies) {
      edges.push({
        from_key: nodeKey(plan.path, unit.id),
        to_key: nodeKey(plan.path, dep),
        type: "blocks",
      });
    }
  }

  return { nodes: [epicNode, ...taskNodes], edges };
}

// --- Stable JSON serialization ---------------------------------------------

/**
 * Canonical JSON with sorted object keys. Produces deterministic output so
 * digests are stable across runs and runtimes.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
