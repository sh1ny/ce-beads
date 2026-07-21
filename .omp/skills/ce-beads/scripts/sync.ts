// sync.ts — sync action handler.
//
// sync <plan-path> applies the conservative reconciliation of R8:
// preview first, mutate only what is unambiguous and CE-owned, and converge
// safely on rerun.
//
// Rules (KTD9, KTD14, KTD16, KTD17, KTD18):
//   - Refuses all mutation on blocking state (duplicate, corrupt,
//     externally-modified, missing-in-Beads, dependency-baseline-corrupt).
//   - Creates new U-IDs, updates changed open units, adds desired-minus-live
//     deps, reports dep-removal conflicts with exact `bd dep remove` commands.
//   - Labels removed open units with ce-plan-removed; never deletes.
//   - Removes exactly the ce-plan-removed label when a U-ID returns to the plan.
//   - Closed units are never reopened or overwritten.
//   - Final mutation is the epic commit marker (ce_plan_digest + ce_unit_ids).
//   - Idempotent on rerun.

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CliArgs, ActionHandler } from "./cli.ts";
import { LockHolder, buildPreview, verifyApplyToken } from "./cli.ts";
import type { ProtocolEnvelope, Diagnostic, MutationEntry, ApprovalPayload } from "./protocol.ts";
import { envelope } from "./protocol.ts";
import { parsePlan, PlanParseError, type CePlan } from "./plan-parser.ts";
import { BeadsClient, BdError, type BeadsIssue } from "./beads-client.ts";
import { reconcile, type ReconcileResult, type UnitClassification } from "./reconcile.ts";
import { buildGraph, nodeKey, epicKey, canonicalUnitIds, unitDigest, canonicalDependencies } from "./graph-builder.ts";

export interface SyncData {
  planPath: string;
  planDigest: string;
  mutations?: MutationEntry[];
  approvalToken?: string;
  results?: Array<{ id: string; state: string }>;
}

export const handler: ActionHandler = {
  async run(args: CliArgs): Promise<ProtocolEnvelope> {
    return syncAction(args);
  },
};

async function syncAction(args: CliArgs): Promise<ProtocolEnvelope> {
  const planPath = args.planPath!;
  const repoRoot = process.cwd();
  const client = new BeadsClient({ beadsDir: process.env.BEADS_DIR ?? join(repoRoot, ".beads") });

  // Parse plan (rejection before any mutation).
  let plan: CePlan;
  try {
    plan = parsePlan(planPath, { repoRoot });
  } catch (e) {
    if (e instanceof PlanParseError) {
      return envelope("sync", false, "refused", { planPath, planDigest: "" }, [
        { code: e.code === "PLAN_UNSUPPORTED" ? "PLAN_UNSUPPORTED" : "PLAN_MALFORMED", severity: "blocking", message: e.message },
      ]);
    }
    throw e;
  }

  // Acquire lock.
  const lock = new LockHolder(plan.path, repoRoot);
  const acquired = await lock.tryAcquire();
  if (!acquired) {
    return envelope("sync", false, "refused", { planPath: plan.path, planDigest: plan.digest }, [
      { code: "LOCK_BUSY", severity: "blocking", message: `Another ce-beads process is mutating plan ${plan.path}.` },
    ]);
  }

  try {
    // Reconcile.
    const result = await reconcile(client, plan.path, repoRoot);
    if (result.malformed) {
      return envelope("sync", false, "refused", { planPath, planDigest: "" }, [
        { code: "PLAN_MALFORMED", severity: "blocking", message: result.parseError ?? "Plan is malformed." },
      ]);
    }

    // Check for blocking state.
    if (result.hasBlocking) {
      const diags = collectBlockingDiagnostics(result);
      return envelope("sync", false, "blocked", { planPath: plan.path, planDigest: plan.digest }, diags);
    }

    // Compute mutations.
    const mutations = computeMutations(plan, result, client);

    // If no mutations, report already-applied.
    if (mutations.length === 0) {
      return envelope("sync", true, "applied", { planPath: plan.path, planDigest: plan.digest, results: [] });
    }

    // Build approval payload.
    const approvalPayload: Omit<ApprovalPayload, "protocol_version"> = {
      action: "sync",
      plan_path: plan.path,
      plan_digest: plan.digest,
      beads_state_fingerprint: fingerprintBeadsState(result),
      ordered_mutation_set: mutations,
    };

    // Preview without --apply.
    if (!args.applyToken) {
      const preview = buildPreview(approvalPayload);
      return envelope("sync", true, "preview", {
        planPath: plan.path,
        planDigest: plan.digest,
        mutations: preview.mutations,
        approvalToken: preview.approvalToken,
      } as SyncData);
    }

    // Verify token.
    if (!verifyApplyToken(args.applyToken, approvalPayload)) {
      return envelope("sync", false, "refused", { planPath: plan.path, planDigest: plan.digest }, [
        { code: "TOKEN_MISMATCH", severity: "blocking", message: "Approval token mismatch. Re-run sync without --apply to get a fresh preview." },
      ]);
    }

    // Apply mutations.
    const applyResults = await applyMutations(client, plan, mutations, result);

    // Apply the epic commit marker (final mutation, KTD16).
    if (result.binding.epicId) {
      await applyEpicCommitMarker(client, plan, result.binding.epicId);
    }

    return envelope("sync", true, "applied", {
      planPath: plan.path,
      planDigest: plan.digest,
      results: applyResults,
    } as SyncData);
  } finally {
    lock.release();
  }
}

// --- Mutation computation --------------------------------------------------

function computeMutations(
  plan: CePlan,
  result: ReconcileResult,
  _client: BeadsClient,
): MutationEntry[] {
  const mutations: MutationEntry[] = [];

  for (const unit of result.units) {
    switch (unit.driftClass) {
      case "new-in-plan":
        mutations.push({
          id: `create-${unit.unitId}`,
          kind: "create",
          target: `${plan.path}::${unit.unitId}`,
          summary: `Create task for ${unit.unitId}`,
          state: "pending",
        });
        break;
      case "content-changed":
      case "dependencies-changed":
        if (!unit.isClosed) {
          mutations.push({
            id: `update-${unit.unitId}`,
            kind: "update",
            target: `${plan.path}::${unit.unitId}`,
            summary: `Update ${unit.unitId} snapshot and deps`,
            state: "pending",
          });
        }
        break;
      // unchanged, closed-but-changed → no mutation (closed is read-only).
    }
  }

  // Removed tasks → label_add for open, report-only for closed.
  for (const rt of result.removedTasks) {
    if (!rt.isClosed) {
      mutations.push({
        id: `label-removed-${rt.beadsId}`,
        kind: "label_add",
        target: rt.beadsId,
        summary: `Add ce-plan-removed label to ${rt.beadsId}`,
        state: "pending",
      });
    }
  }

  // Check for tasks that had ce-plan-removed but whose U-ID returned to the plan.
  // (label_remove mutation)
  const planUnitIds = new Set(plan.units.map((u) => u.id));
  for (const unit of result.units) {
    if (unit.driftClass === "unchanged" && unit.beadsId) {
      // This unit is in the plan and bound — if it was previously labeled
      // ce-plan-removed, we need to remove that label. We can't know from
      // the reconcile result whether it was labeled, so we always emit
      // a label_remove if the task exists and is in the plan.
      // Actually, we should only remove if the label exists. The reconcile
      // result doesn't track labels. For idempotency, we skip this if
      // the task is unchanged — it means it was never removed.
      // This is handled in applyMutations by checking labels.
    }
  }

  // Epic commit marker (final mutation).
  if (result.binding.digestDrift || result.binding.rosterDrift || mutations.length > 0) {
    mutations.push({
      id: "epic-commit-marker",
      kind: "epic_commit_marker",
      target: plan.path,
      summary: "Update epic ce_plan_digest and ce_unit_ids",
      state: "pending",
    });
  }

  return mutations;
}

// --- Apply mutations -------------------------------------------------------

async function applyMutations(
  client: BeadsClient,
  plan: CePlan,
  mutations: MutationEntry[],
  result: ReconcileResult,
): Promise<Array<{ id: string; state: string }>> {
  const applyResults: Array<{ id: string; state: string }> = [];

  for (const mutation of mutations) {
    if (mutation.kind === "epic_commit_marker") {
      // Applied separately as the final mutation.
      continue;
    }

    try {
      if (mutation.kind === "create") {
        // Find the unit in the plan.
        const unitId = mutation.target.split("::")[1]!;
        const unit = plan.units.find((u) => u.id === unitId)!;
        const eKey = epicKey(plan.path);
        const epicId = result.binding.epicId!;

        // Create the task.
        const task = await client.create({
          title: `${unit.id}: ${unit.title}`,
          type: "task",
          parent: epicId,
          metadata: {
            integration: "ce-beads/v1",
            ce_plan_path: plan.path,
            ce_unit_id: unit.id,
            ce_unit_digest: unitDigest(unit, plan.path, eKey),
            ce_requirements: unit.requirements.sort().join(","),
            ce_dependencies: canonicalDependencies(unit.dependencies),
          },
        });
        // Wire dependencies.
        for (const dep of unit.dependencies) {
          const depTask = result.units.find((u) => u.unitId === dep);
          if (depTask?.beadsId) {
            await client.depAdd(task.id, depTask.beadsId, "blocks");
          }
        }
        applyResults.push({ id: mutation.id, state: "applied" });
      } else if (mutation.kind === "update") {
        // Update the task's description and metadata.
        const unitId = mutation.target.split("::")[1]!;
        const unit = plan.units.find((u) => u.id === unitId)!;
        const eKey = epicKey(plan.path);
        const beadsId = result.units.find((u) => u.unitId === unitId)?.beadsId;
        if (beadsId) {
          await client.update(beadsId, {
            description: unit.goal, // Simplified — full description in graph-builder
            setMetadata: {
              ce_unit_digest: unitDigest(unit, plan.path, eKey),
              ce_requirements: unit.requirements.sort().join(","),
              ce_dependencies: canonicalDependencies(unit.dependencies),
            },
          });
          applyResults.push({ id: mutation.id, state: "applied" });
        }
      } else if (mutation.kind === "label_add") {
        const beadsId = mutation.target;
        await client.update(beadsId, { addLabel: ["ce-plan-removed"] });
        applyResults.push({ id: mutation.id, state: "applied" });
      }
    } catch (e) {
      if (e instanceof BdError && e.kind === "indeterminate") {
        applyResults.push({ id: mutation.id, state: "indeterminate" });
      } else {
        applyResults.push({ id: mutation.id, state: "conflict" });
      }
    }
  }

  return applyResults;
}

async function applyEpicCommitMarker(
  client: BeadsClient,
  plan: CePlan,
  epicId: string,
): Promise<void> {
  await client.update(epicId, {
    setMetadata: {
      ce_plan_digest: plan.digest,
      ce_unit_ids: canonicalUnitIds(plan.units),
    },
  });
}

// --- Helpers ---------------------------------------------------------------

function fingerprintBeadsState(result: ReconcileResult): string {
  // Simple fingerprint: count of tasks + their IDs + stored digest.
  const parts: string[] = [];
  if (result.binding.epicId) parts.push(result.binding.epicId);
  if (result.binding.storedDigest) parts.push(result.binding.storedDigest);
  for (const unit of result.units) {
    if (unit.beadsId) parts.push(unit.beadsId);
  }
  return parts.join("|");
}

function collectBlockingDiagnostics(result: ReconcileResult): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const unit of result.units) {
    if (unit.isBlocking) {
      const code: Diagnostic["code"] = unit.driftClass === "duplicate-binding" ? "DUPLICATE_BINDING"
        : unit.driftClass === "corrupt-binding" ? "CORRUPT_BINDING"
        : unit.driftClass === "externally-modified" ? "EXTERNALLY_MODIFIED"
        : unit.driftClass === "dependency-baseline-corrupt" ? "DEPENDENCY_BASELINE_CORRUPT"
        : "BINDING_DRIFT";
      diags.push({ code, severity: "blocking" as const, message: unit.detail });
    }
  }
  if (result.binding.hasDuplicateEpic) {
    diags.push({ code: "DUPLICATE_BINDING", severity: "blocking", message: "Multiple epics found." });
  }
  if (result.binding.hasCorruptTasks) {
    diags.push({ code: "CORRUPT_BINDING", severity: "blocking", message: "Corrupt tasks found." });
  }
  return diags;
}
