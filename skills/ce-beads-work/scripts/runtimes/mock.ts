// runtimes/mock.ts — MockRuntime: scripted, deterministic AgentRuntime for CI.
// Uses REAL git worktrees (so the engine's capture/merge/verify path exercises
// real git), but no Herdr, no panes, no OMP. The "worker" is a script that
// writes files and a result.json synchronously in startWorkerPhase2.
//
// Per P1-4/P1-5: MockRuntime does NOT commit. The engine's CAPTURE step does
// the commit (identical to the production HerdrRuntime path). This ensures CI
// exercises the real commit/integration code, not a mock shortcut.

import { execFileSync } from "node:child_process";
import { mkdir, rename, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { hrtime } from "node:process";
import type { CeUnit } from "../../../ce-beads/scripts/plan-parser.ts";
import type { RunState } from "../run-state.ts";
import type { WorkerReport } from "../worker-report.ts";
import {
  WORKER_RESULT_FILE,
  WORKER_RESULT_TEMP,
  validateWorkerReport,
} from "../worker-report.ts";
import { worktreeAdd } from "../git.ts";
import type {
  AgentRuntime,
  CleanupOpts,
  WaitOpts,
  WorkerHandle,
  WorkerResult,
  WorkerState,
  Workspace,
} from "./runtime.ts";

/**
 * Per-unit script driving the mock worker's behavior.
 * - `writeFiles`: map of worktree-relative path → content, written in phase 2.
 * - `report`: the WorkerReport to emit as result.json; `"malformed"` writes
 *   invalid JSON; `"die"` writes nothing (simulates a worker that crashed
 *   before producing a result — wait() times out or returns died).
 */
export interface MockScript {
  writeFiles: Record<string, string>;
  report: WorkerReport | "malformed" | "die";
}

/** Script keyed by U-ID. */
export type MockScriptMap = Record<string, MockScript>;

/**
 * Construct a MockRuntime. The script drives worker behavior per U-ID:
 * which files to write and which result (valid report, malformed JSON, or
 * nothing) to produce. Uses real git worktrees forked from the engine-supplied
 * SHA (P0-1).
 */
export function makeMockRuntime(script: MockScriptMap): AgentRuntime {
  return new MockRuntime(script);
}

class MockRuntime implements AgentRuntime {
  constructor(private readonly script: MockScriptMap) {}

  async createWorkspace(
    unit: CeUnit,
    run: RunState,
    forkSha: string,
  ): Promise<Workspace> {
    // P0-1: fork from the engine-supplied SHA (integration worktree HEAD),
    // NOT run.base_sha. The attempt suffix prevents path collisions on retry.
    const attempt = 1; // engine tracks attempt; mock is single-attempt per call
    const slug = `${unit.id}-${run.run_id}-a${attempt}`;
    const worktreePath = join(run.integration_worktree + "-workers", slug);
    const branch = `ce-beads/${slug}`;
    await worktreeAdd(run.integration_worktree, worktreePath, branch, forkSha);
    // Pre-create the .ce-beads-worker dir and ensure no stale result files.
    const workerDir = join(worktreePath, ".ce-beads-worker");
    await mkdir(workerDir, { recursive: true });
    return { unitId: unit.id, worktreePath, branch };
  }

  async startWorkerPhase1(ws: Workspace): Promise<WorkerHandle> {
    // Mock: no pane, no OMP. Return a handle with promptLifecycle="not_sent".
    // The resultFile path is derived from the worktree (R3).
    return {
      paneId: `mock:${ws.unitId}`,
      workspace: ws,
      resultFile: join(ws.worktreePath, WORKER_RESULT_FILE),
      startedAt: new Date().toISOString(),
      promptLifecycle: "not_sent",
    };
  }

  async startWorkerPhase2(handle: WorkerHandle, _prompt: string): Promise<void> {
    const ws = handle.workspace;
    const entry = this.script[ws.unitId];
    if (!entry) {
      // No script for this unit — treat as "die" (no result file written).
      handle.promptLifecycle = "sent";
      return;
    }
    // Write the scripted files into the worktree.
    for (const [relPath, content] of Object.entries(entry.writeFiles)) {
      const abs = join(ws.worktreePath, relPath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    }
    // Write the result file (or not, per the script).
    if (entry.report === "die") {
      // Write nothing — wait() will time out or detect death.
    } else if (entry.report === "malformed") {
      const tmpPath = join(ws.worktreePath, WORKER_RESULT_TEMP);
      await writeFile(tmpPath, "This is not JSON. {incomplete", "utf8");
      await rename(tmpPath, handle.resultFile);
    } else {
      // Valid report: write to temp, then rename atomically (R3).
      const tmpPath = join(ws.worktreePath, WORKER_RESULT_TEMP);
      await writeFile(tmpPath, JSON.stringify(entry.report, null, 2), "utf8");
      await rename(tmpPath, handle.resultFile);
    }
    handle.promptLifecycle = "sent";
  }

  async wait(handle: WorkerHandle, opts: WaitOpts): Promise<WorkerResult> {
    const pollIntervalMs = opts.pollIntervalMs ?? 2000;
    const start = hrtime();
    const timeoutNs = opts.timeoutMs * 1_000_000;
    for (;;) {
      // Deterministic path (R3): check result file existence.
      if (existsSync(handle.resultFile)) {
        const raw = await readFile(handle.resultFile, "utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return {
            kind: "died",
            reason: "result file present but not valid JSON",
          };
        }
        const validation = validateWorkerReport(parsed);
        if (validation.ok) {
          return { kind: "completed", report: validation.report };
        }
        return {
          kind: "died",
          reason: `result file present but invalid: ${validation.error}`,
        };
      }
      // Check timeout.
      const elapsed = hrtime(start);
      const elapsedMs = elapsed[0] * 1000 + elapsed[1] / 1_000_000;
      if (elapsedMs >= opts.timeoutMs) {
        // If the script was "die", report a death; otherwise timeout.
        const entry = this.script[handle.workspace.unitId];
        if (entry && entry.report === "die") {
          return { kind: "died", reason: "scripted worker death" };
        }
        return { kind: "timeout" };
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, pollIntervalMs);
      });
    }
  }

  async inspect(handle: WorkerHandle): Promise<WorkerState> {
    if (existsSync(handle.resultFile)) return "finished";
    return "running";
  }
  async cleanup(handle: WorkerHandle, opts: CleanupOpts): Promise<void> {
    const ws = handle.workspace;
    // opts.pane === "close" is a no-op for mock (no real pane).
    if (opts.worktree === "remove") {
      try {
        // git worktree remove works with the worktree path as cwd.
        execFileSync("git", ["worktree", "remove", "--force", ws.worktreePath], { stdio: "ignore" });
      } catch {
        // best-effort; worktree may already be gone
      }
    }
    if (opts.branch === "remove") {
      try {
        // Branch deletion needs the main repo, not the worktree.
        // Use execFileSync with -D flag.
        execFileSync("git", ["branch", "-D", ws.branch], {
          cwd: handle.workspace.worktreePath,
          stdio: "ignore",
        });
      } catch {
        // best-effort
      }
    }
  }
}
