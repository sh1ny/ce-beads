// orchestrator.ts — serial control loop + integrate-before-close state machine.
// Runtime-agnostic: constructed with any AgentRuntime. Commit capture lives
// HERE (P1-4/P1-5), not in the runtime, so MockRuntime and HerdrRuntime
// exercise the identical commit/integration path.

import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join, sep, basename } from "node:path";
import type { CePlan, CeUnit, VerificationEntry } from "../../ce-beads/scripts/plan-parser.ts";
import { parsePlan, PlanParseError } from "../../ce-beads/scripts/plan-parser.ts";
import { BeadsClient, BdError } from "../../ce-beads/scripts/beads-client.ts";
import { enumerateBinding } from "../../ce-beads/scripts/bind.ts";
import {
  envelope,
  type Diagnostic,
  type ProtocolEnvelope,
} from "../../ce-beads/scripts/protocol.ts";
import {
  saveRunState,
  loadRunState,
  findActiveRunForPlan,
  newRunId,
  latestRunId,
  type RunState,
  type RunStatus,
  type RunUnitRecord,
  type UnitRunState,
  RunStateError,
} from "./run-state.ts";
import type { WorkerReport } from "./worker-report.ts";
import { validateWorkerReport, WORKER_RESULT_FILE } from "./worker-report.ts";
import { buildWorkerPacket } from "./worker-packet.ts";
import { renderWorkerPrompt, getWorkerAgentBody } from "./worker-prompt.ts";
import {
  worktreeAdd,
  worktreeRemove,
  branchDelete,
  mergeBranch,
  revParse,
  statusPorcelain,
  addPaths,
  commit,
  gitCommonDir,
} from "./git.ts";
import type { AgentRuntime, WorkerHandle, WorkerResult, Workspace } from "./runtimes/runtime.ts";

/** Unit states where work is in-flight (not yet closed, not pending/blocked). */
const IN_FLIGHT_STATES: ReadonlySet<UnitRunState> = new Set([
  "claimed",
  "worker_finished",
  "captured",
  "merged",
  "verified",
]);

// --- Public types ----------------------------------------------------------

export interface RunEngineOptions {
  repoRoot: string;
  beadsDir: string;
  runtime: AgentRuntime;
  /** Worker wait timeout forwarded to runtime.wait; default 30 min. */
  workerTimeoutMs?: number;
}

export interface RunUnitSummary {
  beadsId: string;
  state: UnitRunState;
  workerBaseSha: string | null;
  workerCommitSha: string | null;
  mergeSha: string | null;
  integratedSha: string | null;
}

export interface RunData {
  runId: string;
  planPath: string;
  status: RunStatus;
  integrationBranch: string;
  integrationWorktree: string;
  baseSha: string;
  inFlight: string | null;
  units: Record<string, RunUnitSummary>;
  readyCount: number | null;
}

// --- Engine ----------------------------------------------------------------

export class RunEngine {
  private readonly repoRoot: string;
  private readonly beadsDir: string;
  private readonly runtime: AgentRuntime;
  private readonly workerTimeoutMs: number;

  constructor(opts: RunEngineOptions) {
    this.repoRoot = opts.repoRoot;
    this.beadsDir = opts.beadsDir;
    this.runtime = opts.runtime;
    this.workerTimeoutMs = opts.workerTimeoutMs ?? 30 * 60 * 1000;
  }

  async start(planPath: string, opts?: { once?: boolean }): Promise<ProtocolEnvelope> {
    // 1. Parse plan.
    let plan: CePlan;
    try {
      plan = parsePlan(planPath, { repoRoot: this.repoRoot });
    } catch (e) {
      if (e instanceof PlanParseError) {
        return envelope("run", false, "refused", null, [
          {
            code: e.code === "PLAN_UNSUPPORTED" ? "PLAN_UNSUPPORTED" : "PLAN_MALFORMED",
            severity: "blocking",
            message: e.message,
          },
        ]);
      }
      throw e;
    }

    // 2. Refuse on active run for the plan (RUN_ACTIVE) — check BEFORE binding
    //    so a second start while a run is in_progress is refused even if the
    //    Beads workspace state changed since the run started.
    const activeRun = findActiveRunForPlan(plan.path, this.repoRoot);
    if (activeRun) {
      return envelope("run", false, "refused", null, [
        {
          code: "RUN_ACTIVE",
          severity: "blocking",
          message: `Run ${activeRun.run_id} is already active for plan ${plan.path}.`,
        },
      ]);
    }

    // 3. Verify binding (NOT_BOUND refusal if unbound).
    const client = new BeadsClient({ beadsDir: this.beadsDir });
    let binding;
    try {
      binding = await enumerateBinding(client, plan.path);
    } catch (e) {
      if (e instanceof BdError && e.kind === "bd_missing") {
        return envelope("run", false, "refused", null, [
          { code: "BD_MISSING", severity: "blocking", message: e.message },
        ]);
      }
      return envelope("run", false, "failed", null, [
        { code: "BD_FAILURE", severity: "blocking", message: (e as Error).message },
      ]);
    }
    if (!binding.epic) {
      return envelope("run", false, "refused", null, [
        {
          code: "NOT_BOUND",
          severity: "blocking",
          message: `Plan ${plan.path} is not bound to Beads. Run 'ce-beads bind' first.`,
        },
      ]);
    }

    // 4. Write initializing run-state FIRST (crash-recoverable).
    const baseSha = await revParse(this.repoRoot, "HEAD");
    const runId = newRunId();
    const integrationBranch = `ce-beads/${runId}`;
    const integrationWorktree = join(await this.worktreeRoot(), runId);
    const now = new Date().toISOString();
    const planDigest = plan.digest;

    const units: Record<string, RunUnitRecord> = {};
    for (const unit of plan.units) {
      units[unit.id] = this.initialUnitRecord(unit.id);
    }

    const initialState: RunState = {
      schema_version: "ce-beads-run/1",
      run_id: runId,
      plan_path: plan.path,
      plan_digest: planDigest,
      base_sha: baseSha,
      integration_branch: integrationBranch,
      integration_worktree: integrationWorktree,
      status: "in_progress",
      started_at: now,
      finished_at: null,
      units,
    };
    saveRunState(initialState, this.repoRoot);

    // 5. Create integration branch + worktree.
    try {
      await worktreeAdd(this.repoRoot, integrationWorktree, integrationBranch, baseSha);
    } catch (e) {
      // Mark run failed — setup incomplete.
      initialState.status = "failed";
      saveRunState(initialState, this.repoRoot);
      return envelope("run", false, "failed", null, [
        {
          code: "RUNTIME_FAILURE",
          severity: "blocking",
          message: `Failed to create integration worktree: ${(e as Error).message}`,
        },
      ]);
    }

    // 6. Drive loop.
    return this.driveLoop(plan, client, initialState, opts?.once ?? false);
  }

  async resume(runId: string, opts?: { once?: boolean; retry?: boolean }): Promise<ProtocolEnvelope> {
    let state: RunState;
    try {
      state = loadRunState(runId, this.repoRoot);
    } catch (e) {
      if (e instanceof RunStateError) {
        return envelope("run", false, "not_found", null, [
          { code: e.code, severity: "blocking", message: e.message },
        ]);
      }
      throw e;
    }

    // Validate plan digest hasn't drifted.
    let plan: CePlan;
    try {
      plan = parsePlan(state.plan_path, { repoRoot: this.repoRoot });
    } catch (e) {
      if (e instanceof PlanParseError) {
        return envelope("run", false, "refused", null, [
          { code: "PLAN_MALFORMED", severity: "blocking", message: e.message },
        ]);
      }
      throw e;
    }
    if (plan.digest !== state.plan_digest) {
      return envelope("run", false, "refused", null, [
        {
          code: "PLAN_DIGEST_DRIFT",
          severity: "blocking",
          message: `Plan ${state.plan_path} has been modified since run ${runId} started. Refusing to resume.`,
        },
      ]);
    }

    // Refuse resume for terminal run states — the work was explicitly
    // released (abandoned), cleaned up (reaped), or finished (completed).
    if (state.status === "abandoned" || state.status === "reaped" || state.status === "completed") {
      return envelope("run", false, "refused", null, [
        {
          code: "RUN_ACTIVE",
          severity: "blocking",
          message: `Run ${runId} is in terminal state "${state.status}" and cannot be resumed.`,
        },
      ]);
    }

    // If blocked and no retry, return immediately.
    if (state.status === "blocked" && !opts?.retry) {
      return this.statusEnvelope(state, "blocked");
    }

    const client = new BeadsClient({ beadsDir: this.beadsDir });
    return this.driveLoop(plan, client, state, opts?.once ?? false, opts?.retry ?? false);
  }

  async status(runId?: string): Promise<ProtocolEnvelope> {
    const id = runId ?? latestRunId(this.repoRoot);
    if (!id) {
      return envelope("run", false, "not_found", null, [
        { code: "RUN_NOT_FOUND", severity: "blocking", message: "No runs found." },
      ]);
    }
    let state: RunState;
    try {
      state = loadRunState(id, this.repoRoot);
    } catch (e) {
      if (e instanceof RunStateError) {
        return envelope("run", false, "not_found", null, [
          { code: e.code, severity: "blocking", message: e.message },
        ]);
      }
      throw e;
    }
    return this.statusEnvelope(state);
  }

  async reap(
    runId: string,
    opts?: { force?: boolean; applyToken?: string },
  ): Promise<ProtocolEnvelope> {
    let state: RunState;
    try {
      state = loadRunState(runId, this.repoRoot);
    } catch (e) {
      if (e instanceof RunStateError) {
        return envelope("run", false, "not_found", null, [
          { code: e.code, severity: "blocking", message: e.message },
        ]);
      }
      throw e;
    }

    // Refuse if in_progress unless --force.
    if (state.status === "in_progress" && !opts?.force) {
      return envelope("run", false, "refused", null, [
        {
          code: "RUN_ACTIVE",
          severity: "blocking",
          message: `Run ${runId} is in_progress. Use --force to reap an active run.`,
        },
      ]);
    }

    // Preview without applyToken.
    if (!opts?.applyToken) {
      const preview = this.buildReapPreview(state);
      const token = reapToken(preview);
      return envelope("run", true, "preview", { ...preview, approval_token: token }, []);
    }

    // Apply: validate token + execute cleanup.
    const preview = this.buildReapPreview(state);
    const expectedToken = reapToken(preview);
    if (opts.applyToken !== expectedToken) {
      return envelope("run", false, "refused", null, [
        { code: "TOKEN_MISMATCH", severity: "blocking", message: "Reap token mismatch." },
      ]);
    }

    // Execute cleanup for each non-closed unit.
    const diagnostics: Diagnostic[] = [];
    for (const [unitId, unit] of Object.entries(state.units)) {
      if (unit.state === "closed" || !unit.worktree_path || !unit.worker_branch) continue;
      const handle: WorkerHandle = {
        paneId: unit.worker_pane_id ?? "unknown",
        workspace: {
          unitId,
          worktreePath: unit.worktree_path,
          branch: unit.worker_branch,
        },
        resultFile: join(unit.worktree_path, WORKER_RESULT_FILE),
        startedAt: unit.claimed_at ?? "",
        promptLifecycle: unit.prompt_lifecycle,
      };
      try {
        await this.runtime.cleanup(handle, {
          pane: "close",
          worktree: "remove",
          branch: "remove",
        });
      } catch (e) {
        diagnostics.push({
          code: "RUNTIME_FAILURE",
          severity: "warning",
          message: `Cleanup failed for ${unitId}: ${(e as Error).message}`,
        });
      }
    }

    // Remove integration worktree.
    if (state.integration_worktree) {
      try {
        await worktreeRemove(this.repoRoot, state.integration_worktree, true);
      } catch {
        // best-effort
      }
      try {
        await branchDelete(this.repoRoot, state.integration_branch, true);
      } catch {
        // best-effort
      }
    }

    // Mark run reaped — a terminal status that findActiveRunForPlan
    // does not consider active (unlike "failed" with unfinished units).
    state.status = "reaped";
    state.finished_at = new Date().toISOString();
    saveRunState(state, this.repoRoot);

    return envelope(
      "run",
      true,
      "reaped",
      this.toRunData(state),
      diagnostics,
    );
  }

  async abandon(runId: string, opts?: { applyToken?: string }): Promise<ProtocolEnvelope> {
    let state: RunState;
    try {
      state = loadRunState(runId, this.repoRoot);
    } catch (e) {
      if (e instanceof RunStateError) {
        return envelope("run", false, "not_found", null, [
          { code: e.code, severity: "blocking", message: e.message },
        ]);
      }
      throw e;
    }

    // Preview without applyToken.
    if (!opts?.applyToken) {
      const preview = this.buildAbandonPreview(state);
      const token = abandonToken(preview);
      return envelope("run", true, "preview", { ...preview, approval_token: token }, []);
    }

    // Apply: validate token.
    const preview = this.buildAbandonPreview(state);
    const expectedToken = abandonToken(preview);
    if (opts.applyToken !== expectedToken) {
      return envelope("run", false, "refused", null, [
        { code: "TOKEN_MISMATCH", severity: "blocking", message: "Abandon token mismatch." },
      ]);
    }

    // Execute: release each non-closed Beads task owned by this run.
    const client = new BeadsClient({ beadsDir: this.beadsDir });
    const diagnostics: Diagnostic[] = [];
    let hadPartial = false;

    for (const [unitId, unit] of Object.entries(state.units)) {
      if (unit.state === "closed") continue;

      try {
        // 1. Read back + verify ownership (ce_beads_run_id).
        const task = await client.show(unit.beads_id);
        if (!task) {
          diagnostics.push({
            code: "EXTERNAL_CHANGE",
            severity: "warning",
            message: `Task ${unit.beads_id} (${unitId}) not found in Beads; skipping.`,
          });
          continue;
        }
        const taskRunId = task.metadata?.ce_beads_run_id;

        // Skip tasks that don't belong to this run. A missing
        // ce_beads_run_id is also an external change — it means another
        // process cleared or corrupted the metadata (ce-beads-thread-SwF8U).
        if (!taskRunId || taskRunId !== state.run_id) {
          diagnostics.push({
            code: "EXTERNAL_CHANGE",
            severity: "warning",
            message: `Task ${unit.beads_id} (${unitId}) is not owned by run ${state.run_id} (metadata: ${taskRunId ?? "missing"}); skipping.`,
          });
          continue;
        }
        // 2. Reopen: status open, assignee cleared.
        await client.update(unit.beads_id, {
          status: "open",
          assignee: "",
        });

        // 3. Remove coordinator labels.
        await client.update(unit.beads_id, {
          removeLabel: [
            "ce-beads:claimed",
            "ce-beads:worker-finished",
            "ce-beads:blocked",
          ],
        });

        // 4. Clear coordinator metadata.
        await client.update(unit.beads_id, {
          unsetMetadata: [
            "ce_beads_run_id",
            "ce_beads_run_state",
            "ce_beads_blocker_reason",
          ],
        });

        // 5. Read back to confirm.
        const rechecked = await client.show(unit.beads_id);
        if (rechecked && rechecked.status !== "open") {
          diagnostics.push({
            code: "PARTIAL_APPLY",
            severity: "warning",
            message: `Task ${unit.beads_id} (${unitId}) status is ${rechecked.status} after abandon.`,
          });
          hadPartial = true;
        }
      } catch (e) {
        diagnostics.push({
          code: "PARTIAL_APPLY",
          severity: "warning",
          message: `Abandon failed for ${unitId} (${unit.beads_id}): ${(e as Error).message}`,
        });
        hadPartial = true;
      }
    }

    state.status = hadPartial ? "failed" : "abandoned";
    state.finished_at = new Date().toISOString();
    saveRunState(state, this.repoRoot);

    return envelope(
      "run",
      true,
      hadPartial ? "failed" : "abandoned",
      this.toRunData(state),
      diagnostics,
    );
  }

  // --- The control loop ----------------------------------------------------

  private async driveLoop(
    plan: CePlan,
    client: BeadsClient,
    state: RunState,
    once: boolean,
    retry = false,
  ): Promise<ProtocolEnvelope> {
    // 0. --retry: restore a blocked unit to its last successful state and
    //    re-enter the loop at that step (ce-beads-7ch). The serial loop
    //    guarantees at most one blocked unit at a time.
    if (retry) {
      for (const record of Object.values(state.units)) {
        if (record.state !== "blocked" || !record.last_successful_state) continue;
        record.state = record.last_successful_state;
        record.last_successful_state = null;
        record.blocker_reason = "";
        record.attempt = (record.attempt || 0) + 1;
        state.status = "in_progress";
        saveRunState(state, this.repoRoot);
        break;
      }
    }

    for (;;) {
      // 1. Find in-flight unit (state >= claimed and < closed).
      const inFlight = this.findInFlightUnit(state);
      if (inFlight) {
        // Resume integration from persisted state.
        const result = await this.integrate(plan, client, state, inFlight.unitId);
        if (result.kind === "blocked") {
          state.status = state.status === "in_progress" ? "blocked" : state.status;
          saveRunState(state, this.repoRoot);
          return this.statusEnvelope(state, "blocked", result.diagnostics);
        }
        if (once) return this.statusEnvelope(state);
        continue;
      }

      // 2. Find ready task (ordered by plan roster, not bd's incidental order).
      const readyTask = await this.findReadyTask(plan, client, state);
      if (!readyTask) {
        // All closed?
        const allClosed = plan.units.every((u) => state.units[u.id]?.state === "closed");
        if (allClosed) {
          state.status = "completed";
          state.finished_at = new Date().toISOString();
          saveRunState(state, this.repoRoot);
          return this.statusEnvelope(state, "completed");
        }
        // Blocked or nothing ready.
        state.status = "blocked";
        saveRunState(state, this.repoRoot);
        return this.statusEnvelope(state, "blocked", [
          {
            code: "WORKER_BLOCKED",
            severity: "blocking",
            message: "No ready tasks and not all units closed — dependency wedge.",
          },
        ]);
      }

      // 4. CLAIM the task.
      const unitId = readyTask.unitId;
      const unit = plan.units.find((u) => u.id === unitId)!;
      const record = state.units[unitId]!;

      try {
        await client.update(readyTask.beadsId, {
          claim: true,
          setMetadata: { ce_beads_run_id: state.run_id },
        });
      } catch (e) {
        return envelope("run", false, "failed", this.toRunData(state), [
          {
            code: "BD_FAILURE",
            severity: "blocking",
            message: `Claim failed for ${unitId}: ${(e as Error).message}`,
          },
        ]);
      }

      record.state = "claimed";
      record.beads_id = readyTask.beadsId;
      record.claimed_at = new Date().toISOString();
      record.attempt = record.attempt || 1;
      saveRunState(state, this.repoRoot);

      // 4c-4h. Dispatch the worker: workspace, packet, phases 1-2, wait.
      const dispatch = await this.dispatchWorker(plan, client, state, unitId, readyTask.beadsId);
      if (dispatch.kind === "blocked") {
        saveRunState(state, this.repoRoot);
        return this.statusEnvelope(
          state,
          state.status === "in_progress" ? "blocked" : state.status,
          dispatch.diagnostics,
        );
      }

      // 5. INTEGRATE.
      const integrateResult = await this.integrate(plan, client, state, unitId);
      if (integrateResult.kind === "blocked") {
        state.status = state.status === "in_progress" ? "blocked" : state.status;
        saveRunState(state, this.repoRoot);
        return this.statusEnvelope(state, "blocked", integrateResult.diagnostics);
      }

      if (once) return this.statusEnvelope(state);
    }
  }

  // --- Worker dispatch (workspace → packet → phase 1/2 → wait) ------------

  /**
   * Fork (or reuse) the worker workspace, write worker artifacts, start the
   * worker, and wait for its report. On success the record advances to
   * worker_finished; on any failure the unit is blocked and state.status set.
   *
   * Shared by the initial claim path in driveLoop and the claimed-state
   * resume path in integrate (ce-beads-7i7).
   */
  private async dispatchWorker(
    plan: CePlan,
    client: BeadsClient,
    state: RunState,
    unitId: string,
    beadsId: string,
  ): Promise<{ kind: "finished" } | { kind: "blocked"; diagnostics: Diagnostic[] }> {
    const unit = plan.units.find((u) => u.id === unitId)!;
    const record = state.units[unitId]!;

    // Fork from integration worktree HEAD (P0-1) unless resuming into an
    // already-forked workspace (crash between claim and worker finish).
    // For retries (attempt > 1), the old workspace may contain partial files
    // from the failed attempt — remove it and fork fresh from the integration
    // HEAD so the next attempt starts clean (ce-beads-thread-Sv4Ns).
    let ws: Workspace;
    const isRetry = record.attempt > 1;
    if (isRetry && record.worktree_path && record.worker_branch) {
      // Remove the old worktree and branch so we get a clean fork.
      try {
        await worktreeRemove(this.repoRoot, record.worktree_path, true);
      } catch {
        // best-effort — may already be gone
      }
      try {
        await branchDelete(this.repoRoot, record.worker_branch, true);
      } catch {
        // best-effort
      }
      record.worktree_path = null;
      record.worker_branch = null;
    }
    if (record.worktree_path && record.worker_branch && existsSync(record.worktree_path)) {
      ws = {
        unitId,
        worktreePath: record.worktree_path,
        branch: record.worker_branch,
      };
      // If the worker already wrote a valid result file (crash during
      // wait()), don't delete it and relaunch — read it and advance to
      // worker_finished directly (ce-beads-thread-SwF8T, P1).
      const resultFile = join(ws.worktreePath, WORKER_RESULT_FILE);
      if (existsSync(resultFile)) {
        try {
          const raw = await readFile(resultFile, "utf8");
          const parsed = JSON.parse(raw);
          const validation = validateWorkerReport(parsed);
          if (validation.ok && validation.report.u_id === unitId) {
            // Valid report for this unit — accept it without relaunching.
            record.result = validation.report;
            record.state = "worker_finished";
            record.last_successful_state = "claimed";
            await client.update(beadsId, {
              setMetadata: { ce_beads_run_state: "worker_finished" },
              addLabel: ["ce-beads:worker-finished"],
            });
            saveRunState(state, this.repoRoot);
            return { kind: "finished" };
          }
        } catch {
          // Invalid result file — fall through to clear and relaunch.
        }
      }
      // If prompt was already sent (crash during wait), don't relaunch —
      // reconstruct the handle and wait for the existing worker's result
      // (ce-beads-thread-Sya30, P1).
      if (record.prompt_lifecycle === "sent" && record.worker_pane_id) {
        const existingHandle: WorkerHandle = {
          paneId: record.worker_pane_id,
          workspace: ws,
          resultFile: join(ws.worktreePath, WORKER_RESULT_FILE),
          startedAt: record.claimed_at ?? "",
          promptLifecycle: "sent",
        };
        const waitResult: WorkerResult = await this.runtime.wait(existingHandle, {
          timeoutMs: this.workerTimeoutMs,
        });
        if (waitResult.kind === "completed") {
          const report = waitResult.report;
          if (report.u_id !== unitId) {
            state.status = "blocked";
            return this.blockUnit(state, client, record, unitId, "claimed", {
              code: "WORKER_REPORT_INVALID",
              severity: "blocking",
              message: `Worker report u_id "${report.u_id}" does not match unit "${unitId}".`,
            });
          }
          record.result = report;
          if (report.status === "complete") {
            record.state = "worker_finished";
            record.last_successful_state = "claimed";
            await client.update(beadsId, {
              setMetadata: { ce_beads_run_state: "worker_finished" },
              addLabel: ["ce-beads:worker-finished"],
            });
            saveRunState(state, this.repoRoot);
            return { kind: "finished" };
          }
          state.status = report.status === "blocked" ? "blocked" : "failed";
          return this.blockUnit(state, client, record, unitId, "claimed", {
            code: report.status === "blocked" ? "WORKER_BLOCKED" : "WORKER_FAILED",
            severity: "blocking",
            message: `Worker ${report.status} for ${unitId}: ${report.blockers || "worker reported failure"}`,
          });
        }
        // timeout or died — fall through to clear and relaunch.
        state.status = waitResult.kind === "timeout" ? "blocked" : "failed";
      }
      // Clear any stale/invalid result file from a previous attempt (R3).
      await rm(resultFile, { force: true });
    } else {
      const forkSha = await revParse(state.integration_worktree, "HEAD");
      record.worker_base_sha = forkSha;
      ws = await this.runtime.createWorkspace(unit, state, forkSha);
      record.worker_branch = ws.branch;
      record.worktree_path = ws.worktreePath;
      saveRunState(state, this.repoRoot);
    }

    // Build packet.
    const verificationCommands = plan.verification_commands.filter(
      (v: VerificationEntry) => v.unit_id === unitId,
    );
    const packet = buildWorkerPacket(plan, unit, verificationCommands, {
      runId: state.run_id,
      beadsId,
      baseSha: record.worker_base_sha!,
      branch: ws.branch,
      worktreePath: ws.worktreePath,
      resultFile: join(ws.worktreePath, WORKER_RESULT_FILE),
    });

    // Write worker artifacts (system-prompt + packet.json).
    const workerDir = join(ws.worktreePath, ".ce-beads-worker");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "system-prompt.md"), getWorkerAgentBody(), "utf8");
    await writeFile(join(workerDir, "packet.json"), JSON.stringify(packet, null, 2), "utf8");

    // Start worker phase 1 (create pane + detect agent).
    let handle: WorkerHandle;
    try {
      handle = await this.runtime.startWorkerPhase1(ws);
      record.worker_pane_id = handle.paneId;
      record.prompt_lifecycle = "not_sent";
      saveRunState(state, this.repoRoot);
    } catch (e) {
      state.status = "failed";
      return this.blockUnit(state, client, record, unitId, "claimed", {
        code: "RUNTIME_FAILURE",
        severity: "blocking",
        message: `Worker phase 1 failed for ${unitId}: ${(e as Error).message}`,
      });
    }

    // Start worker phase 2 (send prompt).
    const prompt = renderWorkerPrompt(packet);
    handle.promptLifecycle = "dispatching";
    record.prompt_lifecycle = "dispatching";
    saveRunState(state, this.repoRoot);
    try {
      await this.runtime.startWorkerPhase2(handle, prompt);
      handle.promptLifecycle = "sent";
      record.prompt_lifecycle = "sent";
      // ce-beads-ao6: phase 2 may assign the real pane id — persist it.
      record.worker_pane_id = handle.paneId;
      saveRunState(state, this.repoRoot);
    } catch (e) {
      state.status = "failed";
      return this.blockUnit(state, client, record, unitId, "claimed", {
        code: "RUNTIME_FAILURE",
        severity: "blocking",
        message: `Worker phase 2 failed for ${unitId}: ${(e as Error).message}`,
      });
    }

    // Wait for completion (file-based).
    const waitResult: WorkerResult = await this.runtime.wait(handle, {
      timeoutMs: this.workerTimeoutMs,
    });

    if (waitResult.kind === "completed") {
      const report = waitResult.report;
      // Validate report identity: the report's u_id must match the unit
      // being processed. A stale or wrong-unit result file must not
      // advance the current unit's state (ce-beads-thread-24).
      if (report.u_id !== unitId) {
        state.status = "blocked";
        return this.blockUnit(state, client, record, unitId, "claimed", {
          code: "WORKER_REPORT_INVALID",
          severity: "blocking",
          message: `Worker report u_id "${report.u_id}" does not match unit "${unitId}". Rejecting stale/wrong-unit result.`,
        });
      }
      record.result = report;
      if (report.status === "complete") {
        record.state = "worker_finished";
        record.last_successful_state = "claimed";
        await client.update(beadsId, {
          setMetadata: { ce_beads_run_state: "worker_finished" },
          addLabel: ["ce-beads:worker-finished"],
        });
        saveRunState(state, this.repoRoot);
        return { kind: "finished" };
      }
      // blocked/failed report — the work product is unusable, so a later
      // --retry restores "claimed" and re-runs the worker (ce-beads-7ch).
      state.status = report.status === "blocked" ? "blocked" : "failed";
      return this.blockUnit(state, client, record, unitId, "claimed", {
        code: report.status === "blocked" ? "WORKER_BLOCKED" : "WORKER_FAILED",
        severity: "blocking",
        message:
          report.status === "blocked"
            ? `Worker reported blocked for ${unitId}: ${report.blockers}`
            : `Worker reported failure for ${unitId}: ${report.blockers || "worker reported failure"}`,
      });
    }

    // timeout or died — preserve worktree.
    state.status = waitResult.kind === "timeout" ? "blocked" : "failed";
    const blocked = await this.blockUnit(state, client, record, unitId, "claimed", {
      code: "WORKER_FAILED",
      severity: "blocking",
      message: `Worker ${waitResult.kind} for ${unitId}: ${
        waitResult.kind === "timeout" ? "worker timeout" : waitResult.reason
      }`,
    });
    // Best-effort cleanup: close pane, PRESERVE worktree.
    try {
      await this.runtime.cleanup(handle, {
        pane: "close",
        worktree: "preserve",
        branch: "preserve",
      });
    } catch {
      // best-effort
    }
    saveRunState(state, this.repoRoot);
    return blocked;
  }

  private async integrate(
    plan: CePlan,
    client: BeadsClient,
    state: RunState,
    unitId: string,
  ): Promise<{ kind: "done" } | { kind: "blocked"; diagnostics: Diagnostic[] }> {
    const unit = plan.units.find((u) => u.id === unitId)!;
    const record = state.units[unitId]!;

    // 5a. If claimed (resume/retry before the worker finished) → (re)launch
    if (record.state === "claimed") {
      const dispatch = await this.dispatchWorker(plan, client, state, unitId, record.beads_id);
      if (dispatch.kind === "blocked") return dispatch;
    }

    // 5b. If worker_finished → capture.
    if (record.state === "worker_finished") {
      // 5b. CAPTURE: validate changed_files + commit.
      // Re-read the result file on retry so a human-corrected report is
      // picked up instead of the stale record.result from the failed
      // attempt (ce-beads-thread-Sv4Nu).
      if (record.worktree_path) {
        const resultFile = join(record.worktree_path, WORKER_RESULT_FILE);
        if (existsSync(resultFile)) {
          try {
            const raw = await readFile(resultFile, "utf8");
            const parsed = JSON.parse(raw);
            const validation = validateWorkerReport(parsed);
            // Re-validate u_id on the reloaded report — a stale/wrong-unit
            // result file must not overwrite record.result
            // (ce-beads-thread-SwF8W).
            if (validation.ok && validation.report.u_id === unitId) {
              record.result = validation.report;
            }
          } catch {
            // If re-read fails, fall through to record.result.
          }
        }
      }
      const report = record.result!;
      const validatedSet = this.validateChangedFiles(report.changed_files, record.worktree_path!, plan.path);
      if (!validatedSet) {
        return this.blockUnit(state, client, record, unitId, "worker_finished", {
          code: "CHANGED_FILES_INVALID",
          severity: "blocking",
          message: `Changed files validation failed for ${unitId}.`,
        });
      }

      // Collect actual non-artifact modified paths from git status.
      const statusRaw = await statusPorcelain(record.worktree_path!);
      const actualSet = this.parseActualFiles(statusRaw);
      if (!actualSet.ok) {
        return this.blockUnit(state, client, record, unitId, "worker_finished", {
          code: "CHANGED_FILES_INVALID",
          severity: "blocking",
          message: actualSet.error,
        });
      }

      // Two-way equality check.
      const reportedOnly = validatedSet.filter((p) => !actualSet.value.includes(p));
      const actualOnly = actualSet.value.filter((p) => !validatedSet.includes(p));
      if (reportedOnly.length > 0 || actualOnly.length > 0) {
        const parts: string[] = [];
        if (actualOnly.length > 0)
          parts.push(`undeclared modification: ${actualOnly.sort().join(", ")}`);
        if (reportedOnly.length > 0)
          parts.push(`declared but not modified: ${reportedOnly.sort().join(", ")}`);
        return this.blockUnit(state, client, record, unitId, "worker_finished", {
          code: "CHANGED_FILES_INVALID",
          severity: "blocking",
          message: `Changed files mismatch for ${unitId}: ${parts.join("; ")}`,
        });
      }

      // Stage only validated paths + commit.
      if (validatedSet.length > 0) {
        await addPaths(record.worktree_path!, validatedSet);
        const sha = await commit(
          record.worktree_path!,
          `ce-beads(${unitId}): worker changes (${state.run_id})`,
        );
        record.worker_commit_sha = sha;
      } else {
        // Empty diff + status complete → WORKER_FAILED.
        return this.blockUnit(state, client, record, unitId, "worker_finished", {
          code: "WORKER_FAILED",
          severity: "blocking",
          message: `Worker reported complete but no changes for ${unitId}.`,
        });
      }
      record.state = "captured";
      record.last_successful_state = "worker_finished";
      saveRunState(state, this.repoRoot);
    }

    // 5d. VERIFY (pre-merge, R8).
    if (record.state === "captured") {
      const verifyResult = await this.runVerification(plan, unitId, record.worktree_path!);
      if (!verifyResult.ok) {
        return this.blockUnit(state, client, record, unitId, "captured", {
          code: "VERIFICATION_FAILED",
          severity: "blocking",
          message: `Pre-merge verification failed for ${unitId}: ${verifyResult.error}`,
        });
      }
    }

    // 5e. MERGE.
    if (record.state === "captured") {
      const mergeResult = await mergeBranch(
        state.integration_worktree,
        state.integration_branch,
        record.worker_branch!,
        `ce-beads(${unitId}): merge worker branch (${state.run_id})`,
      );
      if (mergeResult.conflict) {
        return this.blockUnit(state, client, record, unitId, "captured", {
          code: "INTEGRATION_FAILED",
          severity: "blocking",
          message: `Merge conflict for ${unitId}: left for human resolution.`,
        });
      }
      record.merge_sha = mergeResult.mergeSha;
      record.state = "merged";
      record.last_successful_state = "captured";
      saveRunState(state, this.repoRoot);
    }

    // 5f. VERIFY (post-merge, R8).
    if (record.state === "merged") {
      const verifyResult = await this.runVerification(plan, unitId, state.integration_worktree);
      if (!verifyResult.ok) {
        return this.blockUnit(state, client, record, unitId, "merged", {
          code: "INTEGRATION_FAILED",
          severity: "blocking",
          message: `Post-merge verification failed for ${unitId}: ${verifyResult.error}`,
        });
      }
      record.state = "verified";
      record.last_successful_state = "merged";
      saveRunState(state, this.repoRoot);
    }

    // 5g. CLOSE.
    if (record.state === "verified") {
      try {
        await client.close(record.beads_id);
      } catch (e) {
        // Reconcile: maybe already closed.
        const task = await client.show(record.beads_id);
        if (!task || task.status !== "closed") {
          return this.blockUnit(state, client, record, unitId, "verified", {
            code: "BD_FAILURE",
            severity: "blocking",
            message: `Close failed for ${unitId}: ${(e as Error).message}`,
          });
        }
      }
      record.integrated_sha = await revParse(state.integration_worktree, "HEAD");
      record.state = "closed";
      record.last_successful_state = "verified";
      saveRunState(state, this.repoRoot);

      // Cleanup worker workspace.
      if (record.worker_pane_id && record.worktree_path && record.worker_branch) {
        const handle: WorkerHandle = {
          paneId: record.worker_pane_id,
          workspace: {
            unitId,
            worktreePath: record.worktree_path,
            branch: record.worker_branch,
          },
          resultFile: join(record.worktree_path, WORKER_RESULT_FILE),
          startedAt: record.claimed_at ?? "",
          promptLifecycle: record.prompt_lifecycle,
        };
        try {
          await this.runtime.cleanup(handle, {
            pane: "close",
            worktree: "remove",
            branch: "remove",
          });
        } catch {
          // best-effort
        }
      }
    }

    return { kind: "done" };
  }

  // --- Helpers --------------------------------------------------------------

  private initialUnitRecord(beadsId: string): RunUnitRecord {
    return {
      beads_id: beadsId,
      state: "pending",
      worker_pane_id: null,
      worker_branch: null,
      worktree_path: null,
      worker_base_sha: null,
      claimed_at: null,
      worker_commit_sha: null,
      merge_sha: null,
      integrated_sha: null,
      result: null,
      last_successful_state: null,
      blocker_reason: "",
      prompt_lifecycle: "not_sent",
      attempt: 1,
    };
  }

  private findInFlightUnit(state: RunState): { unitId: string } | null {
    for (const [unitId, unit] of Object.entries(state.units)) {
      if (IN_FLIGHT_STATES.has(unit.state)) {
        return { unitId };
      }
    }
    return null;
  }

  private async findReadyTask(
    plan: CePlan,
    client: BeadsClient,
    state: RunState,
  ): Promise<{ unitId: string; beadsId: string } | null> {
    // Order by plan roster (FIX 5).
    const readyTasks = await client.readyTasks(plan.path);
    const readyById = new Map(readyTasks.map((t) => [t.id, t]));
    // Map unit → beads_id via metadata.
    for (const unit of plan.units) {
      // Skip already-closed or non-pending units.
      const record = state.units[unit.id];
      if (record && record.state !== "pending") continue;
      // Find the ready task whose metadata.ce_unit_id matches.
      for (const task of readyById.values()) {
        if (task.metadata?.ce_unit_id === unit.id) {
          return { unitId: unit.id, beadsId: task.id };
        }
      }
    }
    return null;
  }

  private validateChangedFiles(
    changedFiles: string[],
    worktreePath: string,
    planPath: string,
  ): string[] | null {
    const validated: string[] = [];
    // Normalize the plan path for comparison (repo-relative, forward slashes).
    const normalizedPlanPath = planPath.replace(/\\/g, "/").replace(/^\.\//, "");
    for (const p of changedFiles) {
      // Must be repo-relative (no leading /).
      if (p.startsWith("/")) return null;
      // Must not escape via ..
      const resolved = join(worktreePath, p);
      if (!resolved.startsWith(worktreePath + sep)) return null;
      // Must not be under .ce-beads-worker/.
      if (p.startsWith(".ce-beads-worker/")) return null;
      // Must not be the plan file — the CE plan is immutable during a run.
      const normalizedP = p.replace(/\\/g, "/");
      if (normalizedP === normalizedPlanPath) return null;
      validated.push(p);
    }
    return validated;
  }

  private parseActualFiles(
    statusRaw: string,
  ): { ok: true; value: string[] } | { ok: false; error: string } {
    if (!statusRaw) return { ok: true, value: [] };
    const files: string[] = [];
    // -z format: NUL-delimited records. Each record: "XY <path>" (or two paths for R/C).
    const records = statusRaw.split("\0");
    for (const record of records) {
      if (!record) continue;
      const xy = record.slice(0, 2);
      const rest = record.slice(3); // skip "XY "
      // Reject renames/copies.
      if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
        return {
          ok: false,
          error: "renames/copies not supported in serial MVP",
        };
      }
      // Filter out .ce-beads-worker/ artifacts.
      if (rest.startsWith(".ce-beads-worker/")) continue;
      files.push(rest);
    }
    return { ok: true, value: files };
  }

  private async runVerification(
    plan: CePlan,
    unitId: string,
    cwd: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const commands = plan.verification_commands.filter((v) => v.unit_id === unitId);
    for (const entry of commands) {
      const result = await runCommand(entry.command, cwd);
      if (result.exitCode !== 0) {
        return { ok: false, error: `command "${entry.command}" exited ${result.exitCode}: ${result.stderr}` };
      }
    }
    return { ok: true };
  }

  private async blockUnit(
    state: RunState,
    client: BeadsClient,
    record: RunUnitRecord,
    unitId: string,
    lastSuccess: UnitRunState,
    diagnostic: Diagnostic,
  ): Promise<{ kind: "blocked"; diagnostics: Diagnostic[] }> {
    record.state = "blocked";
    record.last_successful_state = lastSuccess;
    record.blocker_reason = diagnostic.message;
    try {
      await client.update(record.beads_id, {
        setMetadata: {
          ce_beads_run_state: "blocked",
          ce_beads_blocker_reason: diagnostic.message,
        },
        addLabel: ["ce-beads:blocked"],
      });
    } catch {
      // best-effort — the block is already persisted in run-state
    }
    saveRunState(state, this.repoRoot);
    return { kind: "blocked", diagnostics: [diagnostic] };
  }

  private buildReapPreview(state: RunState): ReapPreview {
    const entries: ReapEntry[] = [];
    for (const [unitId, unit] of Object.entries(state.units)) {
      if (unit.state === "closed") continue;
      entries.push({
        unitId,
        beadsId: unit.beads_id,
        paneId: unit.worker_pane_id,
        worktreePath: unit.worktree_path,
        branch: unit.worker_branch,
      });
    }
    return {
      runId: state.run_id,
      integrationWorktree: state.integration_worktree,
      integrationBranch: state.integration_branch,
      entries,
    };
  }

  private buildAbandonPreview(state: RunState): AbandonPreview {
    const entries: AbandonEntry[] = [];
    for (const [unitId, unit] of Object.entries(state.units)) {
      if (unit.state === "closed") continue;
      entries.push({
        unitId,
        beadsId: unit.beads_id,
        state: unit.state,
      });
    }
    return { runId: state.run_id, entries };
  }

  private toRunData(state: RunState): RunData {
    const units: Record<string, RunUnitSummary> = {};
    let inFlight: string | null = null;
    for (const [unitId, unit] of Object.entries(state.units)) {
      units[unitId] = {
        beadsId: unit.beads_id,
        state: unit.state,
        workerBaseSha: unit.worker_base_sha,
        workerCommitSha: unit.worker_commit_sha,
        mergeSha: unit.merge_sha,
        integratedSha: unit.integrated_sha,
      };
      if (IN_FLIGHT_STATES.has(unit.state)) {
        inFlight = unitId;
      }
    }
    return {
      runId: state.run_id,
      planPath: state.plan_path,
      status: state.status,
      integrationBranch: state.integration_branch,
      integrationWorktree: state.integration_worktree,
      baseSha: state.base_sha,
      inFlight,
      units,
      readyCount: null,
    };
  }

  private async statusEnvelope(
    state: RunState,
    outcome: "in_progress" | "completed" | "blocked" | "failed" | "abandoned" | "reaped" = state.status,
    diagnostics: Diagnostic[] = [],
  ): Promise<ProtocolEnvelope> {
    const data = this.toRunData(state);
    // Best-effort ready count.
    try {
      const client = new BeadsClient({ beadsDir: this.beadsDir });
      const ready = await client.readyTasks(state.plan_path);
      data.readyCount = ready.length;
    } catch {
      data.readyCount = null;
    }
    return envelope("run", outcome === "completed", outcome, data, diagnostics);
  }

  private async worktreeRoot(): Promise<string> {
    const commonDir = await gitCommonDir(this.repoRoot);
    return join(commonDir, "ce-beads-worktrees");
  }
}

// --- Preview types ---------------------------------------------------------

export interface ReapEntry {
  unitId: string;
  beadsId: string;
  paneId: string | null;
  worktreePath: string | null;
  branch: string | null;
}

export interface ReapPreview {
  runId: string;
  integrationWorktree: string;
  integrationBranch: string;
  entries: ReapEntry[];
}

export interface AbandonEntry {
  unitId: string;
  beadsId: string;
  state: UnitRunState;
}

export interface AbandonPreview {
  runId: string;
  entries: AbandonEntry[];
}

// --- Token helpers (SHA-256 over the preview JSON) -----------------------

function reapToken(preview: ReapPreview): string {
  return sha256Hex(JSON.stringify(preview));
}

function abandonToken(preview: AbandonPreview): string {
  return sha256Hex(JSON.stringify(preview));
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// --- Process helpers -------------------------------------------------------

async function runCommand(command: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Use Bun.$ to avoid Bun's posix_spawn ENOENT bug (same fix as git.ts runInDir).
  try {
    const result = await Bun.$`bash -c ${command}`.cwd(cwd).quiet();
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode };
  } catch (e) {
    const err = e as { stdout?: Uint8Array; stderr?: Uint8Array; exitCode?: number };
    return {
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? (e as Error).message,
      exitCode: err.exitCode ?? -1,
    };
  }
}

