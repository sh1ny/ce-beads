// run-state.ts — durable coordinator-local run state for ce-beads-work.
//
// Run state is stored outside the consumer working tree, under the Git common
// directory when possible. Every write replaces the previous JSON file by an
// atomic same-directory rename so resume never observes a partial document.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { WorkerReport } from "./worker-report.ts";

/** Schema identifier for persisted ce-beads-work run state. */
export const RUN_STATE_SCHEMA_VERSION = "ce-beads-run/1" as const;

/** Lifecycle status of a coordinator run. */
export type RunStatus = "in_progress" | "blocked" | "completed" | "failed" | "abandoned";

/**
 * Per-unit lifecycle. The coordinator persists each transition so resume can
 * reconcile Git and Beads without repeating already-durable mutations.
 */
export type UnitRunState =
  | "pending"
  | "claimed"
  | "worker_finished"
  | "captured"
  | "merged"
  | "verified"
  | "closed"
  | "blocked";

/** Persisted prompt-dispatch lifecycle for a worker unit. */
export type PromptLifecycle = "not_sent" | "dispatching" | "sent";

/** Error codes emitted when a run-state file cannot be loaded. */
export type RunStateErrorCode = "RUN_STATE_CORRUPT" | "RUN_NOT_FOUND";

/**
 * Error thrown by run-state persistence helpers.
 *
 * `code` is intentionally machine-readable so callers can distinguish a
 * missing run from a file that exists but cannot safely be resumed.
 */
export class RunStateError extends Error {
  readonly code: RunStateErrorCode;

  constructor(code: RunStateErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "RunStateError";
    this.code = code;
  }
}

/** Durable state for one plan unit within a run. */
export interface RunUnitRecord {
  beads_id: string;
  state: UnitRunState;
  worker_pane_id: string | null;
  worker_branch: string | null;
  worktree_path: string | null;
  /** SHA from which the worker branch was forked at dispatch time. */
  worker_base_sha: string | null;
  claimed_at: string | null;
  /** Coordinator's commit of the worker tree after capture. */
  worker_commit_sha: string | null;
  /** Merge commit SHA on the integration branch. */
  merge_sha: string | null;
  /** Integration branch HEAD at close time. */
  integrated_sha: string | null;
  result: WorkerReport | null;
  /** State immediately before the unit transitioned to blocked. */
  last_successful_state: UnitRunState | null;
  /** Human-readable blocker reason; empty when the unit is not blocked. */
  blocker_reason: string;
  /** Prompt dispatch lifecycle. */
  prompt_lifecycle: PromptLifecycle;
  /** Attempt number, starting at one and incrementing on retry. */
  attempt: number;
}

/** Complete durable state for one ce-beads-work coordinator run. */
export interface RunState {
  schema_version: typeof RUN_STATE_SCHEMA_VERSION;
  run_id: string;
  plan_path: string;
  /** Stable digest of the plan at run start. */
  plan_digest: string;
  /** HEAD from which the integration branch was forked. */
  base_sha: string;
  integration_branch: string;
  integration_worktree: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  /** Full plan roster keyed by U-ID. */
  units: Record<string, RunUnitRecord>;
}

const RUN_STATUS_VALUES = new Set<RunStatus>([
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "abandoned",
]);

const UNIT_STATE_VALUES = new Set<UnitRunState>([
  "pending",
  "claimed",
  "worker_finished",
  "captured",
  "merged",
  "verified",
  "closed",
  "blocked",
]);

const PROMPT_LIFECYCLE_VALUES = new Set<PromptLifecycle>(["not_sent", "dispatching", "sent"]);

const ACTIVE_UNIT_STATES = new Set<UnitRunState>([
  "claimed",
  "worker_finished",
  "captured",
  "merged",
  "verified",
  "blocked",
]);

/**
 * Create a run identifier using UTC time and six random hexadecimal digits.
 *
 * The timestamp is sortable and has the required `YYYYMMDD-HHMMSS-6hex`
 * shape. Supplying `now` makes identifier formatting deterministic in tests;
 * the suffix remains random to avoid collisions within one second.
 */
export function newRunId(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("newRunId requires a valid Date");
  }

  const year = String(now.getUTCFullYear()).padStart(4, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hours = String(now.getUTCHours()).padStart(2, "0");
  const minutes = String(now.getUTCMinutes()).padStart(2, "0");
  const seconds = String(now.getUTCSeconds()).padStart(2, "0");
  const suffix = randomBytes(3).toString("hex");

  return `${year}${month}${day}-${hours}${minutes}${seconds}-${suffix}`;
}

/**
 * Resolve the directory containing run-state files.
 *
 * In a Git repository this is `$GIT_COMMON_DIR/ce-beads/`, shared by linked
 * worktrees. Outside Git, it falls back to
 * `${XDG_STATE_HOME:-$HOME/.local/state}/ce-beads/runs/`.
 */
export function runStateDir(repoRoot: string = process.cwd()): string {
  const root = resolve(repoRoot);

  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (commonDir.length > 0) {
      return join(resolve(root, commonDir), "ce-beads");
    }
  } catch {
    // Not a Git worktree (or Git is unavailable); use the XDG fallback below.
  }

  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "ce-beads", "runs");
}

/** Return the path for one persisted run-state document. */
export function runStatePath(runId: string, repoRoot: string = process.cwd()): string {
  return join(runStateDir(repoRoot), `run-${runId}.json`);
}

/**
 * Persist a run state atomically.
 *
 * The temporary file is created beside the destination, then renamed over it;
 * this keeps the replacement atomic on the same filesystem.
 */
export function saveRunState(state: RunState, repoRoot: string = process.cwd()): void {
  assertRunState(state);

  const dir = runStateDir(repoRoot);
  mkdirSync(dir, { recursive: true });

  const destination = join(dir, `run-${state.run_id}.json`);
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, destination);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original write/rename error.
    }
    throw error;
  }
}

/**
 * Load and validate a persisted run state.
 *
 * Throws {@link RunStateError} with `RUN_NOT_FOUND` when the file is absent,
 * and `RUN_STATE_CORRUPT` when it is unreadable, malformed, or the wrong
 * schema version.
 */
export function loadRunState(runId: string, repoRoot: string = process.cwd()): RunState {
  const path = runStatePath(runId, repoRoot);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      throw new RunStateError("RUN_NOT_FOUND", `Run state does not exist: ${runId}`);
    }
    throw new RunStateError("RUN_STATE_CORRUPT", `Unable to read ${basename(path)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RunStateError("RUN_STATE_CORRUPT", `Invalid JSON in ${basename(path)}`);
  }

  try {
    assertRunState(parsed);
  } catch (error) {
    if (error instanceof RunStateError) {
      throw error;
    }
    throw new RunStateError("RUN_STATE_CORRUPT", `Invalid run state in ${basename(path)}`);
  }

  if (parsed.run_id !== runId) {
    throw new RunStateError(
      "RUN_STATE_CORRUPT",
      `Run state ${basename(path)} contains run_id ${JSON.stringify(parsed.run_id)}`,
    );
  }
  return parsed;
}

/**
 * List persisted run identifiers in lexical order, with the newest sortable
 * identifier last. Missing state directories produce an empty list.
 */
export function listRunIds(repoRoot: string = process.cwd()): string[] {
  const dir = runStateDir(repoRoot);
  if (!existsSync(dir)) {
    return [];
  }

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => /^run-(.+)\.json$/.exec(entry.name)?.[1] ?? null)
    .filter((runId): runId is string => runId !== null)
    .sort();
}

/** Return the newest persisted run identifier, or `null` when none exist. */
export function latestRunId(repoRoot: string = process.cwd()): string | null {
  const runIds = listRunIds(repoRoot);
  return runIds.length === 0 ? null : runIds[runIds.length - 1]!;
}

/**
 * Find an ownership-active run for a plan.
 *
 * `in_progress` is always active, including during initialization with no
 * units. A blocked or failed run is active only while it owns a unit in one
 * of `claimed`, `worker_finished`, `captured`, `merged`, `verified`, or
 * `blocked`. Completed and abandoned runs are never active.
 */
export function findActiveRunForPlan(planPath: string, repoRoot: string = process.cwd()): RunState | null {
  const runIds = listRunIds(repoRoot);
  for (let index = runIds.length - 1; index >= 0; index -= 1) {
    const runId = runIds[index]!;
    const state = loadRunState(runId, repoRoot);
    if (state.plan_path !== planPath || !isActiveRun(state)) {
      continue;
    }
    return state;
  }
  return null;
}

function isActiveRun(state: RunState): boolean {
  if (state.status === "in_progress") {
    return true;
  }
  if (state.status !== "blocked" && state.status !== "failed") {
    return false;
  }
  return Object.values(state.units).some((unit) => ACTIVE_UNIT_STATES.has(unit.state));
}

function assertRunState(value: unknown): asserts value is RunState {
  if (!isObject(value)) {
    throw new RunStateError("RUN_STATE_CORRUPT", "run state must be an object");
  }
  if (value.schema_version !== RUN_STATE_SCHEMA_VERSION) {
    throw new RunStateError("RUN_STATE_CORRUPT", "unsupported run-state schema_version");
  }

  for (const field of ["run_id", "plan_path", "plan_digest", "base_sha", "integration_branch", "integration_worktree", "started_at"]) {
    if (typeof value[field] !== "string") {
      throw new RunStateError("RUN_STATE_CORRUPT", `${field} must be a string`);
    }
  }
  if (!RUN_STATUS_VALUES.has(value.status as RunStatus)) {
    throw new RunStateError("RUN_STATE_CORRUPT", "status is invalid");
  }
  if (value.finished_at !== null && typeof value.finished_at !== "string") {
    throw new RunStateError("RUN_STATE_CORRUPT", "finished_at must be a string or null");
  }
  if (!isObject(value.units) || Array.isArray(value.units)) {
    throw new RunStateError("RUN_STATE_CORRUPT", "units must be an object");
  }
  for (const [unitId, unit] of Object.entries(value.units)) {
    if (!isObject(unit)) {
      throw new RunStateError("RUN_STATE_CORRUPT", `unit ${unitId} must be an object`);
    }
    assertRunUnitRecord(unit, unitId);
  }
}

function assertRunUnitRecord(value: Record<string, unknown>, unitId: string): asserts value is RunUnitRecord {
  if (typeof value.beads_id !== "string") {
    throw new RunStateError("RUN_STATE_CORRUPT", `unit ${unitId} beads_id must be a string`);
  }
  if (!UNIT_STATE_VALUES.has(value.state as UnitRunState)) {
    throw new RunStateError("RUN_STATE_CORRUPT", `unit ${unitId} state is invalid`);
  }
  for (const field of ["worker_pane_id", "worker_branch", "worktree_path", "worker_base_sha", "claimed_at", "worker_commit_sha", "merge_sha", "integrated_sha"]) {
    if (value[field] !== null && typeof value[field] !== "string") {
      throw new RunStateError("RUN_STATE_CORRUPT", `unit ${unitId} ${field} must be a string or null`);
    }
  }
  if (value.result !== null && !isObject(value.result)) {
    throw new RunStateError("RUN_STATE_CORRUPT", `unit ${unitId} result must be an object or null`);
  }
  if (value.last_successful_state !== null && !UNIT_STATE_VALUES.has(value.last_successful_state as UnitRunState)) {
    throw new RunStateError("RUN_STATE_CORRUPT", `unit ${unitId} last_successful_state is invalid`);
  }
  if (typeof value.blocker_reason !== "string") {
    throw new RunStateError("RUN_STATE_CORRUPT", `unit ${unitId} blocker_reason must be a string`);
  }
  if (!PROMPT_LIFECYCLE_VALUES.has(value.prompt_lifecycle as PromptLifecycle)) {
    throw new RunStateError("RUN_STATE_CORRUPT", `unit ${unitId} prompt_lifecycle is invalid`);
  }
  if (typeof value.attempt !== "number" || !Number.isSafeInteger(value.attempt) || value.attempt < 1) {
    throw new RunStateError("RUN_STATE_CORRUPT", `unit ${unitId} attempt must be a positive integer`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}
