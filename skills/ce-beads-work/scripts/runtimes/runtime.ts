// runtimes/runtime.ts — pluggable worker runtime. HerdrRuntime is the
// production implementation; MockRuntime drives deterministic CI tests.

import type { CeUnit } from "../../../ce-beads/scripts/plan-parser.ts";
import type { RunState, RunUnitRecord } from "../run-state.ts";
import type { WorkerReport } from "../worker-report.ts";

export interface Workspace {
  unitId: string;
  worktreePath: string;   // absolute
  branch: string;         // ce-beads/<U-ID>-<run-id>
}

export interface WorkerHandle {
  paneId: string;         // Herdr pane id ("wN:pM"); "mock" for MockRuntime
  workspace: Workspace;
  /** Absolute path to .ce-beads-worker/result.json (R3 completion signal). */
  resultFile: string;
  startedAt: string;      // ISO
  /**
   * Prompt dispatch lifecycle (crash recovery, P1-2 v4):
   *   not_sent      → phase 1 done (pane exists), prompt not yet delivered
   *   dispatching   → phase 2 in progress (prompt being sent)
   *   sent          → phase 2 done, awaiting worker result
   * Resume checks this field to decide whether to re-send the prompt
   * (not_sent/dispatching) or skip to wait (sent).
   */
  promptLifecycle: "not_sent" | "dispatching" | "sent";
}

export interface WaitOpts {
  /** Max wall-clock wait before { kind: "timeout" }. */
  timeoutMs: number;
  /** Poll interval; default 2000. */
  pollIntervalMs?: number;
}

export type WorkerResult =
  | { kind: "completed"; report: WorkerReport }
  | { kind: "timeout" }
  | { kind: "died"; reason: string };

export type WorkerState = "running" | "finished" | "dead" | "unknown";

export interface CleanupOpts {
  /**
   * Separate actions for pane, worktree, and branch (reap preview fix):
   * - "close" pane: always done if pane exists
   * - "preserve" | "remove" worktree: remove only with --force
   * - "preserve" | "remove" branch: remove only with --force
   */
  pane: "close";
  worktree: "preserve" | "remove";
  branch: "preserve" | "remove";
}

export interface AgentRuntime {
  /**
   * Create the unit worktree + branch from the integration worktree's
   * CURRENT HEAD (P0-1), not run.base_sha. The engine passes the fork SHA
   * explicitly so the runtime doesn't have to re-derive it.
   */
  createWorkspace(unit: CeUnit, run: RunState, forkSha: string): Promise<Workspace>;
  /**
   * Phase 1: create the pane, launch omp, poll for agent detection.
   * Returns a handle with promptLifecycle = "not_sent". The engine
   * persists the pane_id IMMEDIATELY after this returns (before phase 2).
   * A crash between phase 1 and phase 2 is recoverable: resume finds the
   * pane by its label (ce-beads-<U-ID>-<run-id>) and re-invokes phase 2.
   */
  startWorkerPhase1(ws: Workspace): Promise<WorkerHandle>;
  /**
   * Phase 2: send the prompt to the already-running pane. Does NOT create
   * or rename anything. Sets promptLifecycle to "sent" on return.
   * A crash after phase 2 returns but before state save may cause
   * duplicate prompt delivery on resume — acceptable (idempotent from
   * the worker's perspective: it sees the prompt again, may produce
   * the same result file).
   */
  startWorkerPhase2(handle: WorkerHandle, prompt: string): Promise<void>;
  /**
   * File-based completion wait (R3): poll handle.resultFile for existence.
   * Lifecycle status (runtime.inspect) is an advisory fast-path hint only.
   */
  wait(handle: WorkerHandle, opts: WaitOpts): Promise<WorkerResult>;
  /** Non-blocking state probe; used by crash recovery. */
  inspect(handle: WorkerHandle): Promise<WorkerState>;
  /**
   * Close pane (if any). Worktree/branch actions per opts. Never touches
   * Beads. Receives the full handle so it can close the pane after a
   * restart (P1-5).
   */
  cleanup(handle: WorkerHandle, opts: CleanupOpts): Promise<void>;
}
