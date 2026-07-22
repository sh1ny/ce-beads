// runtimes/herdr.ts — production AgentRuntime over the Herdr CLI.
// Uses `herdr agent start` with the prompt as the LAST argv argument to omp
// (pi-overseer pattern): the agent starts working immediately, eliminating the
// two-phase startWorker gap. Completion is file-based (R3); `herdr agent get`
// is an advisory fast-path only.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { CeUnit } from "../../../ce-beads/scripts/plan-parser.ts";
import type { RunState } from "../run-state.ts";
import {
  WORKER_RESULT_FILE,
  validateWorkerReport,
} from "../worker-report.ts";
import {
  worktreeAdd,
  worktreeRemove,
  branchDelete,
} from "../git.ts";
import type {
  AgentRuntime,
  CleanupOpts,
  WaitOpts,
  WorkerHandle,
  WorkerResult,
  WorkerState,
  Workspace,
} from "./runtime.ts";

/** Tool whitelist enforced via `omp --tools` (R5). Mirrors the agent file. */
export const HERDR_WORKER_TOOLS = [
  "read", "grep", "glob", "bash", "edit", "write", "lsp", "ast_grep",
] as const;

export interface HerdrRuntimeOptions {
  /** Repo root the coordinator runs in (for git worktree operations). */
  repoRoot: string;
  /** Worktree root; default `${TMPDIR:-/tmp}/ce-beads-wt`. */
  worktreeRoot?: string;
  /** Worker model role; default from CE_BEADS_WORKER_MODEL env or "@smol". */
  model?: string;
  /** OMP profile; default from CE_BEADS_OMP_PROFILE env or "chinese". */
  profile?: string;
  /** herdr binary; default "herdr" (PATH). */
  herdrPath?: string;
  /** omp binary; default resolved from PATH or process.execPath. */
  ompPath?: string;
  /** Worker wait timeout; default 30 min. */
  workerTimeoutMs?: number;
  /** Herdr workspace ID to spawn agents in; defaults to current workspace. */
  workspaceId?: string;
}

export class HerdrRuntime implements AgentRuntime {
  private readonly repoRoot: string;
  private readonly worktreeRoot: string;
  private readonly model: string;
  private readonly profile: string;
  private readonly herdrPath: string;
  private readonly ompPath: string;
  private readonly workspaceId: string | undefined;

  constructor(opts: HerdrRuntimeOptions) {
    this.repoRoot = opts.repoRoot;
    this.worktreeRoot = opts.worktreeRoot ?? join(tmpdir(), "ce-beads-wt");
    this.model = opts.model ?? process.env.CE_BEADS_WORKER_MODEL ?? "@smol";
    this.profile = opts.profile ?? process.env.CE_BEADS_OMP_PROFILE ?? "chinese";
    this.herdrPath = opts.herdrPath ?? "herdr";
    this.ompPath = opts.ompPath ?? resolveOmpBinary();
    this.workspaceId = opts.workspaceId;
  }

  async createWorkspace(
    unit: CeUnit,
    run: RunState,
    forkSha: string,
  ): Promise<Workspace> {
    const attempt = 1;
    const slug = `${unit.id}-${run.run_id}-a${attempt}`;
    const worktreePath = join(this.worktreeRoot, slug);
    const branch = `ce-beads/${slug}`;
    await worktreeAdd(this.repoRoot, worktreePath, branch, forkSha);
    return { unitId: unit.id, worktreePath, branch };
  }

  async startWorkerPhase1(ws: Workspace): Promise<WorkerHandle> {
    // Phase 1: no pane created yet. The pane is created in phase 2 by
    // `herdr agent start` with the prompt as argv. Return a handle with
    // paneId=null; the engine persists this immediately so a crash between
    // phase 1 and phase 2 is recoverable (resume re-invokes phase 2).
    return {
      paneId: "",
      workspace: ws,
      resultFile: join(ws.worktreePath, WORKER_RESULT_FILE),
      startedAt: new Date().toISOString(),
      promptLifecycle: "not_sent",
    };
  }

  async startWorkerPhase2(handle: WorkerHandle, prompt: string): Promise<void> {
    const ws = handle.workspace;
    // Include the branch slug (which contains unit ID + run ID) in the
    // agent name to avoid collisions across runs (ce-beads-thread-Sya3_).
    const agentName = `ce-beads-${ws.branch.replace(/\//g, "-")}`;
    const disposableBeadsDir = await mkdtemp(join(tmpdir(), "ce-beads-worker-"));

    const argv: string[] = [
      this.ompPath,
      "--profile", this.profile,
      "--model", this.model,
      "--no-session",
      "--tools", HERDR_WORKER_TOOLS.join(","),
      "--append-system-prompt",
      join(ws.worktreePath, ".ce-beads-worker", "system-prompt.md"),
      prompt,
    ];

    const args: string[] = [
      "agent", "start", agentName,
      "--cwd", ws.worktreePath,
      "--split", "right",
      "--no-focus",
      "--env", `BEADS_DIR=${disposableBeadsDir}`,
      "--", ...argv,
    ];
    if (this.workspaceId) {
      args.splice(3, 0, "--workspace", this.workspaceId);
    }

    let paneId: string | null = null;

    // Primary path: herdr agent start with prompt as argv.
    try {
      const result = await this.runHerdr(args);
      const parsed = JSON.parse(result.stdout) as HerdrAgentStartResponse;
      if (parsed.error) {
        throw new Error(`herdr agent start failed: ${parsed.error.message}`);
      }
      paneId = parsed.result?.agent?.pane_id ?? null;
    } catch (e) {
      // Before falling back, check if the primary launch actually succeeded
      // despite the error (response-shape drift, warnings polluting stdout).
      // Query herdr by agent name — if the pane exists, skip the fallback to
      // avoid creating duplicate workers racing on the same files.
      const msg = (e as Error).message;
      let alreadyLaunched = false;
      try {
        const getResult = await this.runHerdr(["agent", "get", agentName]);
        const getParsed = JSON.parse(getResult.stdout) as HerdrAgentGetResponse;
        if (!getParsed.error && getParsed.result?.agent?.pane_id) {
          alreadyLaunched = true;
          paneId = getParsed.result.agent.pane_id;
        }
      } catch {
        // Agent not found — proceed with fallback.
      }
      if (!alreadyLaunched) {
        // Fallback (peer-agents pattern): manual pane split + pane run.
        try {
          paneId = await this.manualSplitStart(handle, prompt, disposableBeadsDir);
        } catch (fallbackErr) {
          throw new Error(
            `herdr agent start failed (${msg}); manual fallback also failed: ${(fallbackErr as Error).message}`,
          );
        }
      }
    }

    if (!paneId) {
      throw new Error("Failed to create worker pane (no pane_id from either path)");
    }
    handle.paneId = paneId;
    handle.promptLifecycle = "sent";

    // API key check: read the pane after a short delay for cold-start.
    await sleep(3000);
    const readResult = await this.runHerdr([
      "agent", "read", paneId,
      "--source", "visible",
      "--lines", "12",
    ]);
    const readParsed = JSON.parse(readResult.stdout) as HerdrAgentReadResponse;
    const text = readParsed.result?.read?.text ?? "";
    if (text.includes("No API key found")) {
      // Close the pane and throw.
      try {
        await this.runHerdr(["pane", "close", paneId]);
      } catch {
        // best-effort
      }
      throw new Error("Worker OMP session has no API key");
    }
  }

  /**
   * Manual fallback for pane creation when `herdr agent start` fails.
   * Mirrors the peer-agents-skill pattern: split a pane, rename it, then
   * use `pane run` to launch OMP with the prompt as the last argument.
   * The prompt is delivered via shell command (cd + omp ... "<prompt>"),
   * which is less clean than argv but works when agent start's process
   * detection fails.
   */
  private async manualSplitStart(
    handle: WorkerHandle,
    prompt: string,
    disposableBeadsDir: string,
  ): Promise<string> {
    const ws = handle.workspace;
    const agentName = `ce-beads-${ws.unitId}`;

    // Split a pane in the current workspace.
    const splitArgs = ["pane", "split", "--direction", "right", "--no-focus"];
    if (this.workspaceId) {
      splitArgs.push("--workspace", this.workspaceId);
    }
    const splitResult = await this.runHerdr(splitArgs);
    const splitParsed = JSON.parse(splitResult.stdout) as HerdrPaneSplitResponse;
    if (splitParsed.error || !splitParsed.result?.pane?.pane_id) {
      throw new Error(`pane split failed: ${splitParsed.error?.message ?? "no pane_id"}`);
    }
    const paneId = splitParsed.result.pane.pane_id;

    // Rename the pane to the agent name.
    try {
      await this.runHerdr(["pane", "rename", paneId, agentName]);
    } catch {
      // best-effort — rename is cosmetic
    }

    // Launch OMP via `pane run` with the prompt as a shell argument.
    // Construct a shell command that cd's to the worktree, sets BEADS_DIR,
    // and launches omp with all flags + the prompt.
    const systemPromptPath = join(ws.worktreePath, ".ce-beads-worker", "system-prompt.md");
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const shellCommand = [
      `cd '${ws.worktreePath}'`,
      `export BEADS_DIR='${disposableBeadsDir}'`,
      `'${this.ompPath}' --profile '${this.profile}' --model '${this.model}' --no-session --tools '${HERDR_WORKER_TOOLS.join(",")}' --append-system-prompt '${systemPromptPath}' '${escapedPrompt}'`,
    ].join(" && ");
    await this.runHerdr(["pane", "run", paneId, shellCommand]);

    // Poll for agent detection (cold-start tolerance).
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      try {
        const getResult = await this.runHerdr(["agent", "get", paneId]);
        const getParsed = JSON.parse(getResult.stdout) as HerdrAgentGetResponse;
        if (!getParsed.error && getParsed.result?.agent?.agent_status) {
          return paneId;
        }
      } catch {
        // keep polling
      }
    }
    return paneId;
  }

  async wait(handle: WorkerHandle, opts: WaitOpts): Promise<WorkerResult> {
    const pollIntervalMs = opts.pollIntervalMs ?? 2000;
    const deadline = Date.now() + opts.timeoutMs;
    // Track whether the agent has been observed working at least once.
    // Without this, a fast agent can go idle→working→idle before we check,
    // causing a false "died" detection (idle-race, peer-agents pattern).
    let hasBeenWorking = false;

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

      // Advisory fast-path: check agent state for death detection.
      if (handle.paneId) {
        try {
          const result = await this.runHerdr(["agent", "get", handle.paneId]);
          const parsed = JSON.parse(result.stdout) as HerdrAgentGetResponse;
          if (parsed.error) {
            // Agent not found → died (only after we've seen it working).
            if (hasBeenWorking) {
              return { kind: "died", reason: `agent not found: ${parsed.error.message}` };
            }
            // Haven't seen working yet — might still be starting. Keep polling.
          } else {
            const status = parsed.result?.agent?.agent_status;
            if (status === "working") {
              hasBeenWorking = true;
            }
            // Only treat "idle" as potentially dead if we've seen working
            // and the result file is still absent after sustained idleness.
            // The file (R3) is the truth — idle alone doesn't mean done.
          }
        } catch {
          // herdr command failed — might be transient, keep polling.
        }
      }

      // Check timeout.
      if (Date.now() >= deadline) {
        return { kind: "timeout" };
      }

      await sleep(pollIntervalMs);
    }
  }

  async inspect(handle: WorkerHandle): Promise<WorkerState> {
    if (existsSync(handle.resultFile)) return "finished";
    if (!handle.paneId) return "unknown";
    try {
      const result = await this.runHerdr(["agent", "get", handle.paneId]);
      const parsed = JSON.parse(result.stdout) as HerdrAgentGetResponse;
      if (parsed.error) return "dead";
      const status = parsed.result?.agent?.agent_status;
      if (status === "working") return "running";
      if (status === "idle" || status === "done") return "finished";
      if (status === "blocked") return "dead";
      return "unknown";
    } catch {
      return "dead";
    }
  }

  async cleanup(handle: WorkerHandle, opts: CleanupOpts): Promise<void> {
    const ws = handle.workspace;
    if (opts.pane === "close" && handle.paneId) {
      try {
        await this.runHerdr(["pane", "close", handle.paneId]);
      } catch {
        // best-effort
      }
    }
    if (opts.worktree === "remove") {
      try {
        await worktreeRemove(this.repoRoot, ws.worktreePath, true);
      } catch {
        // best-effort
      }
    }
    if (opts.branch === "remove") {
      try {
        await branchDelete(this.repoRoot, ws.branch, true);
      } catch {
        // best-effort
      }
    }
  }

  // --- Internal helpers ----------------------------------------------------

  private async runHerdr(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Use Bun.$ to avoid Bun's posix_spawn ENOENT bug (same fix as git.ts runInDir).
    // Bun.$ handles array interpolation with proper shell escaping.
    try {
      const result = await Bun.$`${this.herdrPath} ${args}`.quiet();
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
}

// --- Type helpers for herdr JSON responses --------------------------------

interface HerdrAgentStartResponse {
  id: string;
  result?: {
    type: string;
    agent?: {
      pane_id: string;
      terminal_id: string;
      workspace_id: string;
      agent_status: string;
    };
  };
  error?: { code: string; message: string };
}
interface HerdrPaneSplitResponse {
  id: string;
  result?: {
    pane?: {
      pane_id: string;
    };
  };
  error?: { code: string; message: string };
}

interface HerdrAgentGetResponse {
  id: string;
  result?: {
    agent?: {
      agent_status: string;
      revision: number;
      pane_id: string;
    };
  };
  error?: { code: string; message: string };
}

interface HerdrAgentReadResponse {
  id: string;
  result?: {
    read?: {
      text: string;
    };
  };
  error?: { code: string; message: string };
}

// --- Utility functions -----------------------------------------------------

function resolveOmpBinary(): string {
  // Use Bun.which to resolve 'omp' via PATH (handles bun run and bundled contexts).
  const resolved = Bun.which("omp");
  return resolved ?? "omp";
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
