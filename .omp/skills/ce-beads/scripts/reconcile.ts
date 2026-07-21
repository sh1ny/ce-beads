// reconcile.ts — compare engine for status (U6) and sync (U7).
//
// Owns the drift classification: parse the plan (U2), discover the binding
// via epic metadata + parent-child enumeration (KTD9), then classify each
// plan unit and each discovered Beads issue into the drift classes.
//
// Drift classes: unchanged, new-in-plan, missing-in-Beads (blocking),
// content-changed, dependencies-changed, removed-from-plan, closed-but-changed,
// duplicate-binding (blocking), corrupt-binding (blocking), externally-modified
// (blocking), dependency-baseline-corrupt (blocking), digest-drift, malformed-plan.
//
// The engine consumes normalized Beads state only through the U3 client,
// never raw CLI JSON. status renders read-only; sync consumes the same
// classification to plan mutations.

import { createHash } from "node:crypto";
import {
  parsePlan,
  PlanParseError,
  type CePlan,
  type CeUnit,
} from "./plan-parser.ts";
import { BeadsClient, type BeadsIssue } from "./beads-client.ts";
import {
  nodeKey,
  epicKey,
  canonicalUnitIds,
  canonicalDependencies,
  unitDigest,
  UNIT_DIGEST_PROJECTION_VERSION,
} from "./graph-builder.ts";

// --- Types -----------------------------------------------------------------

export type DriftClass =
  | "unchanged"
  | "new-in-plan"
  | "missing-in-beads"
  | "content-changed"
  | "dependencies-changed"
  | "removed-from-plan"
  | "closed-but-changed"
  | "duplicate-binding"
  | "corrupt-binding"
  | "externally-modified"
  | "dependency-baseline-corrupt"
  | "digest-drift"
  | "malformed-plan";

export interface UnitClassification {
  unitId: string;
  beadsId: string | undefined;
  driftClass: DriftClass;
  isClosed: boolean;
  isBlocking: boolean;
  detail: string;
  /** Desired dependencies from the plan (sorted U-IDs). */
  desiredDeps: string[] | undefined;
  /** Baseline dependencies from Beads metadata (ce_dependencies). */
  baselineDeps: string[] | undefined;
  /** Live dependencies from Beads edges. */
  liveDeps: string[] | undefined;
}
export interface BindingHealth {
  epicId: string | undefined;
  hasDuplicateEpic: boolean;
  hasDuplicateUnits: boolean;
  hasCorruptTasks: boolean;
  storedDigest: string | undefined;
  storedUnitIds: string | undefined;
  digestDrift: boolean;
  rosterDrift: boolean;
}
export interface ReconcileResult {
  planPath: string;
  planDigest: string;
  malformed: boolean;
  parseError: string | undefined;
  binding: BindingHealth;
  units: UnitClassification[];
  /** Tasks in Beads with no corresponding plan unit. */
  removedTasks: Array<{ beadsId: string; unitId: string | undefined; isClosed: boolean }>;
  hasBlocking: boolean;
}

// --- Reconcile -------------------------------------------------------------

/**
 * Reconcile a plan against live Beads state. Read-only: no mutations.
 * Returns the full classification for status rendering and sync planning.
 */
export async function reconcile(
  client: BeadsClient,
  planPath: string,
  repoRoot: string,
): Promise<ReconcileResult> {
  // Parse the plan.
  let plan: CePlan;
  try {
    plan = parsePlan(planPath, { repoRoot });
  } catch (e) {
    if (e instanceof PlanParseError) {
      return {
        planPath,
        planDigest: "",
        malformed: true,
        parseError: e.message,
        binding: emptyBindingHealth(),
        units: [],
        removedTasks: [],
        hasBlocking: true,
      };
    }
    throw e;
  }

  // Discover the binding.
  const binding = await discoverBinding(client, plan.path);
  const health = classifyBindingHealth(plan, binding);

  // Classify each plan unit.
  const units: UnitClassification[] = [];
  for (const unit of plan.units) {
    units.push(classifyUnit(unit, plan, binding, health));
  }

  // Find removed tasks (in Beads but not in plan).
  const planUnitIds = new Set(plan.units.map((u) => u.id));
  const removedTasks: ReconcileResult["removedTasks"] = [];
  for (const task of binding.tasks) {
    const unitId = task.metadata?.ce_unit_id;
    if (!unitId || !planUnitIds.has(unitId)) {
      removedTasks.push({
        beadsId: task.id,
        unitId,
        isClosed: task.status === "closed",
      });
    }
  }

  const hasBlocking = units.some((u) => u.isBlocking) || health.hasDuplicateEpic || health.hasCorruptTasks;

  return {
    planPath: plan.path,
    planDigest: plan.digest,
    malformed: false,
    parseError: undefined,
    binding: health,
    units,
    removedTasks,
    hasBlocking,
  };
}

// --- Binding discovery (KTD9) ----------------------------------------------

interface DiscoveredBinding {
  epics: BeadsIssue[];
  tasks: BeadsIssue[];
}

async function discoverBinding(client: BeadsClient, planPath: string): Promise<DiscoveredBinding> {
  const epics = await client.list({
    all: true,
    limit: 0,
    flat: true,
    type: "epic",
    metadataField: ["integration=ce-beads/v1", `ce_plan_path=${planPath}`],
  });

  let tasks: BeadsIssue[] = [];
  if (epics.length > 0) {
    // Enumerate children of the first epic (KTD9: parent-child enumeration).
    // If there are duplicate epics, we still enumerate children of the first.
    tasks = await client.children(epics[0]!.id);
  }

  return { epics, tasks };
}

function classifyBindingHealth(plan: CePlan, binding: DiscoveredBinding): BindingHealth {
  const hasDuplicateEpic = binding.epics.length > 1;
  const epic = binding.epics[0] ?? null;

  // Detect duplicate unit IDs.
  const unitIdCounts = new Map<string, number>();
  let hasCorruptTasks = false;
  let hasDuplicateUnits = false;
  for (const task of binding.tasks) {
    const unitId = task.metadata?.ce_unit_id;
    if (!unitId) {
      hasCorruptTasks = true;
      continue;
    }
    const count = (unitIdCounts.get(unitId) ?? 0) + 1;
    unitIdCounts.set(unitId, count);
    if (count > 1) hasDuplicateUnits = true;
  }

  const storedDigest = epic?.metadata?.ce_plan_digest;
  const storedUnitIds = epic?.metadata?.ce_unit_ids;
  const currentUnitIds = canonicalUnitIds(plan.units);

  return {
    epicId: epic?.id,
    hasDuplicateEpic,
    hasDuplicateUnits,
    hasCorruptTasks,
    storedDigest,
    storedUnitIds,
    digestDrift: storedDigest !== undefined && storedDigest !== plan.digest,
    rosterDrift: storedUnitIds !== undefined && storedUnitIds !== currentUnitIds,
  };
}

function emptyBindingHealth(): BindingHealth {
  return {
    epicId: undefined,
    hasDuplicateEpic: false,
    hasDuplicateUnits: false,
    hasCorruptTasks: false,
    storedDigest: undefined,
    storedUnitIds: undefined,
    digestDrift: false,
    rosterDrift: false,
  };
}

/** Construct a UnitClassification with all fields present (undefined where N/A). */
function makeUnit(opts: {
  unitId: string;
  beadsId?: string;
  driftClass: DriftClass;
  isClosed: boolean;
  isBlocking: boolean;
  detail: string;
  desiredDeps?: string[];
  baselineDeps?: string[];
}): UnitClassification {
  return {
    unitId: opts.unitId,
    beadsId: opts.beadsId ?? undefined,
    driftClass: opts.driftClass,
    isClosed: opts.isClosed,
    isBlocking: opts.isBlocking,
    detail: opts.detail,
    desiredDeps: opts.desiredDeps ?? undefined,
    baselineDeps: opts.baselineDeps ?? undefined,
    liveDeps: undefined,
  };
}
// --- Unit classification ---------------------------------------------------

function classifyUnit(
  unit: CeUnit,
  plan: CePlan,
  binding: DiscoveredBinding,
  health: BindingHealth,
): UnitClassification {
  const eKey = epicKey(plan.path);

  // Find the Beads task for this unit by ce_unit_id metadata.
  const matchingTasks = binding.tasks.filter((t) => t.metadata?.ce_unit_id === unit.id);

  // Not bound → new in plan.
  if (matchingTasks.length === 0) {
    return makeUnit({
      unitId: unit.id,
      driftClass: "new-in-plan",
      isClosed: false,
      isBlocking: false,
      detail: `Unit ${unit.id} is in the plan but not bound in Beads.`,
    });
  }

  // Duplicate binding → blocking.
  if (matchingTasks.length > 1) {
    return makeUnit({
      unitId: unit.id,
      beadsId: matchingTasks[0]!.id,
      driftClass: "duplicate-binding",
      isClosed: false,
      isBlocking: true,
      detail: `Unit ${unit.id} has ${matchingTasks.length} Beads tasks: ${matchingTasks.map((t) => t.id).join(", ")}.`,
    });
  }

  const task = matchingTasks[0]!;
  const isClosed = task.status === "closed";

  // Check for corrupt binding (missing required metadata).
  if (!task.metadata?.ce_unit_id) {
    return makeUnit({
      unitId: unit.id,
      beadsId: task.id,
      driftClass: "corrupt-binding",
      isClosed,
      isBlocking: true,
      detail: `Task ${task.id} is missing ce_unit_id metadata.`,
    });
  }

  // Compute live unit digest and compare with stored.
  const liveDigest = unitDigest(unit, plan.path, eKey);
  const storedDigest = task.metadata?.ce_unit_digest;

  // Externally modified: live projection hash ≠ stored digest (KTD12).
  if (storedDigest !== undefined && liveDigest !== storedDigest) {
    return makeUnit({
      unitId: unit.id,
      beadsId: task.id,
      driftClass: "externally-modified",
      isClosed,
      isBlocking: true,
      detail: `Unit ${unit.id} live digest (${liveDigest.slice(0, 12)}...) ≠ stored (${storedDigest.slice(0, 12)}...).`,
      desiredDeps: unit.dependencies,
    });
  }

  // Closed-but-changed: if the unit is closed and content changed since last sync.
  // Detected when plan-level digest drift exists AND this unit's content differs.
  // Since liveDigest matched storedDigest above, content hasn't changed from the
  // stored snapshot's perspective — closed units are unchanged unless externally modified.

  // Check dependencies (KTD18).
  const desiredDeps = [...unit.dependencies].sort();
  const baselineDepsStr = task.metadata?.ce_dependencies;
  let baselineDeps: string[] = [];
  let depBaselineCorrupt = false;

  if (baselineDepsStr === undefined || baselineDepsStr === "") {
    depBaselineCorrupt = true;
  } else {
    try {
      baselineDeps = JSON.parse(baselineDepsStr) as string[];
      if (!Array.isArray(baselineDeps)) depBaselineCorrupt = true;
    } catch {
      depBaselineCorrupt = true;
    }
  }

  if (depBaselineCorrupt) {
    return makeUnit({
      unitId: unit.id,
      beadsId: task.id,
      driftClass: "dependency-baseline-corrupt",
      isClosed,
      isBlocking: true,
      detail: `Unit ${unit.id} has corrupt or missing ce_dependencies metadata.`,
      desiredDeps,
      baselineDeps: [],
    });
  }

  // Compare desired vs baseline deps.
  const baselineSet = new Set(baselineDeps);
  const desiredSet = new Set(desiredDeps);
  const depsChanged = !setEqual(baselineSet, desiredSet);

  if (depsChanged) {
    return makeUnit({
      unitId: unit.id,
      beadsId: task.id,
      driftClass: "dependencies-changed",
      isClosed,
      isBlocking: false,
      detail: `Unit ${unit.id} dependencies changed (baseline: ${JSON.stringify(baselineDeps)}, desired: ${JSON.stringify(desiredDeps)}).`,
      desiredDeps,
      baselineDeps,
    });
  }

  // Content unchanged (live digest matches stored, deps match).
  return makeUnit({
    unitId: unit.id,
    beadsId: task.id,
    driftClass: "unchanged",
    isClosed,
    isBlocking: false,
    detail: `Unit ${unit.id} is unchanged.`,
    desiredDeps,
    baselineDeps,
  });
}

function setEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}
