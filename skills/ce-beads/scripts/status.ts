// status.ts — status action handler.
//
// status <plan-path> reports every drift class between the current plan and
// Beads state, strictly read-only, in human and stable JSON form.
//
// Renders the U6 reconcile classification via the U12 envelope. Never mutates.

import type { CliArgs, ActionHandler } from "./cli.ts";
import type { ProtocolEnvelope, Diagnostic } from "./protocol.ts";
import { envelope } from "./protocol.ts";
import { reconcile, type ReconcileResult, type UnitClassification } from "./reconcile.ts";
import { BeadsClient } from "./beads-client.ts";
import { join } from "node:path";

export interface StatusData {
  planPath: string;
  planDigest: string;
  malformed: boolean;
  parseError: string | undefined;
  binding: {
    epicId: string | undefined;
    hasDuplicateEpic: boolean;
    hasDuplicateUnits: boolean;
    hasCorruptTasks: boolean;
    digestDrift: boolean;
    rosterDrift: boolean;
  };
  units: Array<{
    unitId: string;
    beadsId: string | undefined;
    driftClass: string;
    isClosed: boolean;
    isBlocking: boolean;
    detail: string;
  }>;
  removedTasks: Array<{ beadsId: string; unitId: string | undefined; isClosed: boolean }>;
}

export const handler: ActionHandler = {
  async run(args: CliArgs): Promise<ProtocolEnvelope> {
    const planPath = args.planPath!;
    const repoRoot = process.cwd();
    const client = new BeadsClient({ beadsDir: process.env.BEADS_DIR ?? join(repoRoot, ".beads") });

    const result = await reconcile(client, planPath, repoRoot);
    return renderStatus(result);
  },
};

function renderStatus(result: ReconcileResult): ProtocolEnvelope<StatusData> {
  const diagnostics: Diagnostic[] = [];

  if (result.malformed) {
    diagnostics.push({
      code: "PLAN_MALFORMED",
      severity: "blocking",
      message: result.parseError ?? "Plan is malformed.",
    });
    return envelope("status", false, "blocked", toStatusData(result), diagnostics);
  }

  // Digest drift.
  if (result.binding.digestDrift) {
    diagnostics.push({
      code: "BINDING_DRIFT",
      severity: "warning",
      message: `Plan digest has drifted from the last reconciled revision.`,
    });
  }

  // Collect per-unit drift classes.
  const driftCount = result.units.filter((u) => u.driftClass !== "unchanged").length;
  const blockingCount = result.units.filter((u) => u.isBlocking).length;

  // Add diagnostics for blocking states.
  for (const unit of result.units) {
    if (unit.isBlocking) {
      const code = driftClassToDiagnosticCode(unit.driftClass);
      diagnostics.push({
        code,
        severity: "blocking",
        message: unit.detail,
      });
    }
  }

  // Removed tasks.
  for (const rt of result.removedTasks) {
    if (!rt.isClosed) {
      diagnostics.push({
        code: "BINDING_DRIFT",
        severity: "warning",
        message: `Task ${rt.beadsId} (unit ${rt.unitId ?? "unknown"}) is in Beads but not in the plan.`,
      });
    }
  }

  if (result.binding.hasDuplicateEpic) {
    diagnostics.push({
      code: "DUPLICATE_BINDING",
      severity: "blocking",
      message: "Multiple epics found for this plan.",
    });
  }
  if (result.binding.hasCorruptTasks) {
    diagnostics.push({
      code: "CORRUPT_BINDING",
      severity: "blocking",
      message: "One or more tasks are missing required identity metadata.",
    });
  }

  const outcome = blockingCount > 0 ? "blocked" : driftCount > 0 || result.removedTasks.length > 0 || result.binding.digestDrift ? "drift" : "unchanged";

  return envelope("status", outcome === "unchanged", outcome, toStatusData(result), diagnostics);
}

function toStatusData(result: ReconcileResult): StatusData {
  return {
    planPath: result.planPath,
    planDigest: result.planDigest,
    malformed: result.malformed,
    parseError: result.parseError,
    binding: {
      epicId: result.binding.epicId,
      hasDuplicateEpic: result.binding.hasDuplicateEpic,
      hasDuplicateUnits: result.binding.hasDuplicateUnits,
      hasCorruptTasks: result.binding.hasCorruptTasks,
      digestDrift: result.binding.digestDrift,
      rosterDrift: result.binding.rosterDrift,
    },
    units: result.units.map((u) => ({
      unitId: u.unitId,
      beadsId: u.beadsId,
      driftClass: u.driftClass,
      isClosed: u.isClosed,
      isBlocking: u.isBlocking,
      detail: u.detail,
    })),
    removedTasks: result.removedTasks,
  };
}

function driftClassToDiagnosticCode(driftClass: string): Diagnostic["code"] {
  switch (driftClass) {
    case "duplicate-binding": return "DUPLICATE_BINDING";
    case "corrupt-binding": return "CORRUPT_BINDING";
    case "externally-modified": return "EXTERNALLY_MODIFIED";
    case "missing-in-beads": return "MISSING_IN_BEADS";
    case "dependency-baseline-corrupt": return "DEPENDENCY_BASELINE_CORRUPT";
    default: return "BINDING_DRIFT";
  }
}
