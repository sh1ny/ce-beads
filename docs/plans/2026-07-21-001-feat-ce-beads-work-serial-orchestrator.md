# CE-Beads-Work Serial Orchestrator Planning Brief

Plan the `ce-beads-work` serial orchestrator: the execution half of the
ce-beads bridge. The MVP (shipped, `v0.1.0`) imports a CE plan into a Beads
graph. This milestone adds the missing half — a coordinator that executes that
graph by launching Herdr-backed OMP workers, integrating their work, and
closing Beads tasks safely.

## Direction

Build one root orchestrator skill (`ce-beads-work`) plus one restricted worker
agent (`ce-beads-unit`) that together execute a bound ce-beads epic **serially**:
one ready task at a time, one worker, integrate-before-close, crash-recoverable.

The coordinator is an OMP agent running in the `chinese` profile. It claims a
ready Beads task, launches a worker OMP session via Herdr (also `chinese`
profile, `@smol`/`@tiny` role), waits for the worker's structured result + nonce
sentinel, inspects the real diff, runs authoritative verification, integrates the
branch, and only then closes the Beads task. Loop until all units are
integrated, then stop for the human at the CE shipping-tail boundary.

Serial execution is deliberate: it exercises every invariant that matters
(integrate-before-close, only-coordinator-writes-to-Beads, approval boundary,
nonce completion) without the file-contention scheduler that parallel waves
require. That scheduler is a separate, harder project.

## Settled decisions

Treat these as user-directed decisions.

### SD1 — Serial only this milestone

- Decision: One task in flight at a time. No parallel waves, no concurrency cap
  logic, no file-overlap scheduler.
- Provenance: user-directed.
- Rejected alternative: Building safe parallel waves in the same milestone.
- Reason: Serial is "reasonably one-shottable" and proves the architecture
  before investing in the hard part (the contention scheduler). Parallel waves
  depend on re-implementing CE's file-overlap rules externally — a second
  project.

### SD2 — Worker boundary is enforced by a custom bundled agent

- Decision: Author `.omp/agents/ce-beads-unit.md` with `@smol` (or `@tiny`)
  model, a restricted tool whitelist, and a bounded-unit system prompt. The
  worker physically cannot call `bind`/`sync`, cannot spawn sub-agents (no
  `task` tool), cannot close Beads tasks.
- Provenance: user-directed (option B).
- Rejected alternatives:
  - Primary session + prompt rules (advisory boundary; a misbehaving worker
    could mutate).
  - `scout` subagent (read-only by tool whitelist — cannot implement, only
    inspect; fits review, not implementation).
- Reason: Integrate-before-close is the single most important safety invariant.
  An enforced tool boundary makes a worker *physically unable* to violate the
  "only the coordinator writes to Beads" and "no recursive spawning" rules.

### SD3 — OMP profile is always `chinese`

- Decision: Every OMP launch — coordinator and worker — uses
  `--profile chinese`. No bare `omp`, no default profile.
- Provenance: user-directed.
- Reason: The Herdr OMP integration is installed profile-scoped into
  `~/.omp/profiles/chinese/agent/extensions/herdr-omp-agent-state.ts`. Launching
  without that profile means no `agent` detection — the exact "status problem"
  from the prior Herdr experiment. Also, `modelRoles` resolve per-profile, so a
  role alias like `@smol` means a known-credited provider (MiniMax-M3) rather
  than a possibly-keyless one.

### SD4 — Model role allocation (user-directed budget)

- `@smol` — default worker role for bounded implementation units. Resolves to
  MiniMax-M3 on `chinese`. Use freely for `ce-beads-unit` workers.
- `@tiny` — preferred over `@smol` for trivial/mechanical worker tasks.
- `@task` — **use sparingly**; user has limited quota. Reserve for genuinely
  complex multi-step delegated work, not routine implementation.
- `@plan` — for producing/refining this brief and the implementation plan.
- `@commit` — for generating commit messages.
- `@vision` — only when a worker must interpret an image.
- `@slow` — reasoning model (k3:high); for reviewer/analysis work.
- **Concurrency cap: max 2 subagents on glm-5.2/umans** (the default model,
  used by me and by the `@advisor` role elsewhere). Hard cap. All other
  providers also have limits — if workers start failing with rate/quota
  errors, the orchestrator must fall back to inline work, not spawn more.

### SD5 — Standalone, no CE runtime dependency

- Decision: The orchestrator consumes CE plan Markdown via the existing
  `plan-parser`. It does not invoke `/ce-plan`, `/ce-work`, `lfg`, or any CE
  runtime skill. CE remains an optional peer dependency for *authoring* plans
  only.
- Provenance: user-directed (carries forward MVP SD2).
- Reason: The bridge is validated against the CE plan *contract*, not against a
  sibling skill. Installing CE into the execution profile would muddy the
  clean-room discipline.

### SD6 — Beads accessed only through its CLI

- Decision: The orchestrator invokes the installed `bd` CLI with `--json`
  output for all task state (claim, update, close, ready, show). No direct
  Dolt, no Beads MCP.
- Provenance: user-directed (carries forward MVP SD6).
- Reason: The CLI is the canonical, lower-overhead interface and avoids
  coupling to Beads storage internals.

### SD7 — Plans remain immutable decision artifacts

- Decision: Never write task progress, Beads IDs, checkboxes, or run state
  back into the CE plan. The plan is read-only input. All mutable execution
  state lives in Beads + the run-state file.
- Provenance: user-directed (carries forward MVP SD7).

### SD8 — Never commit to main

- Decision: All work stays on `feature/ce-orchestrate`. When the milestone is
  done, STOP with a human notice. No merge, no push, no tag.
- Provenance: user-directed.
- Reason: Highly experimental work; human controls the merge gate.

## The control loop

```
1. Coordinator starts a run (ce-beads-work run start <plan>)
   - Records run ID, plan digest, base SHA, integration branch
   - Verifies the plan is bound (bind if not, via existing bind action
     with full preview→approval→apply flow)
2. Loop:
   a. Query ready tasks: bd ready --json --type task
      --metadata-field integration=ce-beads/v1
      --metadata-field ce_plan_path=<path>
   b. If none ready and none in-flight → exit loop (go to step 7)
   c. If none ready but one in-flight → wait for it (step 4)
   d. Claim one ready task: bd update <id> --claim --json
      (sets assignee + in_progress; atomic)
   e. Build the bounded worker packet (ce-beads packet <plan> <U-ID>)
   f. Herdr adapter: create worktree, launch worker OMP session
      (omp --profile chinese --model @smol --no-session, with the
       packet as the initial prompt and the run-id + U-ID nonce
       convention in the prompt)
   g. Wait for completion via TWO paths:
      - Fast path: herdr lifecycle (agent_status: working → done)
      - Deterministic path: CE_BEADS_RESULT:<run-id>:<U-ID> sentinel
        in the pane output (authoritative; lifecycle is a hint)
   h. Read the worker report (structured JSON envelope from the worker)
   i. Mark task "awaiting integration" (in_progress + ce-beads metadata
      or label; NOT closed)
3. Integration (coordinator-owned):
   a. Inspect the real diff (git diff <base>..<worker-branch>)
   b. Run authoritative verification (the unit's verification commands
      from the plan, in the worker's worktree or a clean checkout)
   c. If verification fails → mark task blocked, report, do not close
   d. If verification passes → merge worker branch into integration
      branch, run full integration tests
   e. Only after integration + verification pass → close the Beads task
      (bd close <id> --json)
   f. Closing exposes the next ready dependency layer
4. Crash recovery (on coordinator restart):
   a. Read run-state file
   b. If a worker pane exists for an in-flight task:
      - Re-attach: poll its status and output for the sentinel
      - If sentinel present → resume at step 3 (integrate)
      - If worker still running → wait
      - If worker died without sentinel → reap worktree, mark task
        blocked, report
   c. If no in-flight task → resume at step 2
5. (Deferred) Safe parallel waves — not in this milestone.
6. (Deferred) Full CE quality tail — simplify, code review, PR.
7. When all units are integrated:
   - Report completion with the integration-branch SHA
   - Stop for the human at the shipping-tail boundary
   - Do NOT run ce-simplify, ce-code-review, open a PR, or push
```

## The most important invariant

**A worker must never close its own Beads task.** A finished worker branch is
not integrated work. If U1 closes before its branch reaches the integration
branch, U2 becomes ready and starts from code that does not contain U1.

Task lifecycle (enforced by the coordinator, never by the worker):

```
open
  → claimed / in_progress        (coordinator: bd update --claim)
  → worker-finished              (worker returns; coordinator marks metadata)
  → awaiting-integration         (in_progress + ce-beads label/metadata)
  → reviewed                      (coordinator inspected the diff)
  → committed-and-integrated     (coordinator merged + ran integration tests)
  → verification-passed          (coordinator ran authoritative verification)
  → closed                        (coordinator: bd close — ONLY here)
```

The "awaiting integration" state is `in_progress` with a ce-beads metadata flag
or label (`ce-beads:awaiting-integration`). It is NOT a separate Beads status.
This keeps the state machine within Beads' existing status model while making
the coordinator's recovery logic unambiguous.

## Worker agent: ce-beads-unit

A bundled agent at `.omp/agents/ce-beads-unit.md` (project-local, unpacked via
`omp agents unpack --project` or authored directly). Frontmatter:

```yaml
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
```

The worker's system prompt (body of the agent file) instructs it to:
- Implement ONLY the bounded unit packet provided in the prompt.
- Run ONLY the unit's verification commands.
- NOT run `bd` (it lacks the tool anyway, but state it explicitly).
- NOT commit, push, or merge (coordinator owns integration).
- NOT spawn sub-agents (no `task` tool).
- Print `CE_BEADS_RESULT:<run-id>:<U-ID>` on its own line when done, followed
  by the structured JSON report.
- Keep changes scoped to the worktree.

The worker CAN edit/write/bash — it needs to implement. The boundary is on
*coordination* tools (no `task`, no `bd`), not on implementation tools.

## Run state and recovery

A run-state file at `.ce-beads/run-<run-id>.json` (gitignored) records:

```json
{
  "run_id": "<uuid>",
  "plan_path": "docs/plans/example.md",
  "plan_digest": "sha256:...",
  "base_sha": "<git sha of integration base>",
  "integration_branch": "ce-beads/<plan-slug>-<run-id>",
  "started_at": "<iso>",
  "units": {
    "U1": {
      "beads_id": "bd-xxxx",
      "state": "closed|awaiting-integration|claimed|blocked",
      "worker_pane_id": "w1E:pX",
      "worker_branch": "ce-beads/U1-<run-id>",
      "worktree_path": "/tmp/ce-beads-wt/U1-<run-id>",
      "claimed_at": "<iso>",
      "integrated_sha": "<sha or null>",
      "result": { ... worker report ... }
    }
  }
}
```

On coordinator restart, `ce-beads-work run resume <run-id>` reads this file and
re-attaches. The run-state file is the ONLY coordinator-local state; all task
state is in Beads. If the run-state file is lost, the coordinator can
reconstruct open/claimed/closed from Beads, but loses worker-pane/worktree
mappings (those become orphaned and need manual cleanup or a `ce-beads-work
reap` command).

## New CLI actions

Extends the existing `ce-beads` CLI (which has doctor/bind/status/sync) with:

```text
ce-beads packet <plan> <U-ID> [--json]
  Read-only. Produces the bounded worker packet (goal, files, approach,
  verification, etc.) as JSON suitable to embed in a worker prompt.

ce-beads run start <plan> [--json]
  Initializes a run: verifies binding, records run-state, creates the
  integration branch from the current HEAD.

ce-beads run status [<run-id>] [--json]
  Reports run state: in-flight task, completed units, blocked units.

ce-beads run resume <run-id> [--json]
  Re-attaches to an in-flight worker or resumes the loop.

ce-beads run reap <run-id> [--json]
  Cleans up orphaned worktrees/panes from a crashed run. Does not close
  Beads tasks.
```

These are deterministic TS scripts under `skills/ce-beads-work/scripts/`,
consuming the existing `plan-parser.ts`, `beads-client.ts`, and `protocol.ts`.

## Herdr runtime adapter

A TypeScript module at
`skills/ce-beads-work/scripts/runtimes/herdr.ts` implementing:

```ts
interface AgentRuntime {
  createWorkspace(unit: Unit, runId: string): Promise<Workspace>;
  startWorker(ws: Workspace, prompt: string): Promise<WorkerHandle>;
  wait(handle: WorkerHandle, opts: WaitOpts): Promise<WorkerResult>;
  inspect(handle: WorkerHandle): Promise<WorkerState>;
  cleanup(ws: Workspace): Promise<void>;
}
```

`HerdrRuntime` implements this via the Herdr CLI (`herdr pane split`, `pane
run`, `pane get`, `pane read`, `pane close`). It:
- Splits a pane (no-focus), labels it `ce-beads-<U-ID>-<run-id>`.
- Launches `omp --profile chinese --model @smol --no-session` in the pane,
  with cwd set to the worktree path.
- Sends the worker packet as the initial prompt.
- Polls `herdr pane get` for `agent_status` transitions (fast path).
- Also watches for `CE_BEADS_RESULT:<run-id>:<U-ID>` in pane output
  (deterministic path — authoritative).
- Records pane_id, worktree path, branch in run-state.
- On cleanup, closes only panes/worktrees created by that run.

The adapter has a deterministic fallback (sentinel) and a lifecycle fast-path,
per the experiment finding that `agent_status` can lag actual completion by
tens of seconds.

## Required fixtures and tests

New fixtures (in addition to the 16 existing plan fixtures):

1. A 3-unit linear plan already bound, with U1 ready (for loop tests).
2. A plan where a unit's verification command is designed to fail (for the
   blocked-path test).
3. A worker-report schema fixture (valid and invalid).

Tests (Bun, real `bd` CLI in isolated `BEADS_DIR`):

- `packet` produces a correct bounded unit packet from a bound plan.
- `run start` creates run-state and integration branch.
- `run status` reports in-flight and completed units correctly.
- Claim → simulate worker result → integrate → close loop works end-to-end
  with a *mock* runtime (no real Herdr launch) for deterministic CI.
- Integrate-before-close: closing is impossible while a task is
  `awaiting-integration`; only integration transitions it to closable.
- Crash recovery: a run-state file with an in-flight task is correctly
  re-attached (with a mock runtime).
- `run reap` cleans up orphaned worktree records without closing Beads tasks.
- Worker report schema validation (rejects malformed reports).
- Existing bind/status/sync/doctor tests remain green (no regressions).

Real-Herdr integration is exercised in the **manual acceptance test**, not
in automated tests (Herdr requires a live pane environment).

## Manual clean-profile acceptance test and required user gate

After automated tests pass, the implementation stops and asks the user to run
a live acceptance test. The implementation must NOT launch OMP recursively or
spawn Herdr panes during automated verification.

The user runs, from `~/Development/AI/ce-beads` on `feature/ce-orchestrate`:

```bash
# In an existing OMP chinese-profile session (the coordinator):
/skill:ce-beads-work run start docs/plans/<a-fixture-plan>.md
```

Wait — actually the coordinator IS an OMP agent, so the user launches it. The
acceptance flow:

1. User launches `omp --profile chinese` in the repo (on the feature branch).
2. User invokes the `ce-beads-work` skill with a bound fixture plan.
3. The coordinator binds (if needed, with preview→approval), starts a run,
   claims U1, and launches a worker via Herdr in a new pane.
4. The user observes: a new pane opens, the worker (MiniMax-M3) implements U1,
   prints the sentinel + report, and the pane returns to idle.
5. The coordinator inspects the diff, runs verification, integrates, closes U1.
6. U2 becomes ready; the loop continues.
7. When all units are integrated, the coordinator stops and reports.

Required observations for PASS:
- Worker pane is labeled and uses `--profile chinese --model @smol`.
- Worker does NOT call `bd` (no claim/update/close from the worker).
- Worker prints the exact `CE_BEADS_RESULT:<run-id>:<U-ID>` sentinel.
- Coordinator closes the Beads task ONLY after integration + verification.
- A killed coordinator can be resumed via `run resume <run-id>`.
- No work is committed to `main`; the integration branch is separate.

## Non-goals (explicitly deferred)

- Safe parallel waves (file-contention scheduler).
- Full CE quality tail (simplify, code review, PR).
- Beads gates (plan approval, CI, human acceptance as Beads gate tasks).
- Beads formulas or molecules beyond the existing epic.
- Marketplace distribution / npm publish.
- Alternative runtime adapters (OMP subagent, Claude, Codex, headless daemon).
- Multi-writer Beads (server mode).
- Modifying CE or Beads upstream.
- HTML plan support.
- Direct Dolt or Beads MCP.
- Writing execution progress back into CE plans.
- `ce-compound` or `bd remember` integration.
- Auto-merge / auto-push / auto-tag.

## Completion standard

The milestone is done when:

- `ce-beads-work` and `ce-beads-unit` skills are discoverable by the
  `chinese` OMP profile from the feature branch.
- All automated tests pass (including the mock-runtime loop test and the
  integrate-before-close invariant test).
- Existing MVP tests remain green (no regressions to bind/status/sync/doctor).
- The manual acceptance test passes the required observations above.
- All work is on `feature/ce-orchestrate`; nothing is merged to main.
- The implementation STOPS with a human notice. No merge, push, or tag.

## Open questions for planning (not preset)

- Exact integration-branch naming scheme (`ce-beads/<plan-slug>-<run-id>`
  vs. `feature/ce-beads-<run-id>`).
- Whether `run reap` is in-scope for this milestone or deferred (it's
  safety-net code; the core loop doesn't need it).
- Whether the worker report should be emitted as a JSON file in the worktree
  (durable) vs. parsed from pane output (simpler, matches the sentinel
  approach). Lean: file in worktree, parsed by the adapter — more robust
  than scraping scrollback.
- Whether to use `@smol` or `@tiny` as the default worker role. `@tiny` is
  preferred for trivial units, `@smol` for real implementation. The
  coordinator could pick based on unit complexity, but that's a refinement.

## Build sequence (suggested)

1. **Worker packet + agent definition.** `ce-beads packet` action +
   `.omp/agents/ce-beads-unit.md`. Testable without Herdr.
2. **Run state + lifecycle actions.** `run start/status/resume` + run-state
   file. Testable with a mock runtime.
3. **Herdr adapter.** `runtimes/herdr.ts` with the two-path completion
   detection. Smoke-testable manually.
4. **Integration + close loop.** Ties packet, run-state, and adapter
   together with the integrate-before-close state machine.
5. **Crash recovery.** `run resume` re-attachment logic.
6. **(Optional) `run reap`.** Orphan cleanup.
7. **Manual acceptance.** Stop for the human.

Each step is independently testable. Steps 1-2 are pure TS, no Herdr. Step 3
is the runtime integration. Steps 4-5 are the state machine. Step 7 is the
gate.
