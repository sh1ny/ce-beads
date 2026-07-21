# ce-beads-work Serial Orchestrator — Implementation Plan

Implementation-ready plan for the `ce-beads-work` serial orchestrator milestone.
Enriches `docs/plans/2026-07-21-001-feat-ce-beads-work-serial-orchestrator.md`
(the brief). All settled decisions SD1–SD8 are final and are not relitigated
here. This document resolves the brief's open questions, pins exact
interfaces, and sequences the build so a builder agent can execute without
further design decisions.

**Branch:** `feature/ce-orchestrate` only. Never commit to main. Stop with a
human notice at the end (SD8).

---

## 0. Resolutions of the brief's open questions

These were open in the brief; they are now decided. Rationale is grounded in
the existing code and in live CLI surface checks (omp v17.0.6, herdr, bd 1.1.0).

### R1 — Integration-branch naming

- Integration branch: `ce-beads/<plan-slug>-<run-id>`
- Worker branch (per unit): `ce-beads/<U-ID>-<run-id>`
- Worktree root: `${TMPDIR:-/tmp}/ce-beads-wt/` with per-unit worktree
  `<U-ID>-<run-id>` and one integration worktree `integration-<run-id>`.
- `plan-slug`: plan file basename without extension, lowercased, every run of
  non-`[a-z0-9]` collapsed to a single `-` (e.g. `02-linear-three-unit`).
- `run-id` format: `YYYYMMDD-HHMMSS-<6 lowercase hex>` (UTC timestamp +
  `crypto.randomBytes(3)`), e.g. `20260721-143022-a1b2c3`. Sortable,
  human-readable, collision-safe.

This matches the run-state example in the brief exactly.

### R2 — `run reap` is in scope

It is safety-net code, but it is small, fully specified below, and the crash
recovery path genuinely needs it (orphaned pane/worktree mappings). Include.

### R3 — Worker report transport: durable file + sentinel (both)

- The worker writes its structured report to a durable file inside the
  worktree: `.ce-beads-worker/result.json`.
- The worker prints the nonce sentinel `CE_BEADS_RESULT:<run-id>:<U-ID>` on
  its own line in pane output as the completion signal.
- The adapter treats the **sentinel as authoritative for completion** and the
  **file as authoritative for the report**. If the file is missing/unreadable
  after the sentinel, the adapter falls back to parsing the JSON block printed
  after the sentinel in pane output (`herdr pane read --source
  recent-unwrapped`). If both fail: `WORKER_REPORT_INVALID`, unit blocked.

Rationale: scraping scrollback alone is fragile (wrap, truncation); a file
alone gives no completion signal. The two-path design mirrors the brief's
lifecycle/sentinel duality.

### R4 — Worker model role: static `@smol`

`@smol` (MiniMax-M3 on the `chinese` profile) is the single default worker
role, stored in `HerdrRuntime` options (`model: "@smol"`). Complexity-based
`@tiny` selection is an explicit refinement and is NOT built. The role is a
constructor option so tests and future refinements can override it.

### R5 — Worker boundary enforcement mechanism (gap in the brief, resolved)

The brief mandates `.omp/agents/ce-beads-unit.md`, but omp v17.0.6 has **no
`--agent` flag for a top-level session** — `.omp/agents/*.md` files are
task-tool agent definitions only (confirmed: `omp agents` supports only
`unpack`; `omp --help` lists no agent-selection flag). Enforcement is
therefore **dual**:

1. **Author `.omp/agents/ce-beads-unit.md`** exactly as the brief specifies
   (committed to the repo). This is the canonical agent definition and is used
   when the worker runs as a `task` subagent (e.g. the inline fallback path in
   constraint 5, or future non-Herdr runtimes).
2. **The Herdr pane launch physically enforces the same boundary via CLI
   flags**: `omp --profile chinese --model @smol --no-session
   --tools read,grep,glob,bash,edit,write,lsp,ast_grep
   --append-system-prompt @<worker-system-prompt-file>`. The `--tools`
   whitelist excludes `task` (no recursive spawning) and every other
   built-in not listed. The system-prompt file is generated from the same
   instruction body as the agent file.

A packaging test asserts the launcher's tool whitelist equals the agent
file's frontmatter `tools:` list and that neither contains `task`.

Defense-in-depth fact (verified against the repo layout): worker worktrees
live under `/tmp/ce-beads-wt/`, outside the repo tree, so `bd` invoked by a
misbehaving worker via `bash` would NOT discover the repo's `.beads`
(BEADS_DIR tree discovery walks parents). The worker physically cannot reach
the real Beads graph from its worktree even through `bash`.

Build-phase verification step: run the exact launch command once with `-p
"ok"` during acceptance preflight to confirm `--tools` accepts the names
`lsp` and `ast_grep`. If either name is rejected, drop it from the CLI list
only (they are additive conveniences; the boundary is defined by what is
excluded). The consistency test then asserts CLI list ⊆ agent-file list.

### R6 — Where the control loop lives: the TS engine, driven by `run start` / `run resume`

The brief lists only five CLI actions (`packet`, `run start/status/resume/
reap`) and describes the loop as coordinator behavior. Reconciled: the full
loop state machine (claim → launch → wait → integrate → verify → close) is
implemented once in a TypeScript engine (`orchestrator.ts`). Both `run start`
and `run resume` invoke the same driver:

- Default (no flags): drive the loop to quiescence — outcome `completed`
  (all units closed), `blocked` (a unit failed verification / report invalid;
  loop stops, human intervenes), or `failed` (infrastructure failure; run-state
  intact, `run resume` continues).
- `--once` flag: execute exactly one loop iteration and return
  `in_progress` / `awaiting_integration` / `completed` / `blocked`. Used by
  automated tests with the mock runtime and available to the coordinator
  agent for stepwise driving.

This keeps integrate-before-close **inside deterministic code**, not in
advisory prompt text. The coordinator OMP agent (guided by
`skills/ce-beads-work/SKILL.md`) is a thin driver: preflight → `run start` →
monitor → `run resume` on crash → STOP at the shipping boundary.

### R7 — Integration happens in a dedicated integration worktree, never the user's checkout

The coordinator runs inside the user's working tree; merging there would
hijack the user's checkout. `run start` creates the integration branch and
checks it out in `<worktreeRoot>/integration-<run-id>` via `git worktree add
<path> -b ce-beads/<slug>-<run-id> HEAD`. All merges and post-merge
integration verification run in that worktree.

### R8 — Verification commands executed

- **Pre-merge (per unit)**: the unit's `verification: string[]` commands from
  the plan IR, run sequentially via `bash -c` in the unit's worker worktree.
  Any non-zero exit → `VERIFICATION_FAILED`, unit blocked, NOT merged, NOT
  closed.
- **Post-merge (integration)**: the same unit's verification commands re-run
  in the integration worktree after `git merge --no-ff`. Any non-zero exit →
  `INTEGRATION_FAILED`, unit blocked, merge left in place for human
  inspection, task NOT closed.
- The plan-level "Verification Contract" table is NOT parsed (plan-parser
  does not extract it). Only unit-level `verification` fields are executed.
  This is a known, documented limitation; parsing the table is out of scope.

---

## 1. Dependency-ordered build sequence

Each step lists exact paths. Steps are ordered so every file's imports already
exist. All new code lives under `skills/ce-beads-work/scripts/` except the
normative protocol and CLI dispatch, which live in `skills/ce-beads/scripts/`
(single normative source rule — the CLI surface stays `ce-beads`; the new
skill's modules import `../../ce-beads/scripts/*.ts`, mirroring how
`tests/helpers/beads-workspace.ts` already imports across the tree).

| # | Path | Kind | Depends on |
|---|------|------|------------|
| 1 | `skills/ce-beads/scripts/protocol.ts` | modify: extend `Action`, add `PacketOutcome`/`RunOutcome`, 10 new `DiagnosticCode`s, extend `exitCodeFor` | — |
| 2 | `skills/ce-beads-work/scripts/worker-packet.ts` | create: `WorkerPacket` types + `buildWorkerPacket()` | 1 |
| 3 | `skills/ce-beads-work/scripts/packet.ts` | create: `packet` action handler | 1, 2 |
| 4 | `skills/ce-beads-work/scripts/worker-report.ts` | create: `WorkerReport` schema + `validateWorkerReport()` + sentinel helpers | — |
| 5 | `skills/ce-beads-work/scripts/run-state.ts` | create: run-state schema + load/save/list/refuse-active | — |
| 6 | `skills/ce-beads-work/scripts/git.ts` | create: minimal git helpers (worktree add/remove, branch, merge, diff, rev-parse, run-in-dir) | — |
| 7 | `skills/ce-beads-work/scripts/runtimes/runtime.ts` | create: `AgentRuntime` interface + `Workspace`/`WorkerHandle`/`WorkerResult`/`WorkerState` | 4 |
| 8 | `skills/ce-beads-work/scripts/runtimes/mock.ts` | create: `MockRuntime` (scripted, real git worktrees, no Herdr) | 6, 7 |
| 9 | `skills/ce-beads-work/scripts/orchestrator.ts` | create: `RunEngine` — the loop + integrate-before-close state machine | 1, 2, 4, 5, 6, 7 |
| 10 | `skills/ce-beads-work/scripts/runtimes/herdr.ts` | create: `HerdrRuntime` | 6, 7 |
| 11 | `skills/ce-beads-work/scripts/run.ts` | create: `run` action handler (start/status/resume/reap → engine) | 1, 5, 9, 10 |
| 12 | `skills/ce-beads/scripts/cli.ts` | modify: extend `CliArgs`/`parseArgs`/`usageMessage`/`main` dispatch for `packet` + `run` | 1, 3, 11 |
| 13 | `skills/ce-beads-work/scripts/worker-prompt.ts` | create: worker system-prompt body (single source) + `renderWorkerPrompt()` | 2, 4 |
| 14 | `.omp/agents/ce-beads-unit.md` | create: bundled worker agent (committed) | 13 |
| 15 | `skills/ce-beads-work/SKILL.md` | create: coordinator skill instructions | 11, 12, 14 |
| 16 | `tests/fixtures/plans/17-work-failing-verification.md` | create fixture | — |
| 17 | `tests/fixtures/worker-reports/{valid-complete,valid-blocked,invalid-missing-fields,invalid-bad-status,invalid-not-json}.json` | create fixtures | — |
| 18 | `tests/packet.test.ts` | create | 3 |
| 19 | `tests/run-state.test.ts` | create | 5 |
| 20 | `tests/worker-report.test.ts` | create | 4, 17 |
| 21 | `tests/orchestrator.test.ts` | create: mock-runtime loop, integrate-before-close invariant, crash recovery, blocked path, reap | 8, 9, 16 |
| 22 | `tests/cli.test.ts` | modify: arg-parsing cases for `packet`/`run` | 12 |
| 23 | `tests/packaging.test.ts` | modify: assert ce-beads-work skill layout + agent-file/launcher tool-whitelist consistency | 13, 14, 15 |
| 24 | `.gitignore` | modify: add `.ce-beads/` | — |
| 25 | `README.md` + `docs/acceptance.md` | modify: document the two new actions + acceptance section (docs.test.ts conventions) | 12, 15 |

Notes:

- Steps 1–9 are pure TS, no Herdr — fully testable in CI (SD1 scope).
- Step 10 (Herdr adapter) is only smoke-tested manually (brief: real-Herdr
  integration is exercised in the manual acceptance test, not automated
  tests).
- Existing `bind/status/sync/doctor` tests must remain green throughout
  (run `bun run verify` after steps 1, 12, and at the end).
- `package.json` needs **no changes**: `files: ["skills/", ...]` already
  covers the new skill directory; `bin` still points at the extended
  `ce-beads` CLI.

---

## 2. Exact TypeScript interfaces

All interfaces below follow the existing style: JSDoc on every exported
member, no `any`, string-valued metadata (KTD10), immutable inputs.

### 2.1 `worker-packet.ts` — worker packet shape

```ts
// worker-packet.ts — bounded worker packet: everything a ce-beads-unit worker
// needs to implement exactly one unit, and nothing about coordination.

import type { CePlan, CeUnit } from "../../ce-beads/scripts/plan-parser.ts";

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
  /** Beads task ID for the unit, informational only; null when unbound. */
  beads_id: string | null;
  /** Base SHA the worker branch forks from; null when standalone. */
  base_sha: string | null;
  /** Worker branch name; null when standalone. */
  branch: string | null;
  /** Absolute worktree path; null when standalone. */
  worktree_path: string | null;
  /** Exact sentinel line the worker must print when done. */
  sentinel: string;
  /** Worktree-relative path the worker must write its report to. */
  result_file: string;
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
  execution_note?: string;
  technical_design?: string;
  patterns: string[];
  test_scenarios: string[];
  verification: string[];
}

/** Slug for branch naming (R1). */
export function planSlug(planPath: string): string;

/** The sentinel line for a run + unit: `CE_BEADS_RESULT:<run-id>:<U-ID>`. */
export function sentinelFor(runId: string, unitId: string): string;

/** Build a packet from a parsed plan + unit. Run fields null when standalone. */
export function buildWorkerPacket(
  plan: CePlan,
  unit: CeUnit,
  opts: {
    runId?: string;
    beadsId?: string;
    baseSha?: string;
    branch?: string;
    worktreePath?: string;
  } = {},
): WorkerPacket;
```

### 2.2 `worker-report.ts` — worker report schema

```ts
// worker-report.ts — structured report the worker returns; validated strictly.

export const WORKER_REPORT_SCHEMA_VERSION = "ce-beads-worker-report/1" as const;
export const WORKER_RESULT_FILE = ".ce-beads-worker/result.json" as const;
export const WORKER_SYSTEM_PROMPT_FILE = ".ce-beads-worker/system-prompt.md" as const;

export type WorkerStatus = "complete" | "blocked" | "failed";

export interface WorkerReport {
  schema_version: typeof WORKER_REPORT_SCHEMA_VERSION;
  u_id: string;
  status: WorkerStatus;
  changed_files: string[];
  verification_evidence: {
    commands: string[];
    results: string;
  };
  /** Empty string when status is not "blocked". */
  blockers: string;
  notes?: string;
}

export type WorkerReportValidation =
  | { ok: true; report: WorkerReport }
  | { ok: false; error: string };

/**
 * Strict structural validation (no schema lib, matching repo conventions):
 * checks schema_version, required keys, types, enum membership, and that
 * `blockers` is non-empty iff status === "blocked". Rejects unknown
 * `schema_version` and non-object input.
 */
export function validateWorkerReport(value: unknown): WorkerReportValidation;

/** Extract the JSON object printed after the sentinel line in pane output. */
export function parseReportFromPaneOutput(
  output: string,
  sentinel: string,
): unknown | null;
```

### 2.3 `run-state.ts` — run-state file schema

```ts
// run-state.ts — the ONLY coordinator-local state (SD7: plans immutable,
// task state in Beads). Gitignored at .ce-beads/run-<run-id>.json.

export const RUN_STATE_SCHEMA_VERSION = "ce-beads-run/1" as const;
export const RUN_STATE_DIR = ".ce-beads" as const;

export type RunStatus = "in_progress" | "blocked" | "completed" | "failed";

/**
 * Per-unit lifecycle. Matches the brief's task lifecycle, compressed to the
 * states the engine persists (transient reviewed/committed/verified states
 * never survive a crash, so they are not persisted):
 *   pending → claimed → awaiting-integration → closed
 *                  ↘ blocked (verification/report/worker failure)
 */
export type UnitRunState =
  | "pending"
  | "claimed"
  | "awaiting-integration"
  | "blocked"
  | "closed";

export interface RunUnitRecord {
  beads_id: string;
  state: UnitRunState;
  worker_pane_id: string | null;
  worker_branch: string | null;
  worktree_path: string | null;
  claimed_at: string | null;
  integrated_sha: string | null;
  result: WorkerReport | null;
}

export interface RunState {
  schema_version: typeof RUN_STATE_SCHEMA_VERSION;
  run_id: string;
  plan_path: string;
  plan_digest: string;
  base_sha: string;
  integration_branch: string;
  integration_worktree: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  units: Record<string, RunUnitRecord>; // keyed by U-ID, full plan roster
}

export function newRunId(now?: Date): string;               // R1 format
export function runStatePath(runId: string, repoRoot?: string): string;
export function saveRunState(state: RunState, repoRoot?: string): void; // atomic: tmp + rename
export function loadRunState(runId: string, repoRoot?: string): RunState; // throws RUN_STATE_CORRUPT / RUN_NOT_FOUND
export function listRunIds(repoRoot?: string): string[];    // sorted, newest last
export function latestRunId(repoRoot?: string): string | null;
/** Non-terminal run for the same plan, if any (run start refuses — RUN_ACTIVE). */
export function findActiveRunForPlan(planPath: string, repoRoot?: string): RunState | null;
```

### 2.4 `runtimes/runtime.ts` — the AgentRuntime interface

Verbatim from the brief, with the supporting types pinned:

```ts
// runtimes/runtime.ts — pluggable worker runtime. HerdrRuntime is the
// production implementation; MockRuntime drives deterministic CI tests.

import type { CeUnit } from "../../../ce-beads/scripts/plan-parser.ts";
import type { RunState } from "../run-state.ts";
import type { WorkerReport } from "../worker-report.ts";

export interface Workspace {
  unitId: string;
  worktreePath: string;   // absolute
  branch: string;         // ce-beads/<U-ID>-<run-id>
}

export interface WorkerHandle {
  paneId: string;         // Herdr pane id ("wN:pM"); "mock" for MockRuntime
  workspace: Workspace;
  sentinel: string;       // CE_BEADS_RESULT:<run-id>:<U-ID>
  resultFile: string;     // absolute path to .ce-beads-worker/result.json
  startedAt: string;      // ISO
}

export interface WaitOpts {
  /** Max wall-clock wait before { kind: "timeout" }. */
  timeoutMs: number;
  /** Poll interval; default 2000. */
  pollIntervalMs?: number;
}

export type WorkerResult =
  | { kind: "sentinel"; report: WorkerReport; outputTail: string }
  | { kind: "timeout" }
  | { kind: "died"; reason: string };

export type WorkerState = "running" | "finished" | "dead" | "unknown";

export interface AgentRuntime {
  /** Create the unit worktree + branch from run.base_sha. */
  createWorkspace(unit: CeUnit, run: RunState): Promise<Workspace>;
  /** Launch the worker session and deliver the prompt. */
  startWorker(ws: Workspace, prompt: string): Promise<WorkerHandle>;
  /** Two-path completion wait: lifecycle fast-path + sentinel (authoritative). */
  wait(handle: WorkerHandle, opts: WaitOpts): Promise<WorkerResult>;
  /** Non-blocking state probe; used by crash recovery. */
  inspect(handle: WorkerHandle): Promise<WorkerState>;
  /** Close pane (if any), remove worktree, delete branch. Never touches Beads. */
  cleanup(ws: Workspace): Promise<void>;
}
```

### 2.5 `runtimes/herdr.ts` — HerdrRuntime

```ts
// runtimes/herdr.ts — production runtime over the Herdr CLI.
// Follows skill://herdr-omp-model-launch exactly: split → rename → launch →
// poll agent detection → welcome-screen API-key check → send prompt →
// two-path completion observation.

export interface HerdrRuntimeOptions {
  /** Repo root the coordinator runs in (for git worktree operations). */
  repoRoot: string;
  /** Worktree root; default `${TMPDIR:-/tmp}/ce-beads-wt`. */
  worktreeRoot?: string;
  /** Worker model role; default "@smol" (R4). Resolved per-profile by omp. */
  model?: string;
  /** OMP profile; default "chinese" (SD3). Always passed as --profile. */
  profile?: string;
  /** herdr binary; default "herdr" (PATH). */
  herdrPath?: string;
  /** Worker wait timeout; default 30 min. */
  workerTimeoutMs?: number;
}

/** Tool whitelist enforced via `omp --tools` (R5). Mirrors the agent file. */
export const HERDR_WORKER_TOOLS = [
  "read", "grep", "glob", "bash", "edit", "write", "lsp", "ast_grep",
] as const;

export class HerdrRuntime implements AgentRuntime {
  constructor(opts: HerdrRuntimeOptions);
  createWorkspace(unit: CeUnit, run: RunState): Promise<Workspace>;
  startWorker(ws: Workspace, prompt: string): Promise<WorkerHandle>;
  wait(handle: WorkerHandle, opts: WaitOpts): Promise<WorkerResult>;
  inspect(handle: WorkerHandle): Promise<WorkerState>;
  cleanup(ws: Workspace): Promise<void>;
}
```

Implementation contract (exact command sequences; every herdr invocation
parses the `{"id":…,"result":…}` JSON envelope):

- `createWorkspace`: `git worktree add <worktreeRoot>/<U-ID>-<run-id>
  -b ce-beads/<U-ID>-<run-id> <run.base_sha>` (plain git — the brief's own
  Herdr command list has no worktree verbs; FS state must not depend on a
  live Herdr server). Then `mkdir .ce-beads-worker/` inside the worktree and
  write `system-prompt.md` (from `worker-prompt.ts`) and `packet.json`.
- `startWorker`:
  1. `herdr pane split --current --direction right --no-focus` → parse
     `result.pane_id` (fall back to `down` on failure, per the skill's
     layout guidance).
  2. `herdr pane rename <pane_id> "ce-beads-<U-ID>-<run-id>"`.
  3. `herdr pane run <pane_id> 'cd <worktree> && omp --profile chinese
     --model @smol --no-session --tools read,grep,glob,bash,edit,write,lsp,ast_grep
     --append-system-prompt @.ce-beads-worker/system-prompt.md'`.
  4. Poll `herdr pane get <pane_id>` up to 20s until
     `result.pane.agent` is non-null (cold-start tolerance — the skill
     documents 5–10s).
  5. `herdr pane read <pane_id> --source visible --lines 12`; if it contains
     `No API key found` → close pane, throw (caller maps to
     `RUNTIME_FAILURE` → outcome `failed`).
  6. Deliver the prompt: `herdr pane run <pane_id> '<rendered prompt>'`
     (prompt includes the sentinel instruction and result-file path; see
     §3). Never treat the pre-prompt `idle` as completion (skill gotcha).
- `wait`: loop until `opts.timeoutMs`:
  - Deterministic path (authoritative): `herdr pane read <pane_id>
    --source recent-unwrapped --lines 400`; if it contains the sentinel →
    read `handle.resultFile`; validate via `validateWorkerReport`; on file
    miss/invalid → `parseReportFromPaneOutput` fallback; on total failure →
    `{ kind: "died", reason: "sentinel without valid report" }` (engine maps
    to `WORKER_REPORT_INVALID`, blocked).
  - Fast path: `herdr pane get <pane_id>`; `agent_status` transition
    `working → idle` triggers an immediate sentinel check (never trust
    lifecycle alone — it lags, and pre-prompt `idle` is meaningless).
  - Pane gone (`pane get` non-zero / parse error) before sentinel →
    `{ kind: "died", reason: <stderr> }`.
- `inspect`: `herdr pane get` → pane missing → `dead`; sentinel in recent
  output → `finished`; `agent_status === "working"` → `running`; else
  `unknown`.
- `cleanup`: `herdr pane close <paneId>` (best-effort), `git worktree remove
  --force <path>`, `git branch -D <branch>`. Only ever called for
  failed/orphaned units — never before integration (the worker branch
  carries the commits being merged).

### 2.6 `orchestrator.ts` — the RunEngine

```ts
// orchestrator.ts — serial control loop + integrate-before-close state
// machine. Runtime-agnostic: constructed with any AgentRuntime.

export interface RunEngineOptions {
  repoRoot: string;
  beadsDir: string;                 // default join(repoRoot, ".beads")
  runtime: AgentRuntime;
  /** Worker wait timeout forwarded to runtime.wait; default 30 min. */
  workerTimeoutMs?: number;
}

export class RunEngine {
  constructor(opts: RunEngineOptions);

  /**
   * run start: parse plan → verify binding (NOT_BOUND refusal if unbound;
   * the coordinator agent runs the existing `bind` preview→approval→apply
   * flow first) → refuse on active run for the plan (RUN_ACTIVE) →
   * create integration branch + integration worktree → write run-state →
   * drive loop (all iterations, or one with opts.once).
   */
  start(planPath: string, opts?: { once?: boolean }): Promise<ProtocolEnvelope>;

  /**
   * run resume: load run-state → reconcile in-flight unit via
   * runtime.inspect (running → wait; sentinel → continue at integration;
   * dead without sentinel → cleanup + mark blocked + report) → drive loop.
   */
  resume(runId: string, opts?: { once?: boolean }): Promise<ProtocolEnvelope>;

  /** Read-only snapshot: run-state + live ready-count cross-check. */
  status(runId?: string): Promise<ProtocolEnvelope>;

  /**
   * run reap: refuse (RUN_ACTIVE) if run-state.status === "in_progress"
   * unless opts.force. For each non-closed unit with workspace records:
   * runtime.cleanup. Removes the integration worktree. NEVER closes,
   * updates, or otherwise mutates Beads tasks. Marks run-state "failed".
   */
  reap(runId: string, opts?: { force?: boolean }): Promise<ProtocolEnvelope>;
}
```

The loop (one iteration; mirrors the brief's control loop §2–3):

```text
1. readyTasks = client.readyTasks(plan.path)            // existing beads-client method
   inFlight = units in run-state with state claimed|awaiting-integration
2. If inFlight has an awaiting-integration unit → go to INTEGRATE (step 5).
3. If no inFlight and readyTasks empty → all closed? verify roster:
   every run-state unit closed → outcome completed (status=completed,
   finished_at, report integration SHA); else outcome blocked (nothing
   ready, nothing in flight, units remain — dependency wedge).
4. CLAIM: take readyTasks[0] mapped to its U-ID via metadata ce_unit_id;
   client.update(id, { claim: true }); persist state "claimed",
   claimed_at. Build packet (buildWorkerPacket). runtime.createWorkspace →
   runtime.startWorker → persist pane/worktree/branch. runtime.wait:
   - sentinel → persist result; client.update(id, { setMetadata:
     { ce_beads_run_state: "awaiting-integration" }, addLabel:
     ["ce-beads:awaiting-integration"] }); state → "awaiting-integration".
   - timeout|died → runtime.cleanup; client.update(id, { setMetadata:
     { ce_beads_run_state: "blocked" }, addLabel: ["ce-beads:blocked"] });
     state → "blocked"; run-state status "failed" (died) or "blocked"
     (timeout); return outcome failed|blocked with WORKER_FAILED.
5. INTEGRATE (coordinator-owned, integrate-before-close):
   a. report.status !== "complete" → mark blocked (WORKER_FAILED or
      worker-reported blockers), do not merge, do not close.
   b. Inspect diff: git diff --stat <base>..<worker-branch> (recorded in
      diagnostics as info; empty diff + status complete → WORKER_FAILED).
   c. Run the unit's verification commands sequentially (bash -c, cwd =
      unit worktree). Non-zero → VERIFICATION_FAILED, mark blocked.
   d. git -C <integration-worktree> merge --no-ff <worker-branch>.
      Conflict → INTEGRATION_FAILED, mark blocked (merge left for human).
   e. Re-run the unit's verification commands in the integration worktree.
      Non-zero → INTEGRATION_FAILED, mark blocked.
   f. ONLY NOW: client.close(beads_id); state → "closed";
      integrated_sha = git rev-parse HEAD in the integration worktree;
      runtime.cleanup(unit workspace).
6. Return per --once semantics; otherwise loop.
```

Marking helpers use only existing `BeadsClient.update` (setMetadata /
addLabel / claim) and `BeadsClient.close` — no new bd surface. The
"awaiting integration" state is `in_progress` + metadata/label, exactly as
the brief's state machine requires.

### 2.7 CLI action handler data payloads

```ts
// packet.ts
export interface PacketData {
  planPath: string;
  planDigest: string;
  unitId: string;
  beadsId: string | null;   // resolved from binding when present
  packet: WorkerPacket;
}
export const handler: ActionHandler; // run(args) → packetAction(args)

// run.ts
export interface RunUnitSummary {
  beadsId: string;
  state: UnitRunState;
  integratedSha: string | null;
}
export interface RunData {
  runId: string;
  planPath: string;
  status: RunStatus;
  integrationBranch: string;
  integrationWorktree: string;
  baseSha: string;
  inFlight: string | null;          // U-ID currently claimed/awaiting
  units: Record<string, RunUnitSummary>;
  readyCount: number | null;        // live bd ready count; null on bd error
}
export const handler: ActionHandler; // dispatches on args.runSub
```

Both handlers follow the existing style: `export const handler:
ActionHandler = { async run(args) { … } }`, `envelope(...)` for every return,
`PlanParseError → parseErrorEnvelope` (reuse bind.ts's helper pattern),
BdError → `BD_FAILURE` diagnostic, read-only actions take no lock.

---

## 3. `.omp/agents/ce-beads-unit.md` — exact content

Committed to the repo (new `.omp/agents/` directory; the repo currently has
no `.omp`). Frontmatter verbatim from the brief; body is the single source
also rendered into `.ce-beads-worker/system-prompt.md` by
`worker-prompt.ts`:

```markdown
---
name: ce-beads-unit
description: "Restricted implementation worker for a single ce-beads unit. Implements one bounded unit, runs focused verification, returns a structured report. Cannot spawn sub-agents, cannot mutate Beads, cannot integrate or close."
tools:
  - read
  - grep
  - glob
  - bash
  - edit
  - write
  - lsp
  - ast_grep
model:
  - "@smol"
thinkingLevel: medium
output:
  properties:
    u_id: { type: string, description: "The CE unit ID implemented" }
    status: { enum: [complete, blocked, failed], description: "Worker result" }
    changed_files: { elements: { type: string }, description: "Files created/modified" }
    verification_evidence:
      properties:
        commands: { elements: { type: string }, description: "Verification commands run" }
        results: { type: string, description: "Pass/fail summary with output" }
    blockers: { type: string, description: "If blocked, why; else empty" }
    notes: { type: string, description: "Optional implementation notes for the coordinator" }
  required: [u_id, status, changed_files, verification_evidence]
---

You are ce-beads-unit, a restricted implementation worker. You implement
exactly ONE bounded unit from a CE plan, inside the current worktree. A
coordinator owns all coordination; you own only the code in front of you.

## Hard rules (never violated)

1. Implement ONLY the bounded unit packet provided in the prompt. Do not
   refactor adjacent code, do not implement other units, do not "help"
   beyond the packet's Files and Approach.
2. Run ONLY the unit's listed verification commands. Do not run the repo's
   full test suite unless a verification command says to.
3. NEVER run `bd` (any subcommand). Beads is the coordinator's exclusive
   domain. Your worktree has no Beads workspace; do not create one.
4. NEVER commit, push, merge, rebase, or create branches with git. The
   coordinator owns all integration and commits your changes on your
   behalf after you finish. Even a "temporary" commit is forbidden.
5. NEVER spawn sub-agents. You have no `task` tool; do not attempt to.
6. Keep every change inside the current worktree. Do not write outside it.
7. Do not modify the CE plan file. Plans are immutable.

## Completion protocol

When the unit is done (or you are blocked):

1. Write your structured report to `.ce-beads-worker/result.json`
   (schema_version "ce-beads-worker-report/1"; required keys: u_id, status,
   changed_files, verification_evidence{commands,results}, blockers;
   optional: notes). `status` is complete | blocked | failed. `blockers` is
   non-empty iff status is "blocked".
2. Print the sentinel line EXACTLY as given in the prompt, on its own line:
   `CE_BEADS_RESULT:<run-id>:<U-ID>`
3. Immediately after the sentinel, print the same report JSON.

The sentinel is how the coordinator knows you are done. Never print it
before the result file is fully written. Never print anything resembling it
earlier in your output.
```

The initial user prompt delivered to the pane (rendered by
`renderWorkerPrompt(packet)` in `worker-prompt.ts`):

```text
Implement this bounded ce-beads unit. Your instructions are in your system
prompt. The packet:

<pretty-printed WorkerPacket JSON>

Reminders: write .ce-beads-worker/result.json first, then print exactly:
CE_BEADS_RESULT:<run-id>:<U-ID>
```

---

## 4. Exact `protocol.ts` additions

Extend the normative enums in place (no private variants — house rule):

```ts
// --- Actions ---------------------------------------------------------------

export type Action = "doctor" | "bind" | "status" | "sync" | "packet" | "run";

// --- Outcomes (per-action closed enums) -------------------------------------

// ... existing four lines unchanged ...

export type PacketOutcome = "packet_built" | "unit_not_found";

export type RunOutcome =
  | "in_progress"           // --once: unit claimed / worker launched or waiting
  | "awaiting_integration"  // --once: worker finished, integration pending
  | "completed"             // all units integrated + closed
  | "blocked"               // unit blocked (verification/report/worker); loop stopped
  | "failed"                // infrastructure failure; run-state intact; resumable
  | "reaped"                // run reap completed
  | "not_found"             // run status/resume/reap: unknown run-id
  | "refused";              // precondition refusal (NOT_BOUND, RUN_ACTIVE, LOCK_BUSY)

export type Outcome =
  | DoctorOutcome | BindOutcome | StatusOutcome | SyncOutcome
  | PacketOutcome | RunOutcome;
```

Diagnostic codes (append to `DiagnosticCode`):

```ts
  | "UNIT_NOT_FOUND"            // packet: no such U-ID in the plan
  | "NOT_BOUND"                 // run start: plan has no binding in Beads
  | "RUN_ACTIVE"                // run start/reap: a non-terminal run exists
  | "RUN_NOT_FOUND"             // status/resume/reap: unknown run-id
  | "RUN_STATE_CORRUPT"         // run-state file unparsable / wrong schema_version
  | "WORKER_FAILED"             // worker died / timed out / empty diff
  | "WORKER_REPORT_INVALID"     // sentinel seen but report failed validation
  | "VERIFICATION_FAILED"       // pre-merge unit verification non-zero
  | "INTEGRATION_FAILED"        // merge conflict or post-merge verification non-zero
  | "RUNTIME_FAILURE";          // Herdr CLI errors, pane lost, API-key error
```

`exitCodeFor` additions (insert in this order, before the generic tail; the
existing function is a sequence of early returns — match that style):

```ts
  // New precondition / usage mappings (with the BD_MISSING block).
  if (diagnostics.some((d) => d.code === "NOT_BOUND")) return ExitCode.PRECONDITION;

  // Bad-invocation mappings (with the other specific-code checks).
  if (diagnostics.some((d) => d.code === "UNIT_NOT_FOUND")) return ExitCode.USAGE;
  if (diagnostics.some((d) => d.code === "RUN_NOT_FOUND")) return ExitCode.USAGE;
  if (diagnostics.some((d) => d.code === "RUN_STATE_CORRUPT")) return ExitCode.CONFLICT;

  // Outcome mappings (with the existing outcome checks, after "preview"/"partial").
  if (outcome === "failed") return ExitCode.PARTIAL;      // resumable, state persisted
  if (outcome === "not_found") return ExitCode.USAGE;
  // "blocked" and "refused" already map to CONFLICT via the existing branch.
  // "packet_built" | "in_progress" | "awaiting_integration" | "completed" | "reaped"
  // fall through to SUCCESS.
```

---

## 5. `cli.ts` dispatch changes

Minimal, in the existing style. `CliArgs` gains three fields; `parseArgs`
gains two parse branches; `main` gains two dispatch entries.

```ts
export interface CliArgs {
  action: Action;
  planPath: string | undefined;   // packet/run start: plan; run status/resume/reap: run-id
  json: boolean;
  applyToken: string | undefined;
  help: boolean;
  unitId: string | undefined;     // packet <plan> <U-ID>
  runSub: "start" | "status" | "resume" | "reap" | undefined;
  once: boolean;                  // run start/resume --once
  force: boolean;                 // run reap --force
}
```

Parsing rules (replace the current allowlist + positional loop):

```text
- Allowlist: ["doctor","bind","status","sync","packet","run"].
- action === "packet": first positional → planPath; second positional →
  unitId. Missing either → usage (exit 2).
- action === "run": args[1] must be one of start|status|resume|reap →
  runSub; args[2] (positional) → planPath slot (plan path for start; run-id
  for status/resume/reap; optional for status — omitted means latest run).
  Unknown/missing sub → usage.
- Flags: --json, --apply <token>, --help/-h as today; add --once and
  --force (only meaningful for run; ignored elsewhere).
```

`usageMessage()` additions (match existing column style):

```text
  packet <plan> <U-ID>  Read-only bounded worker packet for one unit
  run start <plan>      Start a serial run (verify binding, init run-state, drive loop)
  run status [run-id]   Read-only run snapshot (latest run when omitted)
  run resume <run-id>   Re-attach to an in-flight worker / resume the loop
  run reap <run-id>     Clean up orphaned worktrees/panes (never touches Beads)

Run flags:
  --once               Execute a single loop iteration (start/resume)
  --force              Reap even when the run-state says in_progress (reap)
```

`main()` dispatch:

```ts
  const handlers: Record<Action, ActionHandler> = {
    doctor: doctorHandler,
    bind: bindHandler,
    status: statusHandler,
    sync: syncHandler,
    packet: packetHandler,   // from "../../ce-beads-work/scripts/packet.ts"
    run: runHandler,         // from "../../ce-beads-work/scripts/run.ts"
  };
```

Usage-gate change: the current gate `args.action !== "doctor" &&
!args.planPath` must become action-aware: `doctor` needs nothing; `status`
(existing) needs a plan; `packet` needs plan + unitId; `run start` needs a
plan; `run status` needs nothing; `run resume|reap` need a run-id.
Implement as a small `needsArg(args)` predicate — do not special-case
inline in `main` beyond the existing pattern.

Locking: `packet` and `run status` are read-only → **no lock** (same as the
existing `status` action). `run start`/`run resume` acquire the plan-path
`LockHolder` for the whole invocation (they mutate Beads: claim, metadata,
labels, close). `run reap` takes no lock — it never touches Beads; its
safety gate is the RUN_ACTIVE run-state check (+ `--force`).

---

## 6. Per-component test list

Conventions (from existing tests): Bun (`bun test --timeout 30000`), real
`bd` via `setupWorkspace()` from `tests/helpers/beads-workspace.ts`,
`devRepoIsolationGuards()` for any test that could touch the dev repo,
fixtures under `tests/fixtures/`. New helper (add to
`tests/helpers/beads-workspace.ts` or a new `tests/helpers/git-repo.ts`):
`setupGitRepo()` — mkdtemp, `git init -b main`, configure user, write
fixture plan + seed files, initial commit; returns `{ dir, cleanup }`. The
orchestrator's `repoRoot` points there, so plans parse (PATH_OUTSIDE_REPO
passes) and worktrees/merges run against real git.

| # | Test (file: name) | Invariant defended | Fixture(s) |
|---|-------------------|--------------------|------------|
| T1 | packet.test.ts: builds a correct bounded packet | `packet` emits `packet_built`; packet fields verbatim from plan IR; beads_id null when unbound | 02-linear-three-unit.md (unbound, no workspace) |
| T2 | packet.test.ts: resolves beads_id when bound | After `bind --apply`, packet for U2 carries the created task id | 02-linear-three-unit.md + isolated workspace |
| T3 | packet.test.ts: unknown unit | `unit_not_found` outcome + `UNIT_NOT_FOUND` diagnostic + exit 2 | 02-linear-three-unit.md, U-ID "U9" |
| T4 | packet.test.ts: malformed plan rejected | PLAN_MALFORMED diagnostic, non-zero exit, zero bd calls | 10-malformed-frontmatter.md |
| T5 | run-state.test.ts: round-trip | save→load preserves every field; atomic rename leaves no tmp file; schema_version enforced | synthetic RunState |
| T6 | run-state.test.ts: corrupt/missing | loadRunState throws RUN_STATE_CORRUPT / RUN_NOT_FOUND distinguishably | hand-written corrupt JSON |
| T7 | run-state.test.ts: findActiveRunForPlan | Non-terminal run for same plan detected; completed/blocked runs ignored | synthetic states |
| T8 | worker-report.test.ts: valid reports accepted | valid-complete + valid-blocked pass; blockers non-empty iff blocked | worker-reports/valid-*.json |
| T9 | worker-report.test.ts: invalid reports rejected | missing fields, bad status enum, non-JSON, wrong schema_version all → ok:false | worker-reports/invalid-*.json |
| T10 | worker-report.test.ts: pane fallback parse | parseReportFromPaneOutput extracts JSON after sentinel; ignores pre-sentinel JSON; null when absent | inline strings |
| T11 | orchestrator.test.ts: full serial loop end-to-end | MockRuntime; 3-unit linear plan: claim U1 → worker → integrate → close; then U2, U3 in dependency order; final outcome completed; integration branch contains all units' files; each task's `closed_at` set only AFTER its integrated_sha recorded | 02-linear-three-unit.md + setupGitRepo + MockRuntime scripted to write each unit's `files` |
| T12 | orchestrator.test.ts: **integrate-before-close invariant** | Drive with --once; after worker-sentinel step, task is `in_progress` with `ce_beads:awaiting-integration` label and NOT closed; `bd ready` does NOT yet list U2; only after the integrate iteration does U1 close and U2 become ready. Assert close-time ordering: no `close` call occurs before merge + verification in a spy-wrapped client | 02-linear-three-unit.md |
| T13 | orchestrator.test.ts: verification failure blocks | Failing-verification fixture: unit claimed, worker "completes", verification fails → task labeled `ce-beads:blocked`, state blocked, NOT merged (integration worktree HEAD unchanged), NOT closed, outcome blocked, `VERIFICATION_FAILED` diagnostic | 17-work-failing-verification.md |
| T14 | orchestrator.test.ts: invalid worker report blocks | MockRuntime emits sentinel + malformed report → WORKER_REPORT_INVALID, blocked, no merge, no close | 02-linear-three-unit.md |
| T15 | orchestrator.test.ts: crash recovery re-attach | Pre-write run-state with unit "claimed" + MockRuntime handle whose inspect → finished (sentinel pending integration): resume continues at INTEGRATE and closes; variant: inspect → dead → cleanup + blocked + WORKER_FAILED | 02-linear-three-unit.md |
| T16 | orchestrator.test.ts: resume after full coordinator death between units | Run U1 via --once steps, then resume: loop picks U2 without re-claiming U1 (U1 closed, U2 ready from bd) | 02-linear-three-unit.md |
| T17 | orchestrator.test.ts: run start refuses unbound / active | Unbound plan → refused + NOT_BOUND + exit 4, zero git/bd mutations; second start while in_progress → refused + RUN_ACTIVE | 02-linear-three-unit.md |
| T18 | orchestrator.test.ts: reap cleans without touching Beads | Crash a run mid-flight; reap → worktrees removed, branches deleted, pane cleanup invoked (mock records), run-state failed; every Beads task status unchanged (claimed stays in_progress, none closed) | 02-linear-three-unit.md |
| T19 | orchestrator.test.ts: status snapshot | After partial run, `run status` reports inFlight U-ID, per-unit states, readyCount; unknown id → not_found + exit 2 | 02-linear-three-unit.md |
| T20 | cli.test.ts (extend): arg parsing | packet/run parse branches, --once/--force, usage gates (missing unit-id, bad runSub) → usage + exit 2 | — (pure parse) |
| T21 | packaging.test.ts (extend): new skill layout + boundary consistency | skills/ce-beads-work/SKILL.md frontmatter parses (name/description); `.omp/agents/ce-beads-unit.md` frontmatter tools list equals `HERDR_WORKER_TOOLS` (or ⊇, per R5 fallback) and contains no `task`; `files:["skills/"]` covers the new dir | repo files |
| T22 | regression: existing suites | `bun run verify` — bind/status/sync/doctor/plan-parser/graph-builder/beads-client/packaging/docs all green | existing 16 fixtures |

MockRuntime contract (T11–T19): constructed with a script
`Record<U-ID, { writeFiles: Record<path,string>; report: WorkerReport |
"malformed" | "die" }>`. `createWorkspace` does a REAL `git worktree add`
(against the temp repo), `startWorker` applies `writeFiles` and **git-commits
them on the worker branch** (the mock plays the coordinator-side commit the
real adapter gets for free from the pane session's edits + a commit step),
writes `result.json`, returns a handle. `wait` returns per script.
`inspect`/`cleanup` are spy-recorded. This exercises real git merges and real
bd transitions with zero Herdr.

Note for the real adapter: since ce-beads-unit workers are forbidden from
committing (agent rule 4), `HerdrRuntime.wait` — after sentinel — runs
`git -C <worktree> add -A && git -C <worktree> commit -m "ce-beads(<U-ID>):
worker changes (<run-id>)"` as the coordinator's capture step before the
diff inspection. This keeps the worker's tree clean-room while giving the
merge step a real branch tip. (MockRuntime models this by committing in
startWorker.)

---

## 7. Manual acceptance test procedure

Automated tests never launch OMP or Herdr (brief requirement). After
`bun run verify` is green, STOP and hand the human this procedure.

### Preflight (human, in a shell on `feature/ce-orchestrate`)

```bash
cd ~/Development/AI/ce-beads
git branch --show-current          # expect: feature/ce-orchestrate
bun run verify                     # expect: typecheck + all tests green
herdr integration status           # expect: `omp: current` for the chinese profile
OMP_PROFILE=chinese herdr integration status   # if separate; else confirm profile scoping
bd --version                       # expect: 1.1.0
```

### Launch the coordinator

1. Inside Herdr (the human's normal terminal), from the repo root:
   ```bash
   omp --profile chinese
   ```
2. In that session, invoke the skill with a bound fixture plan (bind first
   if needed — the coordinator must show the bind preview and STOP for the
   human's explicit approval, per the existing approval contract):
   ```text
   /skill:ce-beads-work run start tests/fixtures/plans/02-linear-three-unit.md
   ```
   (Or the direct CLI: `bun skills/ce-beads/scripts/cli.ts run start
   tests/fixtures/plans/02-linear-three-unit.md --json` — but the intended
   path is the skill-driven coordinator.)

### Required observations for PASS

| # | Observation | How to check |
|---|-------------|--------------|
| O1 | A new Herdr pane opens, labeled `ce-beads-U1-<run-id>`, running `omp --profile chinese --model @smol --no-session` | `herdr pane list` shows the label; `herdr pane process-info --pane <id>` |
| O2 | Worker pane shows no `No API key found` error; status bar shows MiniMax-M3 | `herdr pane read <id> --source visible --lines 12` right after launch |
| O3 | Worker does NOT call `bd` (no claim/update/close from the pane) | `herdr pane read <id> --source recent-unwrapped`; `bd list --json` assignee is the coordinator's claim only |
| O4 | Worker prints exactly `CE_BEADS_RESULT:<run-id>:U1` on its own line, and `.ce-beads-worker/result.json` exists in the U1 worktree | pane read; `cat /tmp/ce-beads-wt/U1-<run-id>/.ce-beads-worker/result.json` |
| O5 | U1's task is NOT closed before integration: after the worker finishes, `bd show <u1-id> --json` shows `in_progress` + label `ce-beads:awaiting-integration`; `bd ready --json` does NOT yet list U2 | `bd` CLI in the repo |
| O6 | Coordinator closes U1 ONLY after merge + verification; then U2 becomes ready | `bd show`, `bd ready --json` before/after; `git -C /tmp/ce-beads-wt/integration-<run-id> log --oneline` shows the `--no-ff` merge |
| O7 | Loop continues serially: exactly one worker pane at a time; U3 never starts before U2 closes | `herdr pane list` at any moment |
| O8 | Crash recovery: while a worker is mid-run, kill the coordinator's driver (Ctrl-C the `bun … run start` process / interrupt the coordinator). Then `bun skills/ce-beads/scripts/cli.ts run resume <run-id> --json` re-attaches, waits for the same sentinel, and completes integration without re-claiming or re-launching | run-state file `.ce-beads/run-<run-id>.json` before/after; pane label unchanged |
| O9 | When all units integrate: outcome `completed` with the integration-branch SHA; coordinator STOPS with a human notice; no ce-simplify/review/PR/push; `git branch` shows `main` untouched and `ce-beads/<slug>-<run-id>` holding the work | CLI envelope; `git log main..HEAD` on the integration branch |
| O10 | Plans untouched: the fixture plan file is byte-identical before/after (SD7) | `git status` — no modification to tests/fixtures/plans/ |

### Failure-path spot check (optional but recommended)

Run the failing-verification fixture (`17-work-failing-verification.md`)
through the same flow: expect the unit blocked, labeled `ce-beads:blocked`,
NOT merged, NOT closed, outcome `blocked`, and the coordinator stopping for
the human.

---

## 8. Done criteria

The milestone is done when ALL of the following hold:

1. `skills/ce-beads-work/SKILL.md` and `.omp/agents/ce-beads-unit.md` exist,
   are committed on `feature/ce-orchestrate`, and are discoverable by the
   `chinese` OMP profile (skill appears in `/skill:` completion; agent file
   present in the project agents dir).
2. `bun run verify` is green: typecheck + all tests, including T1–T21 (the
   mock-runtime loop test T11 and the integrate-before-close invariant test
   T12) and the full pre-existing MVP suite with zero regressions (T22).
3. The manual acceptance test in §7 passes every required observation
   O1–O10.
4. The five CLI actions behave exactly as specified: `packet` read-only;
   `run start/status/resume/reap` with the outcome/exit-code mapping in §4;
   `run reap` never mutates Beads.
5. Integrate-before-close holds in the only place it can be violated: no
   code path calls `BeadsClient.close` except the orchestrator's post-merge,
   post-verification step (grep-verifiable: `grep -n "\.close("
   skills/ce-beads-work/scripts/` shows exactly one call site).
6. All work is on `feature/ce-orchestrate`; `main` has no new commits;
   nothing is pushed or tagged.
7. The implementation STOPS with a human notice at the shipping-tail
   boundary: no ce-simplify, no ce-code-review, no PR, no merge.

## 9. Explicitly not built (from the brief's non-goals)

Parallel waves / file-contention scheduler; CE quality tail; Beads gates;
formulas/molecules; marketplace/npm publish; alternative runtime adapters;
multi-writer Beads; CE/Beads upstream modifications; HTML plans; direct
Dolt / Beads MCP; writing progress into plans; ce-compound / `bd remember`;
auto-merge/push/tag; plan-level Verification Contract table parsing (R8).

## 10. Open questions the builder may hit (with defaults)

1. **`omp --tools` tool-name acceptance** (R5): if `lsp`/`ast_grep` are
   rejected by omp v17.0.6, drop them from the CLI whitelist only; keep the
   agent file as-is; relax T21 to subset comparison. Verify once with
   `omp --tools … --no-session -p "ok"` in a scratch dir before wiring
   HerdrRuntime.
2. **`herdr pane split` JSON field name**: the skill parses `result.pane_id`
   but the observed `pane list` envelope uses `result.panes[].pane_id` and
   `pane get` uses `result.pane`. Pin the split-output field at build time
   with one manual `herdr pane split` probe; parse defensively
   (`result.pane_id ?? result.pane?.pane_id`).
3. **Prompt delivery size**: `herdr pane run <pane> '<prompt>'` passes the
   prompt as an argv string. Packets are a few KB — well under argv limits.
   If a plan produces an oversized packet (>32 KB), truncate
   `technical_design` in the prompt and point the worker at
   `.ce-beads-worker/packet.json` in the worktree (always written in full).
