// packet.ts — packet action handler.
//
// packet <plan-path> <U-ID> emits a bounded worker packet for a single
// ce-beads unit, ready to drop into a worker's prompt. Read-only — never
// mutates Beads or the plan. The packet is "standalone" (run_id, base_sha,
// branch, worktree_path, result_file all null); the orchestrator's run
// engine is the only producer of "live" packets with those fields set.
//
// Flow (KTD20, R8):
//   1. Parse positional args (planPath, U-ID) + load + parse plan.
//   2. Find the unit by ID; if missing, UNIT_NOT_FOUND → exit 2.
//   3. Resolve beadsId from binding (if any); null otherwise.
//   4. Filter plan.verification_commands to the unit's entries.
//   5. Build the packet (standalone: run-context fields null).
//   6. Return the packet_built envelope.

import { join } from "node:path";
import {
  parsePlan,
  PlanParseError,
  type CePlan,
  type CeUnit,
  type VerificationEntry,
} from "../ce-beads/scripts/plan-parser.ts";
import {
  BeadsClient,
  loadBinding,
} from "../ce-beads/scripts/beads-client.ts";
import {
  buildWorkerPacket,
  PACKET_SCHEMA_VERSION,
  type PacketUnit,
  type WorkerPacket,
} from "./worker-packet.ts";
import type { CliArgs, ActionHandler } from "../ce-beads/scripts/cli.ts";
import {
  envelope,
  type ProtocolEnvelope,
  type Diagnostic,
} from "../ce-beads/scripts/protocol.ts";

// --- Types -----------------------------------------------------------------

/**
 * Payload of a successful `packet` action: the resolved binding identity
 * (when present) plus the bounded worker packet itself.
 */
export interface PacketData {
  planPath: string;
  planDigest: string;
  unitId: string;
  /** Beads task ID for this unit, resolved from binding when present. */
  beadsId: string | null;
  packet: WorkerPacket;
}

// --- Handler ---------------------------------------------------------------

export const handler: ActionHandler = {
  async run(args: CliArgs): Promise<ProtocolEnvelope> {
    return packetAction(args);
  },
};

/**
 * Narrow an `unknown` extension on `CliArgs` (positional/options bag added
 * by cli.ts's richer parser; absent in the current minimal shape, present
 * after step 13). Read with a runtime check, not an unchecked cast.
 */
function readExtension(args: CliArgs): { positional: string[]; options: Record<string, unknown> } {
  const a = args as unknown;
  const positional = (a as { positional?: unknown }).positional;
  const options = (a as { options?: unknown }).options;
  return {
    positional: Array.isArray(positional) ? positional.filter((x): x is string => typeof x === "string") : [],
    options:
      options !== null && typeof options === "object"
        ? (options as Record<string, unknown>)
        : {},
  };
}

/**
 * Map a plan-parse rejection to the packet envelope. Mirrors bind.ts's
 * helper pattern: PLAN_UNSUPPORTED is `blocking`; everything else collapses
 * to PLAN_MALFORMED at `error`. The packet action has no concept of
 * `binding_drift`, so the data carries the plan path + an empty packet.
 */
function parseErrorEnvelope(e: PlanParseError, planPath: string): ProtocolEnvelope<PacketData> {
  const code: Diagnostic["code"] =
    e.code === "PLAN_UNSUPPORTED" || e.code === "PLAN_MALFORMED" ? e.code : "PLAN_MALFORMED";
  const severity: Diagnostic["severity"] = code === "PLAN_UNSUPPORTED" ? "blocking" : "error";
  return envelope(
    "packet",
    false,
    "unit_not_found",
    { planPath, planDigest: "", unitId: "", beadsId: null, packet: emptyPacket() },
    [{ code, severity, message: e.message }],
  );
}

/**
 * Best-effort placeholder for the success-data field when the request is
 * refused before any plan is parsed. The shape must satisfy `PacketData` so
 * the envelope type-checks regardless of which branch we returned from.
 */
function emptyPacket(): WorkerPacket {
  const unit: PacketUnit = {
    id: "",
    title: "",
    goal: "",
    requirements: [],
    dependencies: [],
    files: [],
    approach: "",
    patterns: [],
    test_scenarios: [],
    requirement_defs: [],
    ktd_excerpts: [],
    verification: [],
  };
  return {
    schema_version: PACKET_SCHEMA_VERSION,
    run_id: null,
    plan_path: "",
    plan_digest: "",
    unit,
    verification_commands: [],
    beads_id: null,
    base_sha: null,
    branch: null,
    worktree_path: null,
    result_file: null,
  };
}

async function packetAction(args: CliArgs): Promise<ProtocolEnvelope> {
  // 1. Parse positional args: [1] = plan path, [2] = U-ID. The cli.ts parser
  //    places them in `positional` and `--unit` lands in `options.unit`.
  const { positional, options } = readExtension(args);
  const planPath = positional[1] ?? args.planPath;
  const unitId =
    (typeof options.unit === "string" ? options.unit : undefined) ??
    positional[2];

  if (!planPath) {
    return envelope(
      "packet",
      false,
      "unit_not_found",
      { planPath: "", planDigest: "", unitId: "", beadsId: null, packet: emptyPacket() } as PacketData,
      [{ code: "UNIT_NOT_FOUND", severity: "blocking", message: "Missing plan path argument." }],
    );
  }
  if (!unitId) {
    return envelope(
      "packet",
      false,
      "unit_not_found",
      { planPath, planDigest: "", unitId: "", beadsId: null, packet: emptyPacket() } as PacketData,
      [{ code: "UNIT_NOT_FOUND", severity: "blocking", message: "Missing unit ID argument (--unit <U-ID>)." }],
    );
  }

  const repoRoot = process.cwd();

  // 2. Load + parse the plan.
  let plan: CePlan;
  try {
    plan = parsePlan(planPath, { repoRoot });
  } catch (e) {
    if (e instanceof PlanParseError) {
      return parseErrorEnvelope(e, planPath);
    }
    throw e;
  }

  // 3. Find the unit by ID.
  const unit = plan.units.find((u: CeUnit) => u.id === unitId);
  if (!unit) {
    return envelope(
      "packet",
      false,
      "unit_not_found",
      { planPath: plan.path, planDigest: plan.digest, unitId, beadsId: null, packet: emptyPacket() } as PacketData,
      [
        {
          code: "UNIT_NOT_FOUND",
          severity: "blocking",
          message: `Unit ${unitId} not found in plan ${plan.path} (units: ${plan.units.map((u) => u.id).join(", ")}).`,
        },
      ],
    );
  }

  // 4. Resolve beadsId from binding (if any). Binding lookup is read-only.
  //    Beads failures (BD_MISSING, BD_FAILURE) surface as a warning and the
  //    packet still builds with beadsId=null — a planning repo without an
  //    initialized Beads workspace must not block packet emission.
  let beadsId: string | null = null;
  let bdWarning: Diagnostic | null = null;
  const beadsDir = process.env.BEADS_DIR ?? join(repoRoot, ".beads");
  try {
    const client = new BeadsClient({ beadsDir });
    const binding = await loadBinding(client, plan.path);
    if (binding) {
      beadsId = binding.beadsIdByUnitId[unitId] ?? null;
    }
  } catch (e) {
    if ((e as { name?: string }).name === "BdError") {
      bdWarning = {
        code: "BD_FAILURE",
        severity: "warning",
        message: `Beads lookup failed; emitting packet with beadsId=null: ${(e as Error).message}`,
      };
    } else {
      throw e;
    }
  }

  // 5. Filter verification commands to this unit. The contract is fanned
  //    out per U-ID at parse time (R8), so this is a straight filter.
  const verificationCommands: VerificationEntry[] = plan.verification_commands.filter(
    (v) => v.unit_id === unitId,
  );

  // 6. Build the packet (standalone: run-context fields null).
  const packet = buildWorkerPacket(plan, unit, verificationCommands, { beadsId });

  return envelope(
    "packet",
    true,
    "packet_built",
    { planPath: plan.path, planDigest: plan.digest, unitId, beadsId, packet } as PacketData,
    bdWarning ? [bdWarning] : [],
  );
}
