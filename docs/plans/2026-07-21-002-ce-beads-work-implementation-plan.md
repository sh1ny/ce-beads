# ce-beads-work Serial Orchestrator — Implementation Plan (v2)

Implementation-ready plan for the `ce-beads-work` serial orchestrator
milestone. Enriches
`docs/plans/2026-07-21-001-feat-ce-beads-work-serial-orchestrator.md`
(the brief). All settled decisions SD1–SD8 are final and are not relitigated
here. This document resolves the brief's open questions, pins exact
interfaces, and sequences the build so a builder agent can execute without
further design decisions.

**Branch:** `feature/ce-orchestrate` only. Never commit to main. Stop with a
human notice at the end (SD8).

**Revision history.** This is **v2**. v1 was reviewed and found to have four
P0 (blocking) and five P1 (major) issues plus packaging gaps. v2 preserves
the solid foundations — serial engine, runtime interface,
integrate-before-close — and corrects the execution and recovery contracts.
The P0/P1 resolutions are called out inline below as **[P0-n]** / **[P1-n]**
and are normative.

---

## 0. Resolutions of the brief's open questions (and v1 review findings)

These were open in the brief or broken in v1; they are now decided.
Rationale is grounded in the existing code, in live CLI surface checks (omp
v17.0.6, herdr, bd 1.1.0), and in OMP source inspection.

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

### R2 — `run reap` is in scope

It is safety-net code, but it is small, fully specified below, and the crash
recovery path genuinely needs it (orphaned pane/worktree mappings). Include.
**[P1-5]** The reap interface is corrected in §2.5: it receives a full
persisted worker handle, preserves failed worktrees by default, is
preview/approval-gated, acquires the run lock, and validates every path
belongs to the run before removal.

### R3 — Worker report transport: durable file is the completion signal

**[P0-3 resolution]** v1 put the sentinel literal in the worker prompt and
searched scrollback for the same string — the runtime would detect
"completion" instantly on the sent prompt text. v2 inverts the design:

- The worker writes its structured report atomically to
  `<worktree>/.ce-beads-worker/result.json` (write-temp-then-rename, same
  pattern as `run-state.ts`).
- **The existence of the result file IS the completion signal.** The
  adapter polls the filesystem for the file, not the pane scrollback for a
  sentinel string.
- The worker is instructed to print a marker line
  `CE_BEADS_RESULT:<run-id>:<U-ID>` ONLY AFTER the rename succeeds — but the
  adapter treats this as an advisory human-visible breadcrumb, not as the
  detection mechanism. The marker may appear in scrollback; it does not
  matter, because the adapter never searches for it.
- The nonce value still appears in the prompt (the worker needs to know what
  to print), but since detection is filesystem-based, prompt-text
  contamination is no longer a correctness issue.

Rationale: the only deterministic, contamination-proof signal is a file
the adapter creates the parent for and the worker atomically renames into
existence. Scrollback scraping is gone entirely.

### R4 — Worker model role: static `@smol`, but configured not hardcoded

**[packaging-gap resolution]** `@smol` (MiniMax-M3 on the `chinese` profile)
is the default worker role stored in `HerdrRuntime` options (`model:
"@smol"`). But this is a **constructor option** with a sensible default, not
a hardcoded constant. The acceptance environment pins `chinese`/`@smol`; a
public consumer overrides via config. The coordinator skill documents both.

Complexity-based `@tiny` selection is an explicit refinement and is NOT
built. The role is a constructor option so tests and future refinements can
override it.

### R5 — Worker boundary enforcement: defense-in-depth, honestly described

**[P0-4 + P1-1 resolution]**

The brief mandated `.omp/agents/ce-beads-unit.md`. v1 then claimed that
launching with `--tools <whitelist>` gave *physical* enforcement, and that
worker worktrees under `/tmp` couldn't reach `.beads`. Both claims are
false:

- **`--append-system-prompt` does not do `@file` expansion** (verified in
  OMP source, `system-prompt.ts:314` `resolvePromptInput`: it tries
  `Bun.file(input).text()`; if the path doesn't exist, the input becomes a
  literal string). v1's `@.ce-beads-worker/system-prompt.md` would try to
  read a file literally named with the `@` prefix → ENOENT → the literal
  string `@.ce-beads-worker/system-prompt.md` gets appended to the system
  prompt. **Fix: pass the path WITHOUT the `@`** (absolute path preferred).
  This is now an automated subprocess test (§6 T21b), not a build-time
  manual probe.
- **Git worktrees do NOT physically isolate `.beads`** (verified: linked
  worktrees share the git common directory; a bash-equipped worker can run
  `bd` and discover the shared workspace). **The boundary is
  defense-in-depth, not physical enforcement.** The plan describes it as
  such everywhere it is mentioned.

Enforcement is therefore **dual and honestly layered**:

1. **Agent definition file** at `agents/ce-beads-unit.md` (package root —
   see R9). Canonical for task-subagent invocation and for plugin
   distribution. Declares the tool whitelist and system prompt.
2. **Herdr pane launch** applies the same whitelist via
   `omp --profile chinese --model @smol --no-session --tools <list>
   --append-system-prompt <absolute-path-without-@>`. The `--tools` list
   excludes `task` (no recursive spawning) and every built-in not listed.
3. **Defense-in-depth (not physical):** worker worktrees run with
   `BEADS_DIR` explicitly set to an isolated temp dir and `PATH` sanitized
   to drop `bd` where feasible. This raises the bar but is NOT described as
   a hard boundary — a determined bash worker could still reach `bd` via
   absolute paths or PATH lookup. The agent prompt forbids `bd` explicitly
   (rule 3). The real enforcement is that the coordinator owns all Beads
   writes and the worker's report is validated; a worker that somehow
   mutated Beads would be detected on the next `bd show` reconciliation.

A packaging test asserts the launcher's tool whitelist equals the agent
file's frontmatter `tools:` list and that neither contains `task`.

### R6 — Where the control loop lives: the TS engine, driven by `run start` / `run resume`

The full loop state machine (claim → launch → wait → integrate → verify →
close) is implemented once in a TypeScript engine (`orchestrator.ts`). Both
`run start` and `run resume` invoke the same driver:

- Default (no flags): drive the loop to quiescence — outcome `completed`
  (all units closed), `blocked` (a unit failed verification / report
  invalid; loop stops, human intervenes), or `failed` (infrastructure
  failure; run-state intact, `run resume` continues).
- `--once` flag: execute exactly one loop iteration and return
  `in_progress` / `awaiting_integration` / `completed` / `blocked`. Used by
  automated tests with the mock runtime and available to the coordinator
  agent for stepwise driving.

This keeps integrate-before-close **inside deterministic code**, not in
advisory prompt text. The coordinator OMP agent (guided by
`skills/ce-beads-work/SKILL.md`) is a thin driver: preflight → `run start`
→ monitor → `run resume` on crash → STOP at the shipping boundary.

### R7 — Integration happens in a dedicated integration worktree, never the user's checkout

The coordinator runs inside the user's working tree; merging there would
hijack the user's checkout. `run start` creates the integration branch and
checks it out in `<worktreeRoot>/integration-<run-id>` via
`git worktree add <path> -b ce-beads/<slug>-<run-id> HEAD`. All merges and
post-merge integration verification run in that worktree.

### R8 — Verification: parse the Verification Contract, do not execute prose

**[P0-2 resolution]** v1 ran `bash -c "<unit.verification string>"` where
`unit.verification` entries are CE acceptance prose ("U1 parses.", "Expired
tokens return 401") — not shell commands. `bash -c "U1 parses."` fails
immediately. The actual executable commands live in the plan-level
**Verification Contract** table, which `plan-parser.ts` does not currently
extract.

v2 changes:

- **Extend `plan-parser.ts`** to parse the Verification Contract table into
  typed entries: `{ unit_id: string; command: string; expected?: string }[]`.
  The table maps U-IDs to the shell commands that verify them.
- **Unit-level `verification: string[]` is treated as expected behavior
  description**, never executed. It is included in the worker packet as
  acceptance prose for the worker to target.
- **Pre-merge verification (per unit)**: run the Verification Contract
  commands for that U-ID sequentially via `bash -c` in the unit's worker
  worktree. Any non-zero → `VERIFICATION_FAILED`, unit blocked, NOT merged,
  NOT closed.
- **Post-merge verification (integration)**: re-run the same commands in
  the integration worktree after `git merge --no-ff -m "<msg>"` (note the
  noninteractive `-m`, see R11). Any non-zero → `INTEGRATION_FAILED`, unit
  blocked, merge left in place for human inspection, task NOT closed.

If a plan has no Verification Contract entries for a unit, pre-merge
verification is a no-op (pass) and the worker's own `verification_evidence`
in its report is the only signal. This is documented as a weaker guarantee
and surfaced in `run status`.

### R9 — Plugin agents ship at `agents/*.md`, not `.omp/agents/*.md`

**[packaging-gap resolution]** Verified in OMP source
(`task/discovery.ts:7`, `discovery/omp-plugins.ts`, and
`docs/skills/authoring-marketplaces.md:201`): plugin agents are discovered
from `<plugin-root>/agents/*.md` for installed plugins, plus
`.omp/agents/*.md` (project) and `~/.omp/agent/agents/*.md` (user) for
task-subagent invocation.

- The worker agent file lives at **`agents/ce-beads-unit.md`** in the
  package root (shipped).
- `package.json` `files` is extended to include `"agents/"` alongside the
  existing `"skills/"`.
- The project-local `.omp/agents/` directory is NOT created — the single
  canonical file ships with the plugin.
- A packaging test asserts the agent file is present in
  `bun pm pack --dry-run` output and that its frontmatter parses.

### R10 — Run state stored outside the consumer repo

**[packaging-gap resolution]** v1's `.ce-beads/run-*.json` in the repo root
would pollute consumer repositories (ce-beads' own `.gitignore` doesn't
help consumers). v2 stores run state under the git common directory:

- **Location:** `$GIT_DIR/ce-beads/run-<run-id>.json`, resolved via
  `git rev-parse --git-common-dir`. This is shared across linked worktrees
  (so the coordinator in any worktree sees the same runs) and is never
  committed (the common dir is outside the working tree).
- Fallback when not in a git repo: `${XDG_STATE_HOME:-$HOME/.local/state}/ce-beads/runs/`.
- A helper `runStateDir(repoRoot?)` resolves this; tests use an isolated
  temp `GIT_DIR`.

### R11 — Noninteractive git and flag hygiene

**[packaging-gap resolution]**

- `git merge --no-ff` requires `-m <message>` in noninteractive contexts.
  v2 uses `git merge --no-ff -m "ce-beads(<U-ID>): merge worker branch
  (<run-id>)"`.
- `--force` outside `run reap` is **rejected** (usage error, exit 2), not
  silently ignored. `parseArgs` enforces this: `--force` is accepted only
  when `action === "run" && runSub === "reap"`.

---

## 1. Dependency-ordered build sequence

Each step lists exact paths. Steps are ordered so every file's imports
already exist. All new code lives under `skills/ce-beads-work/scripts/`
except the normative protocol and CLI dispatch (which live in
`skills/ce-beads/scripts/` — single normative source rule) and the agent
file (which lives at `agents/`).

| # | Path | Kind | Depends on |
|---|------|------|------------|
| 1 | `skills/ce-beads/scripts/protocol.ts` | modify: extend `Action`, add `PacketOutcome`/`RunOutcome`, 10 new `DiagnosticCode`s, extend `exitCodeFor` | — |
| 2 | `skills/ce-beads/scripts/plan-parser.ts` | modify: parse Verification Contract table into typed entries (R8); parse requirement definitions (R-ID → text) and KTD excerpts (KTD-ID → text) into `CePlan.requirement_defs` and per-unit `CeUnit.ktd_excerpts`; select KTDs per unit by matching requirement IDs referenced by the unit | — |
| 3 | `skills/ce-beads-work/scripts/worker-packet.ts` | create: `WorkerPacket` types + `buildWorkerPacket()` | 1, 2 |
| 4 | `skills/ce-beads-work/scripts/packet.ts` | create: `packet` action handler | 1, 3 |
| 5 | `skills/ce-beads-work/scripts/worker-report.ts` | create: `WorkerReport` schema + `validateWorkerReport()` | — |
| 6 | `skills/ce-beads-work/scripts/run-state.ts` | create: run-state schema + load/save/list/refuse-active (R10 location) | — |
| 7 | `skills/ce-beads-work/scripts/git.ts` | create: minimal git helpers (worktree add/remove, branch, merge -m, diff, rev-parse, run-in-dir, rev-parse --git-common-dir) | — |
| 8 | `skills/ce-beads-work/scripts/runtimes/runtime.ts` | create: `AgentRuntime` interface (corrected `cleanup` signature per [P1-5]) | 5 |
| 9 | `skills/ce-beads-work/scripts/runtimes/mock.ts` | create: `MockRuntime` (scripted, real git worktrees, no Herdr) | 7, 8 |
| 10 | `skills/ce-beads-work/scripts/orchestrator.ts` | create: `RunEngine` — the loop + 6-state integrate-before-close state machine (R12) | 1, 3, 5, 6, 7, 8 |
| 11 | `skills/ce-beads-work/scripts/runtimes/herdr.ts` | create: `HerdrRuntime` (file-based completion detection, R3) | 7, 8 |
| 12 | `skills/ce-beads-work/scripts/run.ts` | create: `run` action handler (start/status/resume/reap → engine) | 1, 6, 10, 11 |
| 13 | `skills/ce-beads/scripts/cli.ts` | modify: extend `CliArgs`/`parseArgs`/`usageMessage`/`main` dispatch for `packet` + `run`; reject `--force` outside reap (R11) | 1, 4, 12 |
| 14 | `skills/ce-beads-work/scripts/worker-prompt.ts` | create: worker system-prompt body (single source) + `renderWorkerPrompt()` | 3, 5 |
| 15 | `agents/ce-beads-unit.md` | create: bundled worker agent at package root (R9) | 14 |
| 16 | `skills/ce-beads-work/SKILL.md` | create: coordinator skill instructions | 12, 13, 15 |
| 17 | `tests/fixtures/plans/17-work-failing-verification.md` | create fixture (verification command that fails) | — |
| 18 | `tests/fixtures/plans/18-work-u2-depends-on-u1-impl.md` | create fixture: U2 imports/requires U1's implementation (P0-1 test) | — |
| 19 | `tests/fixtures/worker-reports/{valid-complete,valid-blocked,invalid-missing-fields,invalid-bad-status,invalid-not-json}.json` | create fixtures | — |
| 20 | `tests/packet.test.ts` | create | 4 |
| 21 | `tests/run-state.test.ts` | create | 6 |
| 22 | `tests/worker-report.test.ts` | create | 5, 19 |
| 23 | `tests/plan-parser.test.ts` | modify: Verification Contract parsing cases (R8) | 2 |
| 24 | `tests/orchestrator.test.ts` | create: mock-runtime loop, integrate-before-close invariant, **6-state recovery (R12)**, worker-base-sha freshness (P0-1), blocked-run ownership (P1-3), artifact-exclusion (P1-4), reap | 9, 10, 17, 18 |
| 25 | `tests/cli.test.ts` | modify: arg-parsing cases for `packet`/`run`, `--force` rejection | 13 |
| 26 | `tests/packaging.test.ts` | modify: assert ce-beads-work skill layout, agent file at `agents/`, pack includes `agents/`, tool-whitelist consistency, `--append-system-prompt` path-without-@ (T21b) | 14, 15, 16 |
| 27 | `package.json` | modify: add `"agents/"` to `files` | 15 |
| 28 | `README.md` + `docs/acceptance.md` | modify: document new actions, agent location, acceptance section | 13, 16 |

Notes:

- Steps 1–10 are pure TS, no Herdr — fully testable in CI (SD1 scope).
- Step 11 (Herdr adapter) is only smoke-tested manually (real-Herdr
  integration is exercised in the manual acceptance test, not automated
  tests).
- Existing `bind/status/sync/doctor` tests must remain green throughout
  (run `bun run verify` after steps 1, 13, and at the end).
- `.gitignore` needs **no change** for `.ce-beads/` — run state no longer
  lives there (R10). If a `.ce-beads-worker/` dir is created inside
  worktrees during manual runs, it is excluded via explicit path staging
  in the engine (never `git add -A`), per [P1-4].

---

## 2. Exact TypeScript interfaces

All interfaces below follow the existing style: JSDoc on every exported
member, no `any`, string-valued metadata (KTD10), immutable inputs.

### 2.1 `worker-packet.ts` — worker packet shape

```ts
// worker-packet.ts — bounded worker packet: everything a ce-beads-unit worker
// needs to implement exactly one unit, and nothing about coordination.

import type { CePlan, CeUnit } from "../../ce-beads/scripts/plan-parser.ts";
import type { VerificationEntry } from "../../ce-beads/scripts/plan-parser.ts";

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
  execution_note?: string;
  technical_design?: string;
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
export function planSlug(planPath: string): string;

/** Build a packet from a parsed plan + unit. Run fields null when standalone. */
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
    /** Requirement definitions to inject when plan-parser does not yet extract them. */
    requirementDefs?: { id: string; text: string }[];
    /** KTD excerpts to inject when plan-parser does not yet extract them. */
    ktdExcerpts?: { id: string; text: string }[];
  } = {},
): WorkerPacket;
```

**Packet completeness note [packaging-gap].** This packet includes the
unit's fields, its verification commands, requirement definitions (with
full text, not just IDs), and KTD excerpts. The remaining plan-level
constructs NOT in the packet are the Goal Capsule and Definition of Done —
these are plan-level metadata that require a schema version bump and/or a
dedicated extraction step in `plan-parser.ts`; they are deferred to a
follow-up. `plan-parser.ts` must be extended to extract requirement
definitions and KTDs if it does not already — the new fields in
`PacketUnit` and `buildWorkerPacket` opts are the target shape.

### 2.2 `worker-report.ts` — worker report schema

```ts
// worker-report.ts — structured report the worker returns; validated strictly.
// Completion is signaled by the atomic existence of this file (R3).

export const WORKER_REPORT_SCHEMA_VERSION = "ce-beads-worker-report/1" as const;
export const WORKER_RESULT_FILE = ".ce-beads-worker/result.json" as const;
export const WORKER_RESULT_TEMP = ".ce-beads-worker/.result.tmp" as const;
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
 * keys, wrong schema_version, and non-string values.
 */
export function validateWorkerReport(raw: unknown): WorkerReportValidation;
```

### 2.3 `run-state.ts` — run-state file schema (6-state lifecycle, R10 location)

**[P1-2 resolution]** v1's 4-state lifecycle (claimed / awaiting-integration
/ closed / blocked) omitted `merged` and `verified`, so a crash between
merge and close would cause resume to repeat the merge or re-close an
already-closed task. v2 persists the full 6-state lifecycle so every resume
step can reconcile Git + Beads read-back before repeating a mutation.

```ts
// run-state.ts — the ONLY coordinator-local state (SD7: plans immutable,
// task state in Beads). Stored under $GIT_DIR/ce-beads/run-<run-id>.json (R10).

export const RUN_STATE_SCHEMA_VERSION = "ce-beads-run/1" as const;

export type RunStatus = "in_progress" | "blocked" | "completed" | "failed" | "abandoned";

/**
 * Per-unit lifecycle. Every transition is persisted BEFORE the corresponding
 * mutation is considered durable, so resume can reconcile (P1-2):
 *
 *   pending
 *     → claimed              (coordinator: bd update --claim; persist)
 *     → worker_finished      (result file exists; report validated; persist)
 *     → captured             (coordinator committed worker's tree; persist
 *                              worker_commit_sha)
 *     → merged               (git merge --no-ff into integration; persist
 *                              merge_sha)
 *     → verified             (post-merge verification passed; persist)
 *     → closed               (bd close; persist)
 *   Any state → blocked      (verification/report/worker failure; persist)
 *
 * Resume rules (read-back before repeat):
 *   - claimed with worker_pane_id: runtime.inspect → finished?
 *     advance to worker_finished. running? wait. dead? cleanup + blocked.
 *   - worker_finished: re-validate report file; advance to captured.
 *   - captured: re-confirm worker_commit_sha exists in git; advance to
 *     merged (re-merge is safe if merge_sha absent; if present, advance).
 *   - merged: re-confirm merge_sha is in integration branch history; if
 *     not, re-merge; advance to verified.
 *   - verified: re-run verification; if pass, advance to closed.
 *   - closed: bd show confirms status closed; advance to next unit.
 * Every reconciliation that finds the expected durable artifact advances
 * WITHOUT repeating the mutation. Missing artifact → repeat the mutation
 * (idempotent by construction) or block.
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

export interface RunUnitRecord {
  beads_id: string;
  state: UnitRunState;
  worker_pane_id: string | null;
  worker_branch: string | null;
  worktree_path: string | null;
  /**
   * SHA the worker branch was forked from. Equals the integration worktree
   * HEAD at dispatch time (P0-1), NOT run.base_sha. Persisted at claim
   * time so resume can re-derive the branch if needed.
   */
  worker_base_sha: string | null;
  claimed_at: string | null;
  /** Coordinator's commit of the worker's tree (after capture step). */
  worker_commit_sha: string | null;
  /** Merge commit SHA on the integration branch (after merge step). */
  merge_sha: string | null;
  /** Integration branch HEAD at close time (== merge_sha for the last unit). */
  integrated_sha: string | null;
  result: WorkerReport | null;
  /**
   * The state this unit was in immediately before transitioning to
   * "blocked" (e.g. blocked at worker_finished, or at captured, or at
   * merged). null when the unit is not currently blocked. Used by resume
   * / retry to skip past the blocked state's own work and re-enter from
   * the last successful durable step.
   */
  last_successful_state: UnitRunState | null;
  /** Human-readable reason the unit blocked; empty string when not blocked. */
  blocker_reason: string;
  /** Prompt dispatch lifecycle (persisted, P1-2): not_sent | dispatching | sent. */
  prompt_lifecycle: "not_sent" | "dispatching" | "sent";
  /** Attempt number (starts at 1, increments on retry — prevents worktree collision). */
  attempt: number;
}

export interface RunState {
  schema_version: typeof RUN_STATE_SCHEMA_VERSION;
  run_id: string;
  plan_path: string;
  /**
   * SHA-256 digest (or other stable hash) of the plan file at run-start
   * time. Captured so resume can detect post-start edits to the plan
   * source.
   *
   * `run resume` MUST validate this on load: recompute the digest of
   * `plan_path` and compare against `plan_digest`. A mismatch means the
   * plan was edited since the run started — the U-IDs, packet contents,
   * and worker instructions may no longer match what is persisted in
   * run-state and Beads. Resume MUST refuse in that case, surfacing
   * either RUN_STATE_CORRUPT (when the persisted state itself is
   * inconsistent) or a new diagnostic PLAN_DIGEST_DRIFT (when only the
   * plan file has drifted). The human must explicitly re-bind / start
   * a fresh run; resume never silently proceeds against a drifted plan.
   */
  plan_digest: string;
  /**
   * The run's base SHA — the HEAD the integration branch was forked from.
   * This is the FLOOR of the integration history, NOT the per-unit fork
   * point. Per-unit fork points are RunUnitRecord.worker_base_sha (P0-1).
   */
  base_sha: string;
  integration_branch: string;
  integration_worktree: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  units: Record<string, RunUnitRecord>; // keyed by U-ID, full plan roster
}

export function newRunId(now?: Date): string;               // R1 format
export function runStateDir(repoRoot?: string): string;     // R10 resolution
export function runStatePath(runId: string, repoRoot?: string): string;
export function saveRunState(state: RunState, repoRoot?: string): void; // atomic: tmp + rename
export function loadRunState(runId: string, repoRoot?: string): RunState; // throws RUN_STATE_CORRUPT / RUN_NOT_FOUND
export function listRunIds(repoRoot?: string): string[];    // sorted, newest last
export function latestRunId(repoRoot?: string): string | null;
/**
 * Returns an active run for the same plan, if any. A run is "active" when:
 *   - status === "in_progress" (ALWAYS active — even with empty units,
 *     because it may be mid-initialization; the integration worktree may
 *     exist even though no unit has been claimed yet), OR
 *   - status === "blocked" or "failed" AND it still owns at least one
 *     unit in a non-closed, non-terminal per-unit state (claimed /
 *     worker_finished / captured / merged / verified / blocked).
 *
 * Rationale: an in_progress run with empty units is mid-setup — the
 * integration worktree may exist, and `run start` must refuse to avoid
 * orphaning it. A failed run may own claimed Beads tasks; `run start`
 * MUST refuse (RUN_ACTIVE) until the human retries or releases via
 * `run abandon`. A failed run whose every unit is closed is terminal
 * and NOT active.
 *
 * In short: in_progress is ALWAYS active. blocked/failed is active iff
 * it owns unfinished tasks. completed/abandoned are never active.
 */
export function findActiveRunForPlan(planPath: string, repoRoot?: string): RunState | null;
```

### 2.4 `runtimes/runtime.ts` — the AgentRuntime interface (corrected cleanup)

**[P1-5 resolution]** v1's `cleanup(ws: Workspace)` received no pane ID and
couldn't implement its recovery contract (closing a pane after a process
restart). v2's cleanup receives the full persisted worker handle.
Destructive operations are gated behind preview/approval and preserve
failed worktrees by default.

```ts
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
```

### 2.5 `runtimes/herdr.ts` — HerdrRuntime

```ts
// runtimes/herdr.ts — production runtime over the Herdr CLI.
// Uses `herdr agent start` with the prompt as the LAST argv argument to
// omp — the agent starts working immediately, eliminating the two-phase
// startWorker gap. Completion is still file-based (R3); `herdr agent wait`
// is an advisory fast-path only.

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
  /** omp binary; default resolved from process.argv[1] or "omp" (PATH). */
  ompPath?: string;
  /** Worker wait timeout; default 30 min. */
  workerTimeoutMs?: number;
}

/** Tool whitelist enforced via `omp --tools` (R5). Mirrors the agent file. */
export const HERDR_WORKER_TOOLS = [
  "read", "grep", "glob", "bash", "edit", "write", "lsp", "ast_grep",
] as const;

export class HerdrRuntime implements AgentRuntime {
  constructor(opts: HerdrRuntimeOptions);
  createWorkspace(unit: CeUnit, run: RunState, forkSha: string): Promise<Workspace>;
  startWorkerPhase1(ws: Workspace): Promise<WorkerHandle>;
  startWorkerPhase2(handle: WorkerHandle, prompt: string): Promise<void>;
  wait(handle: WorkerHandle, opts: WaitOpts): Promise<WorkerResult>;
  inspect(handle: WorkerHandle): Promise<WorkerState>;
  cleanup(handle: WorkerHandle, opts: CleanupOpts): Promise<void>;
}
```

The constructor resolves `profile = opts.profile ?? process.env.CE_BEADS_OMP_PROFILE ?? "chinese"`, `model = opts.model ?? process.env.CE_BEADS_WORKER_MODEL ?? "@smol"`, and `ompPath = opts.ompPath ?? resolveOmpBinary()` (resolves the full path to the omp binary, since Herdr's spawn PATH may not include ~/.bun/bin).

Implementation contract (exact command sequences; every herdr invocation
parses the `{"id":…,"result":…}` JSON envelope):

**[v6 SIMPLIFICATION — pi-overseer pattern]** The two-phase startWorker
is preserved for the interface (MockRuntime still uses it), but
HerdrRuntime's `startWorkerPhase1` + `startWorkerPhase2` are collapsed
into a single `herdr agent start` call that delivers the prompt as the
last argv argument to omp. The prompt is delivered atomically with agent
launch — no gap between pane creation and prompt delivery. Phase1 creates
the workspace + returns a handle with `promptLifecycle = "not_sent"` (no
pane yet). Phase2 calls `herdr agent start` with the prompt as argv and
sets `promptLifecycle = "sent"`.

- `createWorkspace`: `git worktree add <worktreeRoot>/<U-ID>-<run-id>-a<N>
  -b ce-beads/<U-ID>-<run-id>-a<N> <forkSha>` where `<N>` is the attempt
  number. Then `mkdir .ce-beads-worker/` inside the worktree, remove any
  stale `result.json` and `.result.tmp`. Returns Workspace. Does NOT write
  `system-prompt.md` or `packet.json` — the engine writes both before
  calling startWorkerPhase2.
- `startWorkerPhase1(ws)`:
  1. Return WorkerHandle with paneId=null, resultFile=<worktree>/.ce-beads-worker/result.json,
     promptLifecycle="not_sent". No pane created yet — the pane is created
     in phase 2 by `herdr agent start`.
- `startWorkerPhase2(handle, prompt)`:
  1. `herdr agent start "ce-beads-<U-ID>-<run-id>"
     --cwd <worktree>
     --workspace <current-workspace-id>
     --split right --no-focus
     --env BEADS_DIR=<mktemp-disposable-dir>
     -- <ompPath> --profile <resolved-profile> --model <resolved-model>
     --no-session
     --tools read,grep,glob,bash,edit,write,lsp,ast_grep
     --append-system-prompt <worktree>/.ce-beads-worker/system-prompt.md
     '<prompt>'` (R5: isolated BEADS_DIR via --env, NO `@` prefix on the
     absolute system-prompt path, prompt is the LAST argv argument to omp).
  2. Parse the `{"result":{"agent":{"pane_id":…}}}` response to extract
     pane_id. Set handle.paneId = pane_id, handle.promptLifecycle = "sent".
  3. The agent is now running with the prompt already queued — no
     send-text/send-keys needed. The prompt was delivered atomically with
     launch.
  4. API key check: `herdr agent read <pane_id> --source visible --lines 12`;
     if it contains `No API key found` → close pane, throw (caller maps to
     `RUNTIME_FAILURE` → outcome `failed`).
- `wait`: loop until `opts.timeoutMs`:
  - **Deterministic path (authoritative, R3):** check
    `fs.existsSync(handle.resultFile)`. If present, read + validate via
    `validateWorkerReport`. On valid → `{ kind: "completed", report }`. On
    invalid → `{ kind: "died", reason: "result file present but invalid" }`.
  - **Advisory fast-path:** `herdr agent get <handle.paneId>`; if agent
    not found before result file exists → `{ kind: "died", reason: <stderr> }`.
    If `agent_status === "idle"` for a sustained period AND the result file
    is absent, log a warning but keep polling (lifecycle lags; the file is
    the truth).
- `inspect`: `herdr agent get <handle.paneId>` → agent not found → `dead`;
  result file exists → `finished`; `agent_status === "working"` → `running`;
  else `unknown`.
- `cleanup`: per `CleanupOpts`:
  - `opts.pane === "close"`: `herdr pane close <handle.paneId>` (best-effort).
  - `opts.worktree === "remove"`: `git worktree remove --force <path>`.
  - `opts.branch === "remove"`: `git branch -D <branch>`.
  - `opts.worktree === "preserve"` and `opts.branch === "preserve"`: do
    nothing (leave for human inspection).
### 2.6 `orchestrator.ts` — the RunEngine

```ts
// orchestrator.ts — serial control loop + integrate-before-close state
// machine. Runtime-agnostic: constructed with any AgentRuntime.
// Commit capture lives HERE (P1-4/P1-5), not in the runtime.

export interface RunEngineOptions {
  repoRoot: string;
  beadsDir: string;                 // BEADS_DIR env or join(repoRoot, ".beads")
  runtime: AgentRuntime;
  /** Worker wait timeout forwarded to runtime.wait; default 30 min. */
  workerTimeoutMs?: number;
}

export class RunEngine {
  constructor(opts: RunEngineOptions);

  /**
   * run start: parse plan → verify binding (NOT_BOUND refusal if unbound;
   * the coordinator agent runs the existing `bind` preview→approval→apply
   * flow first) → refuse on active run for the plan (RUN_ACTIVE — includes
   * blocked + failed-with-unfinished, P1-3) → **write an initializing
   * run-state FIRST** (status=in_progress, base_sha, plan_path,
   * plan_digest, empty units — persisted BEFORE any integration worktree
   * creation so a crash during setup is recoverable) → create integration
   * branch + integration worktree → update run-state with
   * integration_branch + integration_worktree → drive loop.
   */
  start(planPath: string, opts?: { once?: boolean }): Promise<ProtocolEnvelope>;

  /**
   * run resume: load run-state → reconcile in-flight unit via the 6-state
   *
   * When opts.retry is true and a unit is blocked, the engine reads the
   * unit's last_successful_state and re-enters the loop at the correct
   * step for that state (see loop step 2b for the full routing table:
   * captured→5d verify, merged→5f verify, verified→5g close, claimed→4d
   * re-launch worker, worker_finished with blocked/failed report→4d
   * re-launch worker, worker_finished with complete report→5b capture).
   * Merge-conflict blocks are NOT auto-retried (human must resolve).
   *
   * In the serial MVP, a blocked run STOPS — the loop does not skip
   * blocked units and continue to others. --retry is the only way to
   * re-attempt a blocked unit. Without --retry, resume on a blocked
   * run returns outcome "blocked" immediately.
   */
  resume(runId: string, opts?: { once?: boolean; retry?: boolean }): Promise<ProtocolEnvelope>;

  /** Read-only snapshot: run-state + live ready-count cross-check. */
  status(runId?: string): Promise<ProtocolEnvelope>;

  /**
   * run reap: refuse (RUN_ACTIVE) if run-state.status === "in_progress"
   * unless opts.force. Preview the cleanup plan (panes/worktrees/branches
   * to be affected) and require caller approval before any destructive
   * op. For each non-closed unit with workspace records: runtime.cleanup
   * with opts.destructive=opts.force. Preserves failed worktrees when
   * !opts.force. Removes the integration worktree only when !opts.force
   * is false. NEVER closes, updates, or otherwise mutates Beads tasks.
   * Acquires the run lock for the whole reap; --force must not race a
   * still-running coordinator (lock check). Validates every resolved
   * path/branch belongs to the run before removal. Marks run-state
   * "failed" (P1-5).
   *
   * Approval: without opts.applyToken, returns a preview (the ordered
   * cleanup set + a fingerprint of run-state). With opts.applyToken,
   * re-acquires the run lock, reproduces the token, and executes the
   * cleanup. Token mismatch → refused, zero mutations (same pattern as
   * bind/sync).
   */
  reap(
    runId: string,
    opts?: { force?: boolean; applyToken?: string },
  ): Promise<ProtocolEnvelope>;

  /**
   * run abandon: releases coordinator-owned Beads state for a blocked/failed
   * run. For each non-closed unit (per the preview):
   *
 * Beads mutation contract (verified against bd 1.1.0):
 * 1. Read back the task via `bd show <id> --json`. Verify
 *    `metadata.ce_beads_run_id === run.run_id` — this is the ownership
 *    proof, NOT assignee equality (assignee can be changed without
 *    unclaiming). If run_id doesn't match → EXTERNAL_CHANGE, skip.
 * 2. Reopen: `bd update <id> --status open --assignee "" --json`.
 *    NOTE: `bd assign <id> ""` only clears the assignee but does NOT
 *    change status from in_progress back to open. Use `bd update` with
 *    both --status open and --assignee "" together. Extend
 *    BeadsClient.update() to accept `status?: string` and
 *    `assignee?: string` (test using `!== undefined`).
 * 3. Remove coordinator labels: `bd update <id> --remove-label
 *    ce-beads:worker-finished` (and ce-beads:blocked, ce-beads:claimed,
 *    etc. — every ce-beads:* label this run added).
 * 4. Clear coordinator metadata: `bd update <id> --unset-metadata
 *    ce_beads_run_state --unset-metadata ce_beads_blocker_reason
 *    --unset-metadata ce_beads_run_id` (use --unset-metadata, NOT
 *    --metadata key= which is not the clearing API).
 * 5. Read back the task to confirm: status === open, assignee === null,
 *    ce_beads_run_id absent, ce-beads:* labels absent. Only then mark
 *    this task as released.
 * 6. Partial failure: if any single task's mutation fails, record it as
 *    PARTIAL_APPLY, continue to the next task. At the end, if any
 *    PARTIAL_APPLY occurred, the run is marked "failed" (not
 *    "abandoned") and the outcome includes PARTIAL_APPLY diagnostics.
 *    The human can retry abandon or reap.
 * 7. Only tasks with ce_beads_run_id === run.run_id are restored —
 *    verified by the read-back in step 1.
   *
   * After all tasks processed: mark run-state "abandoned". Does NOT close
   * or delete Beads tasks. Does NOT delete worktrees or branches (use reap
   * for that). Requires preview→apply approval (same token pattern as reap).
   */
  abandon(runId: string, opts?: { applyToken?: string }): Promise<ProtocolEnvelope>;
}
```

The loop (one iteration; mirrors the brief's control loop §2–3, with P0-1
and the 6-state machine applied):

```text
1. readyTasks = client.readyTasks(plan.path)            // existing beads-client method
   inFlight = units in run-state with state in {claimed, worker_finished,
              captured, merged, verified}
2. If inFlight has a unit at state >= worker_finished and < closed →
   go to INTEGRATE (step 5), resuming from the persisted state (reconcile
   Git + Beads read-back first per run-state.ts doc).
3. If no inFlight and readyTasks empty → all closed? verify roster:
   every run-state unit closed → outcome completed (status=completed,
   finished_at, report integration SHA); else outcome blocked (nothing
   ready, nothing in flight, units remain — dependency wedge).
2b. RETRY RECOVERY (only when invoked with `resume --retry`): scan
   run-state units for any in state "blocked". For each blocked unit:
   NOTE: a unit blocked because report.status was "blocked" or "failed"
   must NOT be retried via capture — the worker produced no capturable
   work. Retry for these units means re-launching the worker (go back to
   step 4 CLAIM with the same unit — re-claim is idempotent, workspace
   is recreated fresh). Check last_successful_state:
     i.   last_successful_state == "claimed" → the worker was never
          launched or died before finishing. Re-attempt claim (idempotent
          if same coordinator), then go to step 4d (createWorkspace) to
          re-launch the worker. Do NOT reuse a stale workspace.
     ii.  last_successful_state == "worker_finished" → the worker
          completed but was blocked at CAPTURE (changed_files validation
          or report.status != "complete"). If report.status was "blocked"
          or "failed", do NOT retry capture — re-launch the worker (step
          4d) instead. If report.status was "complete" but capture
          failed, retry from step 5b CAPTURE.
     iii. last_successful_state == "captured" → capture succeeded but
          pre-merge verification failed. Do NOT re-capture. Resume at
          step 5d VERIFY (pre-merge) — re-run the unit's
          verification_commands. If they pass now (e.g. a flaky test),
          proceed to 5e MERGE.
     iv.  last_successful_state == "merged" → merge succeeded but
          post-merge verification failed. Do NOT re-merge. Resume at
          step 5f VERIFY (post-merge) — re-run verification_commands in
          the integration worktree. If they pass, proceed to 5g CLOSE.
     v.   last_successful_state == "verified" → verification passed
          but close failed (bd error). Reconcile: read back Beads task
          status via `bd show <id> --json`. If already closed (close
          succeeded but state wasn't saved), advance to closed. If still
          open, re-attempt step 5g CLOSE.
     vi.  Merge-conflict retry: if blocked at MERGE due to a conflict,
          --retry does NOT auto-resolve. The human must resolve the
          conflict or abort. Retry refuses with RUN_ACTIVE (the merge
          is left for human inspection). Use `run abandon` to release
          the Beads task if abandoning the merge.
     vii. last_successful_state is null AND no recoverable prior state:
          leave blocked, emit a diagnostic naming the unit. The user
          must decide (abandon or manually intervene).
   When no blocked unit has a recoverable last_successful_state, this
   step is a no-op. (FIX 1.)
   NOTE: in the serial MVP, a blocked run STOPS — the loop does not
   continue to other units while one is blocked. R6: "a blocked run
   stops." --retry is the explicit way to re-attempt the blocked unit.
3. If no inFlight and readyTasks empty → all closed? verify roster:
4. CLAIM (per-mutation persist; packet built AFTER workspace exists):
   a. **Order by CE plan, not by bd (FIX 5):** sort readyTasks by the
      plan unit roster (plan.units order: U1, U2, U3, …). Take the
      first → map to its U-ID via metadata ce_unit_id. (bd's incidental
      ready ordering is NOT authoritative for serial execution; the
      plan's dependency order is.)
   b. **Atomic claim with run_id:** client.update(id, {
        claim: true,
        setMetadata: { ce_beads_run_id: run.run_id }
      }); This atomically claims the task AND attaches the run_id so
      that even if the coordinator crashes before saving run-state,
      a subsequent `run start` can detect the orphaned claim via
      `bd list --metadata ce_beads_run_id=<run_id>` and refuse
      (RUN_ACTIVE). Persist state "claimed", claimed_at in run-state.
   c. **P0-1:** forkSha = git rev-parse HEAD in the integration worktree
      (NOT run.base_sha). Persist forkSha as RunUnitRecord.worker_base_sha.
      run-state save after this external mutation (bd write).
   c1. **FIX 3 — run-state save BEFORE createWorkspace:** the claim
      and forkSha are now durable; persist the run-state AGAIN
      immediately before invoking createWorkspace. This guarantees
      that a crash any time after the claim but before the
      workspace exists leaves a recoverable record (the unit is
      claimed, with a known forkSha, awaiting a workspace). Without
      this, a crash between claim and workspace creation leaves
      the run-state claiming a workspace that was never built.
   d. **FIX 1 (order):** runtime.createWorkspace(unit, run, forkSha)
      FIRST. It returns { unitId, worktreePath, branch }.
      run-state save (worker_branch, worktree_path set) IMMEDIATELY,
      BEFORE startWorker — crash-safety: a crash here leaves a
      recoverable workspace, not an orphan pane. (FIX 2.)
   e. Derive resultFile = <worktreePath>/.ce-beads-worker/result.json.
      Now build packet via buildWorkerPacket(plan, unit,
      verificationCommands, { runId, beadsId, baseSha: forkSha,
      branch: ws.branch, worktreePath: ws.worktreePath }) — packet's
      branch / worktree_path / result_file are real, not null.
   f. Write worker artifacts into the worktree (FIX 1):
      - <worktreePath>/.ce-beads-worker/system-prompt.md  (the ce-beads-unit
        agent body, R9)
      - <worktreePath>/.ce-beads-worker/packet.json      (the WorkerPacket)
      Write atomically (tmp + rename). NEVER commit these into the worker
      branch (artifact exclusion, P1-4).
   g. **FIX 1 (order, continued) + FIX 2 (split startWorker into two
      phases):** startWorker is now decomposed into TWO independent
      phases. The split is REQUIRED: a crash between pane creation
      and prompt delivery previously left an orphan pane that
      nothing could rediscover.
        · g1. **startWorker PHASE 1 — create the pane and detect the
          agent:** runtime.startWorkerPhase1(ws) performs (a) herdr
          pane split, (b) rename to `ce-beads-<U-ID>-<run-id>`, (c)
          launch the omp binary, and (d) poll until the agent is
          detected as ready to receive a prompt. It returns
          { workerPaneId, worktreePath, branch }. Persist
          `worker_pane_id` IMMEDIATELY after phase 1 returns, BEFORE
          phase 2 begins. A crash between phase 1 and phase 2 is
          recoverable: the run-state has a pane_id, the pane exists
          in herdr with the canonical label, and `resume` (without
          `--retry`) can rediscover it by label
          (`ce-beads-<U-ID>-<run-id>`) and call phase 2 on it.
        · g2. **startWorker PHASE 2 — send the prompt:** with the
          pane id persisted, runtime.startWorkerPhase2(ws, prompt)
          sends the prompt text (which references the on-disk packet
          and system prompt by path, P0-3) to the already-running
          pane. The prompt is delivered to the existing pane; phase
          2 does NOT create or rename anything. After phase 2
          returns, persist a "worker launched" marker on the
          run-state so a future resume can distinguish
          "pane exists, prompt not yet sent" from "pane exists,
          prompt sent, awaiting result".
      (FIX 2: persist after every external mutation. The label
      `ce-beads-<U-ID>-<run-id>` is the recovery handle — the resume
      path uses herdr's pane listing to find an orphan pane by
      label, then re-invokes phase 2 with the persisted prompt.)
   h. runtime.wait (file-poll on handle.resultFile, R3):
      - completed (file exists) → load + validateWorkerReport →
        **FIX 3 (branch on status BEFORE capture):**
          · report.status === "complete" → persist result; state →
            "worker_finished"; client.update(id,
            { setMetadata: { ce_beads_run_state: "worker_finished" }, addLabel:
            ["ce-beads:worker-finished"] }); proceed to INTEGRATE
            (step 5).
          · report.status === "blocked" → state → "blocked";
            last_successful_state = "worker_finished";
            blocker_reason = report.blockers; client.update(id,
            { setMetadata: { ce_beads_run_state: "blocked",
            ce_beads_blocker_reason: report.blockers }, addLabel:
            ["ce-beads:blocked"] }); run-state status "blocked";
            do NOT capture, do NOT merge, do NOT close. Return
            outcome blocked with WORKER_BLOCKED. Worktree preserved.
          · report.status === "failed" → state → "blocked";
            last_successful_state = "worker_finished";
            blocker_reason = report.blockers || "worker reported
            failure"; client.update(id, { setMetadata:
            { ce_beads_run_state: "blocked",
            ce_beads_blocker_reason: blocker_reason }, addLabel:
            ["ce-beads:blocked"] }); run-state status "failed";
            do NOT capture, do NOT merge, do NOT close. Return
            outcome failed with WORKER_FAILED. Worktree preserved.
- timeout|died → runtime.cleanup(handle, { pane: "close", worktree: "preserve", branch: "preserve" })
        (PRESERVE the worktree for inspection, P1-5); client.update(id,
        { setMetadata: { ce_beads_run_state: "blocked" }, addLabel:
        ["ce-beads:blocked"] }); state → "blocked"; run-state status
        "failed" (died) or "blocked" (timeout); return outcome
        failed|blocked with WORKER_FAILED.
5. INTEGRATE (coordinator-owned, integrate-before-close, 6-state):
   a. If state == worker_finished: re-validate result file. If invalid →
      blocked (WORKER_REPORT_INVALID). If valid, advance to captured.
   b. CAPTURE (P1-4/P1-5, engine-owned): if state == worker_finished:
      **FIX 4 — validate changed_files BEFORE staging, with TWO-WAY
      EQUALITY between the report and git status.**
        i.   Per-path validation (the existing per-path rules). For
             each path in report.changed_files:
               · Must be repo-relative (NOT absolute; no leading "/";
                 resolved with path.resolve(worktreePath, p) must
                 stay under worktreePath — rejects `..` escaping).
               · Must NOT be under `.ce-beads-worker/` (artifact
                 exclusion, P1-4).
               · Must NOT be the CE plan file itself (SD7: plans
                 immutable).
        ii.  Collect the SURVIVING validated paths as the
             `validatedSet` (Path objects, resolved relative to the
             worktree root).
        iii. Collect the ACTUAL non-artifact modified paths from git
             status, parsed robustly:
               `git -C <unit-worktree> status --porcelain=v1 -z`
             The `-z` flag uses NUL separators and avoids quoting
             issues with spaces / unicode in filenames. For each
             record, the XY status field (first two bytes) indicates
             the change type. **For this MVP, REJECT renames and
             copies outright:** if XY starts with `R` (rename) or
             `C` (copy), the record uses a NUL-delimited format with
             two paths (source and destination) — there is no textual
             ` -> ` separator in `-z` output. Rather than parse the
             two-path rename format, mark the unit blocked with
             CHANGED_FILES_INVALID ("renames/copies not supported in
             serial MVP") and preserve the worktree for human
             inspection. This avoids incorrect path extraction.
             For non-rename records (XY is not R or C): drop the XY
             field (first two bytes) and the following space, then
             resolve the remaining path relative to the worktree root.
             Filter out any path under `.ce-beads-worker/` (artifacts).
             The remaining set is `actualSet`.
        iv.  Compute the two diffs required for EQUALITY:
               · reportedOnly = validatedSet − actualSet
                 (paths the worker declared but did NOT actually
                 modify)
               · actualOnly = actualSet − validatedSet
                 (paths the worker actually modified but did NOT
                 declare)
             Use `path.relative(worktreePath, p)` for containment
             checks so that two strings representing the same file
             are recognized as equal regardless of trailing
             separators or `./` prefixes.
        v.   If reportedOnly is non-empty OR actualOnly is non-empty,
             the two sets are NOT equal → mark unit blocked with
             diagnostic `CHANGED_FILES_INVALID`. The blocker_reason
             MUST list both:
               · "undeclared modification: <sorted actualOnly…>"
               · "declared but not modified: <sorted reportedOnly…>"
             Do NOT stage. Do NOT advance state. Return outcome
             blocked. Worktree preserved for human inspection.
             (A worker that touches files it didn't list, OR
             claims files it didn't touch, is a contract violation;
             equality is the only correct invariant.)
        vi.  Equality confirmed: stage ONLY the surviving validated
             paths, explicitly:
             `git -C <unit-worktree> add -- <validated-paths…>`
             (NEVER `git add -A` and NEVER `git add .`). Then
             `git -C <unit-worktree> commit -m "ce-beads(<U-ID>):
             worker changes (<run-id>)"`. Persist worker_commit_sha.
             State → "captured". run-state save. (FIX 2.)
             (This step moves the commit capture OUT of
             HerdrRuntime.wait into the engine, so MockRuntime and
             HerdrRuntime exercise the identical commit path.
             MockRuntime's startWorker no longer commits.)
   c. Inspect diff: git diff --stat <worker_base_sha>..<worker-branch>
      (recorded in diagnostics as info; empty diff + status complete →
      WORKER_FAILED, block, preserve worktree).
   d. VERIFY (pre-merge, R8): run the unit's verification_commands
      sequentially (bash -c, cwd = unit worktree). Non-zero →
      VERIFICATION_FAILED, mark blocked.
   e. MERGE: if state < merged: git -C <integration-worktree> merge
      --no-ff -m "ce-beads(<U-ID>): merge worker branch (<run-id>)"
      <worker-branch> (R11: noninteractive -m). Conflict →
      INTEGRATION_FAILED, mark blocked (merge left for human). Persist
      merge_sha; state → "merged". run-state save. (FIX 2.)
   f. VERIFY (post-merge, R8): re-run the unit's verification_commands
      in the integration worktree. Non-zero → INTEGRATION_FAILED, mark
      blocked (merge left for human inspection, task NOT closed).
      state → "verified". run-state save. (FIX 2.)
   g. CLOSE (the ONLY close call site in the engine): if state == verified:
      client.close(beads_id); persist integrated_sha = git rev-parse HEAD
      in the integration worktree; state → "closed"; run-state save
      (FIX 2 — last durable mutation before pane cleanup).
      runtime.cleanup(handle, { pane: "close", worktree: "remove", branch: "remove" }) (worker branch
      merged, worktree safe to remove).
6. Return per --once semantics; otherwise loop.
```

Marking helpers use only existing `BeadsClient.update` (setMetadata /
addLabel / claim) and `BeadsClient.close` — no new bd surface. The state
labels (`ce-beads:worker-finished`, etc.) are `in_progress` + metadata,
exactly as the brief's state machine requires.

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
  inFlight: string | null;          // U-ID currently in flight
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

## 3. `agents/ce-beads-unit.md` — exact content

**[R9]** Lives at `agents/ce-beads-unit.md` in the package root (shipped via
`package.json` `files`). Frontmatter from the brief; body is the single
source also rendered into `.ce-beads-worker/system-prompt.md` by
`worker-prompt.ts`.

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
  required: [u_id, status, changed_files, verification_evidence, blockers]
---

You are ce-beads-unit, a restricted implementation worker. You implement
exactly ONE bounded unit from a CE plan, inside the current worktree. A
coordinator owns all coordination; you own only the code in front of you.

## Hard rules (never violated)

1. Implement ONLY the bounded unit packet provided in the prompt. Do not
   refactor adjacent code, do not implement other units, do not "help"
   beyond the packet's Files and Approach.
2. Run ONLY the verification commands listed in the packet's
   `verification_commands`. The `unit.verification` field is acceptance
   PROSE describing expected behavior — never execute it as shell.
3. NEVER run `bd` (any subcommand). Beads is the coordinator's exclusive
   domain. Your worktree has no Beads workspace; do not create one. (This
   is a defense-in-depth rule, not a physical boundary — the coordinator
   validates your work and owns all Beads writes.)
4. NEVER commit, push, merge, rebase, or create branches with git. The
   coordinator owns all integration and commits your changes on your
   behalf after you finish. Even a "temporary" commit is forbidden.
5. NEVER spawn sub-agents. You have no `task` tool; do not attempt to.
6. Keep every change inside the current worktree. Do not write outside it.
7. Do not modify the CE plan file. Plans are immutable.

## Completion protocol

When the unit is done (or you are blocked):

1. Write your structured report to the path given in the packet's
   `result_file` field. Write to a temp file first
   (`.ce-beads-worker/.result.tmp`), then rename it atomically to
   `.ce-beads-worker/result.json`. The rename is how the coordinator
   knows you are done — it polls for the file's existence, not for any
   text in your output.
2. Schema: `schema_version: "ce-beads-worker-report/1"`; required keys:
   `u_id`, `status`, `changed_files`,
   `verification_evidence{commands,results}`, `blockers`; optional:
   `notes`. `status` is `complete` | `blocked` | `failed`. `blockers` is
   non-empty iff `status` is `"blocked"`.
3. After the rename succeeds, you may print `CE_BEADS_RESULT:<run-id>:<U-ID>`
   as a human-visible breadcrumb. This is advisory only — the coordinator
   does not search for it. Do not print it before the file is in place.

The coordinator detects completion by polling the result file. Never
print the result JSON to the pane as the completion mechanism — the file
is the signal.
```

The initial user prompt delivered to the pane (rendered by
`renderWorkerPrompt(packet)` in `worker-prompt.ts`):

```text
Implement this bounded ce-beads unit. Your instructions are in your system
prompt. The packet:

<pretty-printed WorkerPacket JSON>

Reminder: write the report to <absolute result_file path> atomically
(write-temp-then-rename). The coordinator polls for the file's existence.
```

Note [P0-3]: the prompt no longer contains a sentinel string the adapter
will search for, because the adapter does not search scrollback at all.
The `CE_BEADS_RESULT:<run-id>:<U-ID>` breadcrumb may appear in the prompt
text (as an instruction to print it) without consequence, because it is
not a detection mechanism.

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
  | "blocked"               // unit blocked (verification/report/worker); loop STOPPED (serial MVP: no skip)
  | "failed"                // infrastructure failure; run-state intact; resumable
  | "reaped"                // run reap completed (apply-token matched)
  | "abandoned"             // run abandon completed (Beads tasks released, apply-token matched)
  | "preview"               // run reap/abandon without --apply: cleanup/release plan + fingerprint, zero mutations
  | "not_found"             // run status/resume/reap/abandon: unknown run-id
  | "refused";              // precondition refusal (NOT_BOUND, RUN_ACTIVE, LOCK_BUSY, TOKEN_MISMATCH)

export type Outcome =
  | DoctorOutcome | BindOutcome | StatusOutcome | SyncOutcome
  | PacketOutcome | RunOutcome;
```
### Reap/abandon preview/apply payload

```ts
// Reap and abandon both return "preview" without --apply, and "reaped" /
// "abandoned" with a matching token — same pattern as bind/sync.
// The token is SHA-256 over a canonical payload that includes the subcommand
// (reap|abandon), the run-state fingerprint, the live target fingerprint
// (current Beads task states + git branch HEADs), the force mode, and the
// ordered operations list. This binds the approval to the exact state at
// preview time — any drift invalidates the token.

export interface ReapCleanupEntry {
  unit_id: string;
  beads_id: string;
  worker_pane_id: string | null;
  worktree_path: string | null;
  worker_branch: string | null;
  /** Separate actions for pane, worktree, branch (reap preview fix). */
  pane: "close" | "preserve";
  worktree: "preserve" | "remove";
  branch: "preserve" | "remove";
}

export interface AbandonReleaseEntry {
  unit_id: string;
  beads_id: string;
  /** Current assignee in Beads (must match this run's coordinator; refuse if changed). */
  current_assignee: string | null;
  /** Labels to remove (ce-beads:* labels added by this run). */
  labels_to_remove: string[];
  /** Metadata keys to clear (ce_beads_run_state, ce_beads_blocker_reason, etc.). */
  metadata_to_clear: string[];
}

export interface ReapPreviewData {
  run_id: string;
  run_status: RunStatus;
  cleanup_entries: ReapCleanupEntry[];
  integration_worktree: { path: string; worktree: "preserve" | "remove"; branch: "preserve" | "remove" };
  /** SHA-256 over canonical (subcommand, run-state-fingerprint, live-fingerprint, force, operations). */
  approval_token: string;
}

export interface AbandonPreviewData {
  run_id: string;
  run_status: RunStatus;
  release_entries: AbandonReleaseEntry[];
  /** SHA-256 over canonical (subcommand, run-state-fingerprint, live-fingerprint, operations). */
  approval_token: string;
}
```

Diagnostic codes (append to `DiagnosticCode`):

```ts
  | "UNIT_NOT_FOUND"            // packet: no such U-ID in the plan
  | "NOT_BOUND"                 // run start: plan has no binding in Beads
  | "RUN_ACTIVE"                // run start/reap: a non-terminal run exists (includes blocked + failed-with-unfinished, P1-3)
  | "RUN_NOT_FOUND"             // status/resume/reap/abandon: unknown run-id
  | "RUN_STATE_CORRUPT"         // run-state file unparsable / wrong schema_version
  | "WORKER_FAILED"             // worker died / timed out / empty diff
  | "WORKER_REPORT_INVALID"     // result file present but failed validation
  | "WORKER_BLOCKED"            // worker report status was "blocked"
  | "VERIFICATION_FAILED"       // pre-merge unit verification non-zero
  | "INTEGRATION_FAILED"        // merge conflict or post-merge verification non-zero
  | "CHANGED_FILES_INVALID"     // changed_files failed validation (escaping, artifacts, unreported, unreported-mod)
  | "RUNTIME_FAILURE"           // Herdr CLI errors, pane lost, API-key error
  | "PLAN_DIGEST_DRIFT"         // resume: plan file edited since run start
  | "TOKEN_MISMATCH"            // reap/abandon/sync apply: token does not match preview
  | "EXTERNAL_CHANGE"           // abandon: Beads task assignee changed since preview
  | "PARTIAL_APPLY";            // abandon: some mutations applied, some failed
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
  if (diagnostics.some((d) => d.code === "PLAN_DIGEST_DRIFT")) return ExitCode.CONFLICT;
  if (diagnostics.some((d) => d.code === "CHANGED_FILES_INVALID")) return ExitCode.CONFLICT;
  if (diagnostics.some((d) => d.code === "TOKEN_MISMATCH")) return ExitCode.CONFLICT;
  if (diagnostics.some((d) => d.code === "EXTERNAL_CHANGE")) return ExitCode.CONFLICT;
  // WORKER_BLOCKED maps to "blocked" outcome → already CONFLICT via existing branch
  // PARTIAL_APPLY maps to ExitCode.PARTIAL

  // Outcome mappings (with the existing outcome checks, after "preview"/"partial").
  if (outcome === "failed") return ExitCode.PARTIAL;      // resumable, state persisted
  if (outcome === "not_found") return ExitCode.USAGE;
  if (diagnostics.some((d) => d.code === "PARTIAL_APPLY")) return ExitCode.PARTIAL;
  // "blocked" and "refused" already map to CONFLICT via the existing branch.
  // "packet_built" | "in_progress" | "awaiting_integration" | "completed"
  // | "reaped" | "abandoned" | "preview" fall through to SUCCESS.
```

---

## 5. `cli.ts` dispatch changes

Minimal, in the existing style. `CliArgs` gains four fields; `parseArgs`
gains two parse branches + `--force` rejection outside reap (R11); `main`
gains two dispatch entries.

```ts
export interface CliArgs {
  action: Action;
  planPath: string | undefined;   // packet/run start: plan; run status/resume/reap/abandon: run-id
  json: boolean;
  applyToken: string | undefined;
  help: boolean;
  unitId: string | undefined;     // packet <plan> <U-ID>
  runSub: "start" | "status" | "resume" | "reap" | "abandon" | undefined;
  once: boolean;                  // run start/resume --once
  retry: boolean;                 // run resume --retry: re-enter blocked unit from last_successful_state
  force: boolean;                // run reap --force ONLY (R11: rejected elsewhere)
}
```

Parsing rules (replace the current allowlist + positional loop):

```text
- Allowlist: ["doctor","bind","status","sync","packet","run"].
- action === "packet": first positional → planPath; second positional →
  unitId. Missing either → usage (exit 2).
- action === "run": args[1] must be one of start|status|resume|reap|abandon →
  runSub; args[2] (positional) → planPath slot (plan path for start; run-id
  for status/resume/reap/abandon; optional for status — omitted means latest
  run). Unknown/missing sub → usage.
- Flags: --json, --apply <token>, --help/-h as today; add --once,
  --retry, and --force. **R11: --force is rejected (usage, exit 2) unless
  action === "run" && runSub === "reap".** --once is rejected unless
  action === "run" && (runSub === "start" || runSub === "resume").
  **--retry is rejected (usage, exit 2) unless action === "run" &&
  runSub === "resume".** --retry is passed as opts.retry into RunEngine.resume.
```

`usageMessage()` additions (match existing column style):

```text
  packet <plan> <U-ID>  Read-only bounded worker packet for one unit
  run start <plan>      Start a serial run (verify binding, init run-state, drive loop)
  run status [run-id]   Read-only run snapshot (latest run when omitted)
  run resume <run-id>   Re-attach to an in-flight worker / resume the loop
  run reap <run-id>     Clean up orphaned worktrees/panes (never touches Beads)
  --once               Execute a single loop iteration (start/resume only)
  --retry              Re-enter a blocked unit from its last_successful_state (resume only)
  --force              Reap even when the run-state says in_progress (reap only)
```

`main()` dispatch:

```ts
  const handlers: Record<Action, ActionHandler> = {
    doctor: doctorHandler,
    bind: bindHandler,
    status: statusHandler,
    sync: syncHandler,
    packet: packetHandler,   // from "../../ce-beads-work/scripts/packet.ts"
    run: runHandler,         // from "../../ce-beads-work/scripts/run.ts"; dispatches start/status/resume/reap/abandon
  };
```

`runHandler` dispatches `args.runSub === "abandon"` to
`RunEngine.abandon(runId, { applyToken: args.applyToken })`.

Usage-gate change: the current gate `args.action !== "doctor" &&
!args.planPath` must become action-aware: `doctor` needs nothing; `status`
(existing) needs a plan; `packet` needs plan + unitId; `run start` needs a
plan; `run status` needs nothing; `run resume|reap|abandon` need a run-id.
Implement as a small `needsArg(args)` predicate — do not special-case
inline in `main` beyond the existing pattern.

Locking: `packet` and `run status` are read-only → **no lock** (same as the
existing `status` action). `run start`/`run resume` acquire the plan-path
`LockHolder` for the whole invocation (they mutate Beads: claim, metadata,
labels, close). `run reap` without `--apply`: no lock (read-only preview).
`run reap --apply <token>`: acquires the plan-path `LockHolder` (mutating:
removes worktrees/branches). Reap's safety gate is the RUN_ACTIVE run-state
check (+ `--force`) and the apply-token match; it never touches Beads.
`run abandon` without `--apply`: no lock (preview). `run abandon --apply
<token>`: acquires the plan-path `LockHolder` (mutating: unclaims Beads
tasks).


## Public configuration

The orchestrator reads these environment variables (with constructor-option overrides for tests):

- `CE_BEADS_OMP_PROFILE`: OMP profile for coordinator and workers (default: `"chinese"`)
- `CE_BEADS_WORKER_MODEL`: worker model role (default: `"@smol"`)

---

## 6. Per-component test list

Conventions (from existing tests): Bun (`bun test --timeout 30000`), real
`bd` via `setupWorkspace()` from `tests/helpers/beads-workspace.ts`,
`devRepoIsolationGuards()` for any test that could touch the dev repo,
fixtures under `tests/fixtures/`. New helpers:

- `tests/helpers/git-repo.ts`: `setupGitRepo()` — mkdtemp, `git init -b
  main`, configure user, write fixture plan + seed files, initial commit;
  returns `{ dir, cleanup }`. The orchestrator's `repoRoot` points here, so
  plans parse (PATH_OUTSIDE_REPO passes) and worktrees/merges run against
  real git. Sets `GIT_DIR` to an isolated temp dir so run-state files
  (R10) don't leak.
- `tests/helpers/mock-runtime.ts`: `makeMockRuntime(script)` constructs a
  MockRuntime with a per-U-ID script of files-to-write, report-to-emit,
  and optional failure modes.

| # | Test (file: name) | Invariant defended | Fixture(s) |
|---|-------------------|--------------------|------------|
| T1 | packet.test.ts: builds a correct bounded packet | `packet` emits `packet_built`; packet fields verbatim from plan IR; beads_id null when unbound; verification_commands parsed from Verification Contract (R8) | 02-linear-three-unit.md (unbound, no workspace) |
| T2 | packet.test.ts: resolves beads_id when bound | After `bind --apply`, packet for U2 carries the created task id | 02-linear-three-unit.md + isolated workspace |
| T3 | packet.test.ts: unknown unit | `unit_not_found` outcome + `UNIT_NOT_FOUND` diagnostic + exit 2 | 02-linear-three-unit.md, U-ID "U9" |
| T4 | packet.test.ts: malformed plan rejected | PLAN_MALFORMED diagnostic, non-zero exit, zero bd calls | 10-malformed-frontmatter.md |
| T5 | run-state.test.ts: round-trip | save→load preserves every field; atomic rename leaves no tmp file; schema_version enforced | synthetic RunState |
| T6 | run-state.test.ts: corrupt/missing | loadRunState throws RUN_STATE_CORRUPT / RUN_NOT_FOUND distinguishably | hand-written corrupt JSON |
| T7 | run-state.test.ts: findActiveRunForPlan includes active + failed-with-unfinished | Returns in_progress, blocked, AND failed runs that own unfinished tasks (at least one unit in claimed/worker_finished/captured/merged/verified/blocked). Completed runs and failed runs with all units closed are NOT active. | synthetic states |
| T8 | run-state.test.ts: R10 location | run state lives under `$GIT_DIR/ce-beads/`, not repo root; consumer repo working tree stays clean | isolated GIT_DIR |
| T9 | worker-report.test.ts: valid reports accepted | valid-complete + valid-blocked pass; blockers non-empty iff blocked | worker-reports/valid-*.json |
| T10 | worker-report.test.ts: invalid reports rejected | missing fields, bad status enum, non-JSON, wrong schema_version all → ok:false | worker-reports/invalid-*.json |
| T11 | plan-parser.test.ts: Verification Contract + requirement defs + KTDs | R8: parses VC table into typed entries; maps U-IDs to commands; tolerates empty table. Also parses requirement definitions (R-ID → text) and KTD excerpts (KTD-ID → text); selects per-unit KTDs by matching unit requirement IDs; verifies packet includes `requirement_defs` and `ktd_excerpts` with correct content | 02-linear-three-unit.md, 17-work-failing-verification.md |
| T12 | orchestrator.test.ts: full serial loop end-to-end | MockRuntime; 3-unit linear plan: claim U1 → worker → capture → verify → merge → verify → close; then U2, U3; final outcome completed; integration branch contains all units' files; each task's `closed_at` set only AFTER its `merge_sha` recorded | 02-linear-three-unit.md + setupGitRepo + MockRuntime |
| T13 | orchestrator.test.ts: **integrate-before-close invariant** | Drive with --once; after worker-finished, task is `in_progress` with `ce-beads:worker-finished` label and NOT closed; `bd ready` does NOT yet list U2; only after the full integrate cycle does U1 close and U2 become ready. Assert close-time ordering: no `close` call occurs before merge + verification in a spy-wrapped client. Grep-verifiable single-close-call-site (§8.5). | 02-linear-three-unit.md |
| T14 | orchestrator.test.ts: **worker-base-sha freshness (P0-1)** | U2's worker_base_sha equals the integration worktree HEAD AFTER U1 was merged, NOT run.base_sha. U2's worktree contains U1's implementation (use fixture 18 where U2 imports U1's code). Verify by reading U1's file from U2's worktree. | 18-work-u2-depends-on-u1-impl.md |
| T15 | orchestrator.test.ts: verification failure blocks | Failing-verification fixture: unit claimed, worker "completes", verification_commands fail → task labeled `ce-beads:blocked`, state blocked, NOT merged (integration worktree HEAD unchanged), NOT closed, outcome blocked, `VERIFICATION_FAILED` diagnostic, worktree PRESERVED (P1-5) | 17-work-failing-verification.md |
| T16 | orchestrator.test.ts: invalid worker report blocks | MockRuntime writes invalid result file → WORKER_REPORT_INVALID, blocked, no merge, no close, worktree preserved | 02-linear-three-unit.md |
| T17 | orchestrator.test.ts: **10-state crash recovery (P1-2)** | Crash-simulate at each transition: (a) after claim, before worker finished; (b) after worker_finished, before captured; (c) after captured, before merged; (d) after merged, before verified; (e) after verified, before closed; (f) after close, before marking run-state closed; (g) after integration worktree creation, before initial run-state save; (h) after claim (bd write), before run-state save; (i) after workspace creation (git worktree add), before pane launch; (j) after pane creation (herdr pane split), before prompt delivery. All must be recoverable: resume reads back Git+Beads state and either advances or repeats idempotently. No double-merge, no double-close. | 02-linear-three-unit.md |
| T18 | orchestrator.test.ts: resume after full coordinator death between units | Run U1 via --once steps, then resume: loop picks U2 without re-claiming U1 (U1 closed, U2 ready from bd) | 02-linear-three-unit.md |
| T19 | orchestrator.test.ts: run start refuses unbound / active (incl. blocked and failed-with-unfinished, P1-3) | Unbound plan → refused + NOT_BOUND + exit 4; second start while in_progress → refused + RUN_ACTIVE; start while a blocked run exists for the same plan → refused + RUN_ACTIVE (blocked runs are ownership-active). Start while a failed run exists that owns claimed tasks → refused + RUN_ACTIVE (failed runs with unfinished tasks are ownership-active). Start while a failed run exists where all units are closed → allowed (failed run with no unfinished tasks is NOT active). | 02-linear-three-unit.md |
| T20 | orchestrator.test.ts: **artifact exclusion (P1-4)** | After capture+merge, the integration branch does NOT contain `.ce-beads-worker/` files. `git ls-tree` on the merge commit shows no `.ce-beads-worker/` entries. Engine uses explicit path staging from `report.changed_files`, never `git add -A`. | 02-linear-three-unit.md |
| T21 | orchestrator.test.ts: reap cleans without touching Beads | Crash a run mid-flight; reap (non-force) → panes closed, worktrees/branches PRESERVED, run-state failed; every Beads task status unchanged. Reap with --force → preview shows the plan, approval gates destructive ops, worktrees/branches removed, paths validated to belong to the run. Lock acquired during reap. | 02-linear-three-unit.md |
| T22 | orchestrator.test.ts: status snapshot | After partial run, `run status` reports inFlight U-ID, per-unit 6-state, readyCount; unknown id → not_found + exit 2 | 02-linear-three-unit.md |
| T23a | orchestrator.test.ts: report status blocked → blocked | unit marked blocked, NOT captured/merged/closed, worktree preserved | 02-linear-three-unit.md |
| T23b | orchestrator.test.ts: report status failed → blocked | unit marked blocked, NOT captured/merged/closed, worktree preserved | 02-linear-three-unit.md |
| T23c | orchestrator.test.ts: plan-digest drift on resume | PLAN_DIGEST_DRIFT diagnostic, resume refused | 02-linear-three-unit.md |
| T23d | orchestrator.test.ts: reap token mismatch | refused, zero mutations | 02-linear-three-unit.md |
| T23e | orchestrator.test.ts: path escaping in changed_files | absolute paths, ../escaping, .ce-beads-worker/**, and plan file → CHANGED_FILES_INVALID, unit blocked | 02-linear-three-unit.md |
| T23f | orchestrator.test.ts: unreported modifications | git status has files NOT in changed_files → CHANGED_FILES_INVALID, unit blocked | 02-linear-three-unit.md |
| T23g | orchestrator.test.ts: retry routing — captured → verify | Block unit at captured; `resume --retry`; engine resumes at 5d VERIFY (pre-merge), NOT 5b CAPTURE | 02-linear-three-unit.md |
| T23h | orchestrator.test.ts: retry routing — merged → verify-post | Block unit at merged; `resume --retry`; engine resumes at 5f VERIFY (post-merge), NOT 5e MERGE | 02-linear-three-unit.md |
| T23i | orchestrator.test.ts: retry routing — verified → close reconcile | Block unit at verified; `resume --retry`; engine reads back Beads; if already closed, advances; if open, re-attempts 5g CLOSE | 02-linear-three-unit.md |
| T23j | orchestrator.test.ts: retry routing — blocked report → re-launch worker | Unit blocked with report.status="blocked"; `resume --retry`; engine re-launches worker (step 4d), NOT capture | 02-linear-three-unit.md |
| T23k | orchestrator.test.ts: merge-conflict retry refuses | Unit blocked at MERGE due to conflict; `resume --retry` refuses (human must resolve); run stays blocked | 02-linear-three-unit.md |
| T23l | orchestrator.test.ts: abandon preview/apply | `run abandon` without --apply returns preview with AbandonReleaseEntry[]; with matching token releases tasks (bd assign "", remove labels/metadata); with wrong token → TOKEN_MISMATCH, zero mutations | 02-linear-three-unit.md |
| T23m | orchestrator.test.ts: abandon external change | Between preview and apply, change the Beads task assignee manually; apply → EXTERNAL_CHANGE, skip that task | 02-linear-three-unit.md |
| T23n | orchestrator.test.ts: abandon partial failure | One task's `bd assign` fails; others succeed; outcome includes PARTIAL_APPLY; run marked "failed" not "abandoned" | 02-linear-three-unit.md |
| T23o | orchestrator.test.ts: prompt-dispatch recovery | Crash after startWorkerPhase1 but before Phase2; resume finds pane by label, re-invokes Phase2; no duplicate prompt if promptLifecycle="sent" | 02-linear-three-unit.md |
| T24 | cli.test.ts (extend): arg parsing | packet/run parse branches, --once/--force/--retry, usage gates (missing unit-id, bad runSub) → usage + exit 2; **--force outside run reap rejected (R11)**; **--retry outside run resume rejected** | — (pure parse) |
| T25 | packaging.test.ts (extend): new skill layout + agent file at `agents/` (R9) | `skills/ce-beads-work/SKILL.md` frontmatter parses; `agents/ce-beads-unit.md` exists at package root and is included in `bun pm pack --dry-run` output; `package.json` `files` includes `"agents/"`; agent-file tools list equals `HERDR_WORKER_TOOLS` and contains no `task` | repo files |
| T26 | herdr-runtime.test.ts (create): **HerdrRuntime argv construction (P0-4)** | HerdrRuntime constructs correct omp argv: `--append-system-prompt` with path using NO `@` prefix; includes `--profile`, `--model`, `--tools`, `--no-session`. Assert argv array matches expected structure, or run with a fake executable (temp script that echoes its argv) to verify it is well-formed. Does NOT launch real OMP. Real prompt-loading verification is manual acceptance (§7). | — (pure assert) |
| T27 | regression: existing suites | `bun run verify` — bind/status/sync/doctor/plan-parser/graph-builder/beads-client/packaging/docs all green | existing 16 fixtures |

MockRuntime contract (T12–T22): constructed with a script
`Record<U-ID, { writeFiles: Record<path,string>; report: WorkerReport |
"malformed" | "die" }>`. `createWorkspace` does a REAL `git worktree add`
(against the temp repo, from the engine-supplied forkSha — P0-1),
creates `.ce-beads-worker/` dir, returns Workspace.
`startWorkerPhase1` returns a handle with promptLifecycle="not_sent"
(no real pane created — paneId="mock"). `startWorkerPhase2` applies
`writeFiles` to the worktree and writes the result file (atomically),
sets promptLifecycle="sent". `wait` returns per script.
`inspect`/`cleanup` are spy-recorded. **The MockRuntime does NOT commit**
(P1-4/P1-5) — the engine's CAPTURE step does the commit, identical to the
production path. This ensures CI exercises the real commit/integration
code.

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
# Isolated disposable Beads workspace — never use the repo's .beads for acceptance
export BEADS_DIR="$(mktemp -d -t ce-beads-acceptance-XXXXXX)"
bd init --non-interactive --init-if-missing --skip-agents --skip-hooks --stealth
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
| O1 | A new Herdr pane opens, labeled `ce-beads-U1-<run-id>`, running `omp --profile chinese --model @smol --no-session --tools <whitelist> --append-system-prompt <abs-path-without-@>` | `herdr pane list` shows the label; `herdr pane process-info --pane <id>` |
| O2 | Worker pane shows no `No API key found` error; status bar shows MiniMax-M3; no `@` literal in system prompt | `herdr pane read <id> --source visible --lines 12` right after launch |
| O3 | Worker does NOT call `bd` (no claim/update/close from the pane) | `herdr pane read <id> --source recent-unwrapped`; `bd list --json` assignee is the coordinator's claim only |
| O4 | Worker writes `.ce-beads-worker/result.json` atomically in the U1 worktree; file exists and validates | `cat /tmp/ce-beads-wt/U1-<run-id>/.ce-beads-worker/result.json` |
| O5 | U1's task is NOT closed before integration: after the worker finishes, `bd show <u1-id> --json` shows `in_progress` + label `ce-beads:worker-finished` (or later `ce-beads:merged`/`verified`); `bd ready --json` does NOT yet list U2 | `bd` CLI in the repo |
| O6 | **P0-1:** U2's worker worktree contains U1's implementation (U2's worker_base_sha = integration HEAD after U1 merged). Verify by reading a file U1 created from U2's worktree. | `git -C /tmp/ce-beads-wt/U2-<run-id> log --oneline`; `cat /tmp/ce-beads-wt/U2-<run-id>/<u1-file>` |
| O7 | **P1-4:** Integration branch does NOT contain `.ce-beads-worker/` artifacts | `git -C /tmp/ce-beads-wt/integration-<run-id> ls-tree -r HEAD \| grep .ce-beads-worker` → empty |
| O8 | Coordinator closes U1 ONLY after merge + verification; then U2 becomes ready | `bd show`, `bd ready --json` before/after; `git -C /tmp/ce-beads-wt/integration-<run-id> log --oneline` shows the `--no-ff -m` merge |
| O9 | Loop continues serially: exactly one worker pane at a time; U3 never starts before U2 closes | `herdr pane list` at any moment |
| O10 | **P1-2:** Crash recovery — while a worker is mid-run, kill the coordinator's driver. `bun skills/ce-beads/scripts/cli.ts run resume <run-id> --json` reconciles: reads back Git + Beads, advances durable states without repeating mutations, completes integration. | run-state file under `$GIT_DIR/ce-beads/`; `bd show` before/after |
| O11 | When all units integrate: outcome `completed` with the integration-branch SHA; coordinator STOPS with a human notice; no ce-simplify/review/PR/push; `git branch` shows `main` untouched and `ce-beads/<slug>-<run-id>` holding the work | CLI envelope; `git log main..HEAD` on the integration branch |
| O12 | Plans untouched: the fixture plan file is byte-identical before/after (SD7) | `git status` — no modification to tests/fixtures/plans/ |
| O13 | **R10:** No `.ce-beads/` directory in the consumer repo working tree (run state lives under `$GIT_DIR/ce-beads/`) | `ls .ce-beads 2>/dev/null` → not found |
| O14 | `herdr pane split` JSON field: confirm `result.pane_id` (or `result.pane?.pane_id`) field name | `herdr pane split --current --direction right --no-focus` (observe JSON output); then `herdr pane close <pane_id>` to clean up the scratch pane |
| O15 | `omp --tools` accepts `lsp` and `ast_grep` (or both lists drop them together per the single-source rule) | `omp --profile chinese --model @smol --no-session --tools read,grep,glob,bash,edit,write,lsp,ast_grep --append-system-prompt /dev/null -p "ok"` in a scratch dir |

### Failure-path spot check (optional but recommended)

Run the failing-verification fixture (`17-work-failing-verification.md`)
through the same flow: expect the unit blocked, labeled `ce-beads:blocked`,
NOT merged, NOT closed, outcome `blocked`, worktree PRESERVED for
inspection, and the coordinator stopping for the human.

---

## 8. Done criteria

The milestone is done when ALL of the following hold:

1. `skills/ce-beads-work/SKILL.md` and `agents/ce-beads-unit.md` exist,
   are committed on `feature/ce-orchestrate`, and are discoverable by the
   `chinese` OMP profile (skill appears in `/skill:` completion; agent file
   shipped at `agents/` and included in `bun pm pack` output).
2. `bun run verify` is green: typecheck + all tests, including T1–T26 (the
   mock-runtime loop test T12, the integrate-before-close invariant test
   T13, the worker-base-sha freshness test T14, the 6-state recovery tests
   T17, the artifact-exclusion test T20, the path-without-@ test T25) and
   the full pre-existing MVP suite with zero regressions (T26).
3. The manual acceptance test in §7 passes every required observation
   O1–O13.
4. The six CLI actions behave exactly as specified: `packet` read-only;
   `run start/status/resume/reap/abandon` with the outcome/exit-code mapping
   in §4; `run reap` never mutates Beads; `run abandon` releases Beads state
   only; `--force` rejected outside reap; `--retry` rejected outside resume (R11).
5. Integrate-before-close holds in the only place it can be violated: no
   code path calls `BeadsClient.close` except the orchestrator's
   post-merge, post-verification step (grep-verifiable:
   `grep -n "\.close(" skills/ce-beads-work/scripts/` shows exactly one
   call site).
6. All work is on `feature/ce-orchestrate`; `main` has no new commits;
   nothing is pushed or tagged.
7. The implementation STOPS with a human notice at the shipping-tail
   boundary: no ce-simplify, no ce-code-review, no PR, no merge.

## 9. Explicitly not built (from the brief's non-goals)

Parallel waves / file-contention scheduler; CE quality tail; Beads gates;
formulas/molecules; marketplace/npm publish; alternative runtime adapters;
multi-writer Beads; CE/Beads upstream modifications; HTML plans; direct
Dolt / Beads MCP; writing progress into plans; ce-compound / `bd remember`;
auto-merge/push/tag.

## 10. Open questions the builder may hit (with defaults)

1. **Prompt delivery size**: `herdr pane run <pane> '<prompt>'` passes the
   prompt as an argv string. Packets are a few KB — well under argv limits.
   If a plan produces an oversized packet (>32 KB), truncate
   `technical_design` in the prompt and point the worker at
   `.ce-beads-worker/packet.json` in the worktree (always written in full).
2. **Goal Capsule / DoD in the packet**: the packet now includes requirement
   definitions and KTD excerpts. The remaining gap is Goal Capsule and
   Definition of Done, which require `plan-parser.ts` extensions to extract
   plan-level metadata. This is a documented follow-up.
