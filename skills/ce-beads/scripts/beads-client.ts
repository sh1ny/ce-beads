// beads-client.ts — thin, typed wrapper over the `bd` CLI.
//
// Every other module talks to Beads through this client. All invocations
// receive an immutable child environment with the target BEADS_DIR (never
// mutate process.env — parallel tests would race). Graph-apply errors after
// the write boundary are classified `indeterminate` (KTD16): callers must
// re-query rather than assume nothing applied.
//
// Contract facts characterized against bd 1.1.0 (pinned SHA in
// UPSTREAMS.lock.json):
//   - create --json        -> single issue object
//   - list --json           -> array of issue-with-counts
//   - show --json           -> array with one detailed issue (deps, metadata, parent)
//   - graph apply --json    -> { ids: { key: id }, schema_version }
//   - graph dry-run --json  -> GraphApplyDryRun
//   - ready --json          -> array of issue-with-counts (epics included — filter --type task)
//   - update --json         -> array with one updated issue
//   - close --json          -> array with one closed issue
//   - dep list --json       -> flat array of dependency records
//   - dep add / dep remove  -> human text (no --json); classified by exit code

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Types: bd JSON output shapes -----------------------------------------

/** A Beads issue as returned by `bd create --json` / `bd update --json` (array element). */
export interface BeadsIssue {
  id: string;
  title: string;
  status: string;
  priority: number;
  issue_type: string;
  owner?: string;
  assignee?: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  closed_at?: string;
  close_reason?: string;
  started_at?: string;
  metadata?: Record<string, string>;
  labels?: string[];
  parent?: string;
  dependencies?: BeadsDependencySummary[];
  dependent_count?: number;
  dependency_count?: number;
  comment_count?: number;
}

/** A dependency summary embedded in a `show` result. */
export interface BeadsDependencySummary {
  id: string;
  title: string;
  status: string;
  priority: number;
  issue_type: string;
  dependency_type: string;
}

/** A dependency record from `bd dep list --json`. */
export interface BeadsDependencyRecord {
  id: string;
  title: string;
  status: string;
  priority: number;
  issue_type: string;
  dependency_type: string;
}

/** `bd create --graph --json` result: key → concrete Beads ID. */
export interface GraphApplyResult {
  ids: Record<string, string>;
  schema_version?: number;
}

/** `bd create --graph --dry-run --json` preview. */
export interface GraphApplyDryRun {
  dry_run: boolean;
  node_count: number;
  edge_count: number;
  parent_deps: number;
  validation_notes?: string[];
  nodes: GraphApplyDryRunRow[];
  schema_version?: number;
}

export interface GraphApplyDryRunRow {
  key: string;
  title: string;
  type: string;
  priority: number;
  parent_key?: string;
  parent_id?: string;
}

// --- Errors ----------------------------------------------------------------

export type BdErrorKind = "bd_missing" | "bd_failure" | "indeterminate";

export class BdError extends Error {
  constructor(
    readonly kind: BdErrorKind,
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
    readonly command: string,
  ) {
    super(message);
    this.name = "BdError";
  }
}

// --- Client options --------------------------------------------------------

export interface BeadsClientOptions {
  /** Path to the `bd` binary. Defaults to "bd" (resolved via PATH). */
  bdPath?: string;
  /** BEADS_DIR for this client's workspace. Required. */
  beadsDir: string;
  /** Cwd for `bd init` (must be a non-git temp root — KTD11). Defaults to beadsDir parent. */
  initCwd?: string;
  /** Extra env to merge into the child environment. */
  extraEnv?: Record<string, string>;
  /**
   * Minimum delay between successive `bd` invocations, in milliseconds.
   * bd's embedded Dolt engine starts/stops per process; rapid sequential
   * writes race on the NBS manifest and can panic (characterized against
   * bd 1.1.0). Default 60ms — large enough to avoid the race, small enough
   * not to dominate latency. Set 0 to disable.
   */
  interInvocationMs?: number;
}

// --- Client ----------------------------------------------------------------

/**
 * Immutable-env client over the `bd` CLI. Construct one per workspace;
 * every invocation spawns `bd` with a fresh child environment carrying only
 * BEADS_DIR plus the caller's PATH/etc. process.env.BEADS_DIR is never read
 * or mutated.
 */
export class BeadsClient {
  readonly beadsDir: string;
  private readonly bdPath: string;
  private readonly env: Record<string, string>;
  private readonly initCwd: string;
  private readonly interInvocationMs: number;
  private lastInvocationTime = 0;

  constructor(opts: BeadsClientOptions) {
    this.beadsDir = opts.beadsDir;
    this.bdPath = opts.bdPath ?? "bd";
    this.initCwd = opts.initCwd ?? join(opts.beadsDir, "..");
    this.interInvocationMs = opts.interInvocationMs ?? 60;
    // Build an immutable child environment. Start from a sanitized copy of
    // process.env, then force BEADS_DIR and disable bd's metrics flusher
    // (the detached send-metrics child races with the next bd invocation on
    // the same embedded-Dolt workspace — characterized against bd 1.1.0).
    this.env = { ...process.env, BEADS_DIR: opts.beadsDir, BD_DISABLE_METRICS: "1", ...opts.extraEnv };
  }

  /** Initialize the workspace with --stealth (KTD11). Idempotent. */
  async init(opts: { prefix?: string } = {}): Promise<void> {
    const args = [
      "init",
      "--non-interactive",
      "--init-if-missing",
      "--skip-agents",
      "--skip-hooks",
      "--stealth",
    ];
    if (opts.prefix) args.push("--prefix", opts.prefix);
    await this.runRaw(args, { cwd: this.initCwd });
  }

  // --- Create --------------------------------------------------------------

  /** `bd create --json` — single issue. */
  async create(params: {
    title: string;
    type?: string;
    description?: string;
    parent?: string;
    metadata?: Record<string, string>;
    labels?: string[];
  }): Promise<BeadsIssue> {
    const args = ["create", params.title, "--json"];
    if (params.type) args.push("--type", params.type);
    if (params.description) args.push("--description", params.description);
    if (params.parent) args.push("--parent", params.parent);
    if (params.metadata) {
      args.push("--metadata", JSON.stringify(params.metadata));
    }
    if (params.labels && params.labels.length > 0) {
      args.push("--labels", params.labels.join(","));
    }
    const out = await this.runJson<BeadsIssue | BeadsIssue[]>(args);
    // create returns a single object (not array); normalize.
    return Array.isArray(out) ? out[0]! : out;
  }

  /** `bd create --graph <file> --json` — returns key→id mapping. */
  async createGraph(graphFile: string, opts: { dryRun?: boolean } = {}): Promise<GraphApplyResult | GraphApplyDryRun> {
    const args = ["create", "--graph", graphFile];
    if (opts.dryRun) args.push("--dry-run");
    args.push("--json");
    if (opts.dryRun) {
      return await this.runJson<GraphApplyDryRun>(args);
    }
    // Live apply: an error after the write boundary is indeterminate.
    try {
      return await this.runJson<GraphApplyResult>(args);
    } catch (e) {
      if (e instanceof BdError && e.kind === "bd_failure") {
        // The graph-apply transaction commits per-node before the final Dolt
        // boundary; a late error means some writes may have landed.
        throw new BdError(
          "indeterminate",
          `Graph apply failed after write boundary; re-query to determine actual state: ${e.message}`,
          e.stderr,
          e.exitCode,
          e.command,
        );
      }
      throw e;
    }
  }

  // --- Read ----------------------------------------------------------------

  /** `bd list --json` with full filter control. */
  async list(params: {
    all?: boolean;
    limit?: number;
    type?: string;
    status?: string;
    parent?: string;
    noParent?: boolean;
    flat?: boolean;
    metadataField?: string[];
    label?: string[];
  }): Promise<BeadsIssue[]> {
    const args = ["list", "--json"];
    if (params.all) args.push("--all");
    if (params.limit !== undefined) args.push("--limit", String(params.limit));
    if (params.type) args.push("--type", params.type);
    if (params.status) args.push("--status", params.status);
    if (params.parent) args.push("--parent", params.parent);
    if (params.noParent) args.push("--no-parent");
    if (params.flat) args.push("--flat");
    for (const mf of params.metadataField ?? []) {
      args.push("--metadata-field", mf);
    }
    for (const lb of params.label ?? []) {
      args.push("--label", lb);
    }
    const out = await this.runJson<BeadsIssue[] | BeadsIssue>(args);
    return Array.isArray(out) ? out : [out];
  }

  /**
   * Binding-enumeration primitive (KTD8): `bd list --json --all --limit 0`
   * with metadata filters. Returns ALL matching issues including closed.
   */
  async enumerateBinding(planPath: string): Promise<BeadsIssue[]> {
    return this.list({
      all: true,
      limit: 0,
      flat: true,
      metadataField: [
        "integration=ce-beads/v1",
        `ce_plan_path=${planPath}`,
      ],
    });
  }

  /** `bd show --json` — detailed issue with dependencies, metadata, parent. */
  async show(issueId: string): Promise<BeadsIssue | null> {
    const out = await this.runJson<BeadsIssue[] | { error: string }>(["show", issueId, "--json"]);
    if (Array.isArray(out)) {
      return out[0] ?? null;
    }
    // Error shape: { error: "...", schema_version: 1 }
    if ("error" in out) return null;
    return out;
  }

  /**
   * Filtered readiness query (R6): `bd ready --json --limit 0 --type task`
   * with binding metadata filters. Never returns the epic (type filter
   * excludes epics) or blocked tasks.
   */
  async readyTasks(planPath: string): Promise<BeadsIssue[]> {
    const args = [
      "ready",
      "--json",
      "--limit",
      "0",
      "--type",
      "task",
      "--metadata-field",
      "integration=ce-beads/v1",
      "--metadata-field",
      `ce_plan_path=${planPath}`,
    ];
    const out = await this.runJson<BeadsIssue[] | BeadsIssue>(args);
    return Array.isArray(out) ? out : [out];
  }

  /** Parent-child enumeration (KTD9): all children of `epicId`, including closed. */
  async children(epicId: string): Promise<BeadsIssue[]> {
    return this.list({ all: true, flat: true, parent: epicId, limit: 0 });
  }

  /** Top-level issues (epics + orphans). */
  async topLevel(): Promise<BeadsIssue[]> {
    return this.list({ flat: true, noParent: true, limit: 0 });
  }

  // --- Dependencies --------------------------------------------------------

  /** `bd dep add <dependent> <blocker> --type blocks`. */
  async depAdd(dependentId: string, blockerId: string, type: string = "blocks"): Promise<void> {
    await this.runRaw(["dep", "add", dependentId, blockerId, "--type", type]);
  }

  /** `bd dep remove <dependent> <blocker>`. */
  async depRemove(dependentId: string, blockerId: string): Promise<void> {
    await this.runRaw(["dep", "remove", dependentId, blockerId]);
  }

  /** `bd dep list <id> --json` — what this issue depends on. */
  async depList(issueId: string): Promise<BeadsDependencyRecord[]> {
    const out = await this.runJson<BeadsDependencyRecord[] | BeadsDependencyRecord>(
      ["dep", "list", issueId, "--json"],
    );
    return Array.isArray(out) ? out : [out];
  }

  // --- Update / close / label ----------------------------------------------

  /** `bd update` with set-metadata, add-label, remove-label, claim, status. */
  async update(issueId: string, params: {
    description?: string;
    setMetadata?: Record<string, string>;
    unsetMetadata?: string[];
    addLabel?: string[];
    removeLabel?: string[];
    claim?: boolean;
    status?: string;
    /** Assignee; empty string clears the assignee (requires --status to take effect). */
    assignee?: string;
  }): Promise<BeadsIssue> {
    const args = ["update", issueId, "--json"];
    if (params.description) args.push("--description", params.description);
    for (const [k, v] of Object.entries(params.setMetadata ?? {})) {
      args.push("--set-metadata", `${k}=${v}`);
    }
    for (const k of params.unsetMetadata ?? []) {
      args.push("--unset-metadata", k);
    }
    for (const lb of params.addLabel ?? []) {
      args.push("--add-label", lb);
    }
    for (const lb of params.removeLabel ?? []) {
      args.push("--remove-label", lb);
    }
    if (params.claim) args.push("--claim");
    if (params.status) args.push("--status", params.status);
    if (params.assignee !== undefined) args.push("--assignee", params.assignee);
    const out = await this.runJson<BeadsIssue[] | BeadsIssue>(args);
    return Array.isArray(out) ? out[0]! : out;
  }

  /** `bd close <id> --json`. */
  async close(issueId: string): Promise<BeadsIssue> {
    const out = await this.runJson<BeadsIssue[] | BeadsIssue>(["close", issueId, "--json"]);
    return Array.isArray(out) ? out[0]! : out;
  }

  /** `bd --version`. */
  async version(): Promise<string> {
    const out = await this.runRaw(["--version"], { captureOnly: true });
    return out.stdout.trim();
  }

  // --- Internals -----------------------------------------------------------

  private async runJson<T>(args: string[]): Promise<T> {
    const result = await this.spawn(args);
    if (result.exitCode !== 0) {
      throw new BdError(
        "bd_failure",
        `bd ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.trim()}`,
        result.stderr,
        result.exitCode,
        `bd ${args.join(" ")}`,
      );
    }
    const stdout = result.stdout.trim();
    if (stdout === "") return undefined as unknown as T;
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new BdError(
        "bd_failure",
        `bd ${args.join(" ")} produced non-JSON stdout: ${stdout.slice(0, 200)}`,
        result.stderr,
        result.exitCode,
        `bd ${args.join(" ")}`,
      );
    }
  }

  private async runRaw(
    args: string[],
    opts: { cwd?: string; captureOnly?: boolean } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await this.spawn(args, opts);
    if (!opts.captureOnly && result.exitCode !== 0) {
      throw new BdError(
        "bd_failure",
        `bd ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.trim()}`,
        result.stderr,
        result.exitCode,
        `bd ${args.join(" ")}`,
      );
    }
    return result;
  }

  private async spawn(
    args: string[],
    opts: { cwd?: string; captureOnly?: boolean } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    await this.pace();
    const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number }>();
    const child = spawn(this.bdPath, args, {
      cwd: opts.cwd ?? this.initCwd,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new BdError(
            "bd_missing",
            `bd binary not found at '${this.bdPath}' (ENOENT)`,
            err.message,
            null,
            `bd ${args.join(" ")}`,
          ),
        );
      } else {
        reject(err);
      }
    });
    child.on("close", (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
    return promise;
  }

  /** Enforce the minimum inter-invocation delay (KTD: embedded Dolt NBS race). */
  private async pace(): Promise<void> {
    if (this.interInvocationMs <= 0) return;
    const now = Date.now();
    const elapsed = now - this.lastInvocationTime;
    if (elapsed < this.interInvocationMs) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, this.interInvocationMs - elapsed);
      await promise;
    }
    this.lastInvocationTime = Date.now();
  }
}


// --- Workspace helper (KTD11) ---------------------------------------------

/**
 * Isolated Beads workspace for tests. Creates a temp directory, initializes a
 * stealth Beads workspace there with cwd set to the temp root (so init's
 * `.git/info/exclude` side effect never touches the dev repo), and returns a
 * client plus cleanup. The development repository's real `.beads` is
 * unreachable because BEADS_DIR takes precedence over tree discovery
 * (KTD11, verified against internal/beads/beads.go).
 */
export interface IsolatedWorkspace {
  client: BeadsClient;
  dir: string;
  cleanup: () => Promise<void>;
}

export function createIsolatedWorkspace(opts: { prefix?: string } = {}): IsolatedWorkspace {
  const dir = mkdtempSync(join(tmpdir(), "ce-beads-test-"));
  const beadsDir = join(dir, ".beads");
  const client = new BeadsClient({
    beadsDir,
    initCwd: dir,
  });
  // Synchronous init is not available; tests must await client.init().
  return {
    client,
    dir,
    cleanup: async () => {
      // Wait for any lingering bd/Dolt processes to release the workspace
      // before removing the temp directory. The embedded Dolt server tears
      // down asynchronously after the bd process exits; removing the dir
      // while a teardown is in flight produces "context canceled" on the
      // next workspace's first query.
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 300);
      await promise;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}
