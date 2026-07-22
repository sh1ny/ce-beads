// worker-packet.ts — bounded worker packet: everything a ce-beads-unit worker
// needs to implement exactly one unit, and nothing about coordination.

import type {
  CePlan,
  CeUnit,
  VerificationEntry,
} from "../../ce-beads/scripts/plan-parser.ts";

export const PACKET_SCHEMA_VERSION = "ce-beads-packet/1" as const;

/** The bounded unit payload embedded in a worker prompt. */
export interface WorkerPacket {
  schema_version: typeof PACKET_SCHEMA_VERSION;
  /** Run this packet belongs to; null when produced standalone via `packet`. */
  run_id: string | null;
  plan_path: string;
  plan_digest: string;
  /** The single bounded unit, verbatim from the plan IR. */
  unit: PacketUnit;
  /**
   * Verification Contract entries for this unit, parsed from the plan-level
   * table (R8). Empty if the plan has no Verification Contract for this unit.
   * The worker SHOULD run these; the coordinator WILL run them pre-merge.
   */
  verification_commands: VerificationEntry[];
  /** Beads task ID for the unit, informational only; null when unbound. */
  beads_id: string | null;
  /**
   * Base SHA the worker branch forks from = integration worktree HEAD at
   * dispatch time (P0-1). null when standalone.
   */
  base_sha: string | null;
  /** Worker branch name; null when standalone. */
  branch: string | null;
  /** Absolute worktree path; null when standalone. */
  worktree_path: string | null;
  /** Absolute path the worker must atomically write its report to (R3). */
  result_file: string | null;
}

/** CeUnit subset, re-keyed to the packet's wire shape (no renaming of content). */
export interface PacketUnit {
  id: string;
  title: string;
  goal: string;
  requirements: string[];
  dependencies: string[];
  files: string[];
  approach: string;
  execution_note: string | undefined;
  technical_design: string | undefined;
  patterns: string[];
  test_scenarios: string[];
  /** Requirement definitions referenced by this unit (not just IDs). */
  requirement_defs: { id: string; text: string }[];
  /** Key technical decisions (KTDs) relevant to this unit, excerpted. */
  ktd_excerpts: { id: string; text: string }[];
  /** Acceptance prose — NEVER executed as shell (R8). */
  verification: string[];
}

/** Slug for branch naming (R1). */
export function planSlug(planPath: string): string {
  // R1: plan file basename without extension, lowercased, every run of
  // non-[a-z0-9] collapsed to a single '-'. Examples:
  //   "plans/02-Linear-Three-Unit.md" -> "02-linear-three-unit"
  //   "/abs/path/MyPlan.MD"          -> "myplan"
  const base = planPath
    .split(/[\\/]/)
    .pop() ?? "";
  const noExt = base.replace(/\.[^.]+$/, "");
  return noExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build a packet from a parsed plan + unit. Run fields null when standalone.
 *
 * `opts.requirementDefs` and `opts.ktdExcerpts` exist so that callers may
 * inject extras when plan-parser does not yet expose them on the IR; in
 * practice the parser produces both today, so they default to the unit's
 * already-extracted `ktd_excerpts` and the subset of plan-level
 * `requirement_defs` whose IDs are referenced by this unit.
 */
export function buildWorkerPacket(
  plan: CePlan,
  unit: CeUnit,
  verificationCommands: VerificationEntry[],
  opts: {
    runId?: string;
    beadsId?: string;
    baseSha?: string;
    branch?: string;
    worktreePath?: string;
    resultFile?: string;
    /** Requirement definitions to inject when plan-parser does not yet extract them. */
    requirementDefs?: { id: string; text: string }[];
    /** KTD excerpts to inject when plan-parser does not yet extract them. */
    ktdExcerpts?: { id: string; text: string }[];
  } = {},
): WorkerPacket {
  // Default requirement_defs: subset of plan-level R-IDs referenced by this unit.
  const requirementDefs =
    opts.requirementDefs ??
    plan.requirement_defs.filter((r) => unit.requirements.includes(r.id));

  // Default ktd_excerpts: whatever the parser already selected for this unit.
  const ktdExcerpts = opts.ktdExcerpts ?? unit.ktd_excerpts;

  // CeUnit uses camelCase; PacketUnit re-keys to snake_case (no content rename).
  const packetUnit: PacketUnit = {
    id: unit.id,
    title: unit.title,
    goal: unit.goal,
    requirements: unit.requirements,
    dependencies: unit.dependencies,
    files: unit.files,
    approach: unit.approach,
    execution_note: unit.executionNote,
    technical_design: unit.technicalDesign,
    patterns: unit.patterns,
    test_scenarios: unit.testScenarios,
    requirement_defs: requirementDefs,
    ktd_excerpts: ktdExcerpts,
    verification: unit.verification,
  };

  // result_file: explicit override takes precedence, otherwise derive from worktreePath (R3).
  const result_file =
    opts.resultFile ??
    (opts.worktreePath != null
      ? `${opts.worktreePath.replace(/[\\/]+$/, "")}/.ce-beads-worker/result.json`
      : null);

  return {
    schema_version: PACKET_SCHEMA_VERSION,
    run_id: opts.runId ?? null,
    plan_path: plan.path,
    plan_digest: plan.digest,
    unit: packetUnit,
    verification_commands: verificationCommands,
    beads_id: opts.beadsId ?? null,
    base_sha: opts.baseSha ?? null,
    branch: opts.branch ?? null,
    worktree_path: opts.worktreePath ?? null,
    result_file,
  };
}
