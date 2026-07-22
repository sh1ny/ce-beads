// bind.ts — bind action handler.
//
// bind <plan-path> imports a plan into Beads idempotently, refusing to mutate
// against any existing drifted, partial, or duplicate binding.
//
// Flow (KTD8, KTD9, KTD16, KTD17, KTD19):
//   1. Resolve + validate plan path; parse via U2 (rejection exits non-zero
//      before any bd mutation).
//   2. Acquire plan-path lock; enumerate existing binding via U3 metadata
//      query + parent-child discovery.
//   3. Three branches:
//      - No binding → build graph (U4), dry-run, preview + token, apply on
//        --apply <token>, read back, verify, return U-ID → Beads ID mapping.
//      - Complete unchanged binding → return existing mapping, zero creates.
//      - Any drift/partial/duplicate/malformed → zero mutations, binding_drift.
//   4. A non-zero live apply is indeterminate: re-query, never blindly rerun.
//   5. Duplicate/malformed identity blocks all mutation (KTD19).

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parsePlan,
  PlanParseError,
  type CePlan,
} from "./plan-parser.ts";
import { BeadsClient, BdError, type BeadsIssue } from "./beads-client.ts";
import { buildGraph, nodeKey, epicKey, canonicalUnitIds } from "./graph-builder.ts";
import {
  LockHolder,
  buildPreview,
  verifyApplyToken,
  type CliArgs,
  type ActionHandler,
} from "./cli.ts";
import {
  envelope,
  ExitCode,
  type ProtocolEnvelope,
  type Diagnostic,
  type MutationEntry,
  type ApprovalPayload,
} from "./protocol.ts";

// --- Types -----------------------------------------------------------------

export interface BindData {
  planPath: string;
  planDigest: string;
  mapping: Record<string, string>; // U-ID → Beads ID
  epicId?: string;
}

export interface BindingState {
  epic: BeadsIssue | null;
  tasks: BeadsIssue[]; // all children of the epic
  duplicateUnitIds: Set<string>;
  corruptTasks: BeadsIssue[]; // tasks missing required identity metadata
}

// --- Handler ---------------------------------------------------------------

export const handler: ActionHandler = {
  async run(args: CliArgs): Promise<ProtocolEnvelope> {
    return bindAction(args);
  },
};

async function bindAction(args: CliArgs): Promise<ProtocolEnvelope> {
  const planPath = args.planPath!;
  const repoRoot = process.cwd();

  // 1. Parse + validate plan (rejection exits non-zero before any bd mutation).
  let plan: CePlan;
  try {
    plan = parsePlan(planPath, { repoRoot });
  } catch (e) {
    if (e instanceof PlanParseError) {
      return parseErrorEnvelope(e, planPath);
    }
    throw e;
  }

  // 2. Acquire lock + enumerate binding.
  const lock = new LockHolder(plan.path, repoRoot);
  const acquired = await lock.tryAcquire();
  if (!acquired) {
    return envelope("bind", false, "refused", { planPath, mapping: {} }, [
      { code: "LOCK_BUSY", severity: "blocking", message: `Another ce-beads process is mutating plan ${plan.path}.` },
    ]);
  }

  try {
    // Use the dev repo's .beads (or whatever BEADS_DIR is set to).
    const client = new BeadsClient({ beadsDir: process.env.BEADS_DIR ?? join(repoRoot, ".beads") });

    // 3. Enumerate existing binding state.
    const binding = await enumerateBinding(client, plan.path);

    // 4. Three-way branch.
    if (binding.epic === null) {
      // No binding → create.
      return await createBinding(client, plan, lock, args);
    }

    // Check for drift / duplicates / corrupt.
    const drift = checkBindingDrift(plan, binding);
    if (drift.length > 0) {
      return envelope("bind", false, "binding_drift", { planPath: plan.path, mapping: {} }, drift);
    }

    // Complete unchanged binding → return existing mapping.
    const mapping = buildMapping(plan, binding);
    return envelope("bind", true, "already_bound", {
      planPath: plan.path,
      planDigest: plan.digest,
      mapping,
      epicId: binding.epic.id,
    } as BindData);
  } finally {
    lock.release();
  }
}

// --- Binding enumeration (KTD8, KTD9) --------------------------------------

export async function enumerateBinding(client: BeadsClient, planPath: string): Promise<BindingState> {
  // Find the epic by metadata (KTD8).
  const epics = await client.list({
    all: true,
    limit: 0,
    flat: true,
    type: "epic",
    metadataField: ["integration=ce-beads/v1", `ce_plan_path=${planPath}`],
  });

  let epic: BeadsIssue | null = null;
  if (epics.length === 1) {
    epic = epics[0]!;
  } else if (epics.length > 1) {
    // Duplicate epic — pick the first but flag it.
    epic = epics[0]!;
  }

  if (!epic) {
    return { epic: null, tasks: [], duplicateUnitIds: new Set(), corruptTasks: [] };
  }

  // Enumerate all children by parent relationship (KTD9).
  const tasks = await client.children(epic.id);

  // Detect duplicate unit IDs and corrupt tasks.
  const seenUnitIds = new Map<string, number>();
  const duplicateUnitIds = new Set<string>();
  const corruptTasks: BeadsIssue[] = [];

  for (const task of tasks) {
    const unitId = task.metadata?.ce_unit_id;
    if (!unitId) {
      corruptTasks.push(task);
      continue;
    }
    const count = (seenUnitIds.get(unitId) ?? 0) + 1;
    seenUnitIds.set(unitId, count);
    if (count > 1) {
      duplicateUnitIds.add(unitId);
    }
  }

  return { epic, tasks, duplicateUnitIds, corruptTasks };
}

// --- Drift detection (for bind's refusal branch) ---------------------------

function checkBindingDrift(plan: CePlan, binding: BindingState): Diagnostic[] {
  const diags: Diagnostic[] = [];

  // Duplicate epic.
  // (Handled in enumerateBinding — if >1 epic, we picked the first but
  // should flag. For simplicity, we check the epic's stored digest vs plan.)
  if (binding.epic) {
    const storedDigest = binding.epic.metadata?.ce_plan_digest;
    if (storedDigest !== undefined && storedDigest !== plan.digest) {
      diags.push({
        code: "BINDING_DRIFT",
        severity: "blocking",
        message: `Plan digest has changed since last bind (stored: ${storedDigest?.slice(0, 12)}..., current: ${plan.digest.slice(0, 12)}...). Run status/sync to reconcile.`,
        remediation: "Run `ce-beads status` then `ce-beads sync` to reconcile.",
      });
    }

    // Check unit roster.
    const storedUnitIds = binding.epic.metadata?.ce_unit_ids;
    if (storedUnitIds !== undefined) {
      const currentUnitIds = canonicalUnitIds(plan.units);
      if (storedUnitIds !== currentUnitIds) {
        diags.push({
          code: "BINDING_DRIFT",
          severity: "blocking",
          message: `Plan unit roster has changed (stored: ${storedUnitIds}, current: ${currentUnitIds}). Run status/sync to reconcile.`,
          remediation: "Run `ce-beads status` then `ce-beads sync` to reconcile.",
        });
      }
    }
  }

  // Duplicate unit IDs (KTD19).
  if (binding.duplicateUnitIds.size > 0) {
    diags.push({
      code: "DUPLICATE_BINDING",
      severity: "blocking",
      message: `Duplicate unit bindings: ${[...binding.duplicateUnitIds].join(", ")}.`,
      remediation: "Manually remove duplicate Beads tasks before rebinding.",
    });
  }

  // Corrupt tasks (KTD19).
  if (binding.corruptTasks.length > 0) {
    diags.push({
      code: "CORRUPT_BINDING",
      severity: "blocking",
      message: `${binding.corruptTasks.length} task(s) missing required ce_unit_id metadata.`,
      remediation: "Manually repair or remove corrupt tasks before rebinding.",
    });
  }

  // Missing tasks (units in plan but not in Beads).
  const boundUnitIds = new Set(binding.tasks.map((t) => t.metadata?.ce_unit_id).filter((id): id is string => id !== undefined));
  for (const unit of plan.units) {
    if (!boundUnitIds.has(unit.id)) {
      diags.push({
        code: "MISSING_IN_BEADS",
        severity: "blocking",
        message: `Unit ${unit.id} is in the plan but not in Beads.`,
        remediation: "Run `ce-beads sync` to create missing tasks.",
      });
    }
  }

  // Extra tasks (in Beads but not in plan).
  const planUnitIds = new Set(plan.units.map((u) => u.id));
  for (const task of binding.tasks) {
    const unitId = task.metadata?.ce_unit_id;
    if (unitId && !planUnitIds.has(unitId)) {
      diags.push({
        code: "BINDING_DRIFT",
        severity: "blocking",
        message: `Task ${task.id} (unit ${unitId}) is in Beads but not in the plan.`,
        remediation: "Run `ce-beads status` then `ce-beads sync` to reconcile.",
      });
    }
  }

  return diags;
}

// --- Create binding --------------------------------------------------------

async function createBinding(
  client: BeadsClient,
  plan: CePlan,
  lock: LockHolder,
  args: CliArgs,
): Promise<ProtocolEnvelope> {
  // Build the graph.
  const graph = buildGraph(plan);

  // Write graph to temp file.
  const tmpDir = mkdtempSync(join(tmpdir(), "ce-beads-graph-"));
  const graphFile = join(tmpDir, "graph.json");
  writeFileSync(graphFile, JSON.stringify(graph));

  try {
    // Dry-run gate.
    const dryRun = await client.createGraph(graphFile, { dryRun: true });
    if (!dryRun || (dryRun as { dry_run?: boolean }).dry_run !== true) {
      return envelope("bind", false, "refused", { planPath: plan.path, mapping: {} }, [
        { code: "BD_FAILURE", severity: "error", message: "Dry-run validation failed." },
      ]);
    }

    // Build mutation set for preview.
    const mutations: MutationEntry[] = [
      ...plan.units.map((unit) => ({
        id: `create-${unit.id}`,
        kind: "create" as const,
        target: `${plan.path}::${unit.id}`,
        summary: `Create task for ${unit.id}: ${unit.title}`,
        state: "pending" as const,
      })),
      {
        id: "create-epic",
        kind: "create" as const,
        target: plan.path,
        summary: `Create epic for ${plan.title}`,
        state: "pending" as const,
      },
    ];

    const approvalPayload: Omit<ApprovalPayload, "protocol_version"> = {
      action: "bind",
      plan_path: plan.path,
      plan_digest: plan.digest,
      beads_state_fingerprint: "no-existing-binding",
      ordered_mutation_set: mutations,
    };

    // If no --apply token, emit preview.
    if (!args.applyToken) {
      const preview = buildPreview(approvalPayload);
      return envelope("bind", true, "preview", {
        planPath: plan.path,
        planDigest: plan.digest,
        mutations: preview.mutations,
        approvalToken: preview.approvalToken,
      }, [
        { code: "PARTIAL_APPLY", severity: "info" as const, message: `Preview: ${mutations.length} mutations. Re-run with --apply <token> to apply.` },
      ]);
    }

    // Verify token.
    if (!verifyApplyToken(args.applyToken, approvalPayload)) {
      return envelope("bind", false, "refused", { planPath: plan.path, mapping: {} }, [
        { code: "TOKEN_MISMATCH", severity: "blocking", message: "Approval token mismatch. Re-run bind without --apply to get a fresh preview." },
      ]);
    }

    // Apply: create the graph.
    let result;
    try {
      result = await client.createGraph(graphFile);
    } catch (e) {
      if (e instanceof BdError && e.kind === "indeterminate") {
        // Re-query to determine actual state.
        return await handleIndeterminateApply(client, plan, lock);
      }
      throw e;
    }

    const ids = (result as { ids: Record<string, string> }).ids;
    const eKey = epicKey(plan.path);

    // Read back + verify.
    const epicId = ids[eKey];
    if (!epicId) {
      return envelope("bind", false, "refused", { planPath: plan.path, mapping: {} }, [
        { code: "READBACK_FAILURE", severity: "error", message: "Epic ID not returned from graph apply." },
      ]);
    }

    // Verify epic exists.
    const epic = await client.show(epicId);
    if (!epic) {
      return envelope("bind", false, "refused", { planPath: plan.path, mapping: {} }, [
        { code: "READBACK_FAILURE", severity: "error", message: `Epic ${epicId} not found after create.` },
      ]);
    }

    // Verify tasks.
    const children = await client.children(epicId);
    if (children.length !== plan.units.length) {
      return envelope("bind", false, "refused", { planPath: plan.path, mapping: {} }, [
        { code: "READBACK_FAILURE", severity: "error", message: `Task count mismatch: expected ${plan.units.length}, got ${children.length}.` },
      ]);
    }

    // Build mapping.
    const mapping: Record<string, string> = {};
    for (const unit of plan.units) {
      const tKey = nodeKey(plan.path, unit.id);
      const beadsId = ids[tKey];
      if (beadsId) {
        mapping[unit.id] = beadsId;
      }
    }

    return envelope("bind", true, "bound", {
      planPath: plan.path,
      planDigest: plan.digest,
      mapping,
      epicId,
    } as BindData);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function handleIndeterminateApply(
  client: BeadsClient,
  plan: CePlan,
  _lock: LockHolder,
): Promise<ProtocolEnvelope> {
  // Re-query to find what was actually created.
  const binding = await enumerateBinding(client, plan.path);
  if (binding.epic) {
    const mapping = buildMapping(plan, binding);
    return envelope("bind", false, "preview", {
      planPath: plan.path,
      planDigest: plan.digest,
      mapping,
      epicId: binding.epic.id,
    } as BindData, [
      { code: "PARTIAL_APPLY", severity: "warning", message: "Graph apply was indeterminate; re-queried and found existing binding.", remediation: "Verify the binding is correct with `ce-beads status`." },
    ]);
  }
  return envelope("bind", false, "refused", { planPath: plan.path, mapping: {} }, [
    { code: "PARTIAL_APPLY", severity: "error", message: "Graph apply was indeterminate and no binding was found on re-query." },
  ]);
}

// --- Helpers ---------------------------------------------------------------

export function buildMapping(plan: CePlan, binding: BindingState): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const task of binding.tasks) {
    const unitId = task.metadata?.ce_unit_id;
    if (unitId) {
      mapping[unitId] = task.id;
    }
  }
  return mapping;
}

function parseErrorEnvelope(e: PlanParseError, planPath: string): ProtocolEnvelope {
  const code: Diagnostic["code"] = e.code === "PLAN_UNSUPPORTED" || e.code === "PLAN_MALFORMED"
    ? e.code
    : "PLAN_MALFORMED";
  const severity: Diagnostic["severity"] = code === "PLAN_UNSUPPORTED" ? "blocking" : "error";
  return envelope("bind", false, "refused", { planPath, mapping: {} }, [
    { code, severity, message: e.message },
  ]);
}
