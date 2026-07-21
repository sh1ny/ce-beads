# Changelog

## Unreleased

### Added
- ce-beads-work serial orchestrator foundation (in progress): protocol extended with `packet` and `run` actions, `PacketOutcome`/`RunOutcome` enums, and 14 new diagnostic codes (`UNIT_NOT_FOUND` through `EXTERNAL_CHANGE`) with corresponding `exitCodeFor` mappings.
- Plan parser extended: parses Verification Contract tables into typed `VerificationEntry[]`, requirement definitions (`R-ID` → text) into `requirement_defs`, and KTD excerpts per unit.
- `worker-packet.ts`: bounded `WorkerPacket` schema (`ce-beads-packet/1`) with `buildWorkerPacket()` — assembles unit, verification commands, requirement defs, and KTD excerpts into a single self-contained worker payload.
- `packet.ts`: `packet` action handler — standalone packet builder (read-only, no Beads mutation) resolving binding + verification commands for a single unit.
- `runtimes/runtime.ts`: `AgentRuntime` interface — pluggable worker runtime contract (two-phase `startWorkerPhase1`/`Phase2`, file-based completion wait, crash-recovery `inspect`, preview-gated `cleanup` with separate pane/worktree/branch actions).
- `runtimes/mock.ts`: `MockRuntime` — scripted, deterministic AgentRuntime for CI; real git worktrees, no Herdr/OMP; does NOT commit (engine's CAPTURE step does, matching production path).
- `worker-prompt.ts`: `WORKER_AGENT_BODY` (verbatim ce-beads-unit system prompt) + `renderWorkerPrompt()` for pane delivery.
- `worker-report.ts`: `WorkerReport` schema (`ce-beads-worker-report/1`), strict structural validation, fallback pane-output JSON extraction.
- `run-state.ts`: `RunState`/`RunUnitRecord` with 6-state unit lifecycle (`pending→claimed→worker_finished→captured→merged→verified→closed`, with `blocked`), crash recovery via `last_successful_state` + `prompt_lifecycle`, atomic file persistence, `findActiveRunForPlan` (mid-initialization detection).
- `git.ts`: minimal git helper functions (worktree add/remove, branch delete, merge with conflict detection, diff-stat, porcelain status, atomic add+commit) using `node:child_process`.
- `orchestrator.ts`: `RunEngine` — serial control loop + 6-state integrate-before-close state machine (claim → worker → capture → verify → merge → verify → close); reap/abandon with preview→apply approval tokens; crash-recovery via persisted run-state; P0-1 worker-base-sha freshness; two-way changed_files equality validation.
- Test fixtures: `17-work-failing-verification.md` (failing verification command), `18-work-u2-depends-on-u1-impl.md` (P0-1 worker-base-sha freshness), and `worker-reports/` (valid-complete, valid-blocked, invalid-missing-fields, invalid-bad-status, invalid-not-json).
- `orchestrator.ts`: `RunEngine` — serial control loop + 6-state integrate-before-close state machine (claim → worker → capture → verify → merge → verify → close); reap/abandon with preview→apply approval tokens; crash-recovery via persisted run-state; P0-1 worker-base-sha freshness; two-way changed_files equality validation
- `runtimes/herdr.ts`: HerdrRuntime — production AgentRuntime using `herdr agent start` with prompt-as-argv (pi-overseer pattern); file-based completion (R3); `herdr agent get` advisory state checks
- `run.ts`: run action handler — dispatches to RunEngine for start/status/resume/reap/abandon
- `agents/ce-beads-unit.md`: bundled worker agent file (R9) with restricted tools whitelist
- HerdrPaneSplitResponse type for pane split API
- Manual pane split fallback using peer-agents pattern when herdr agent start process detection fails

### Changed
- `beads-client.ts`: `BeadsClient.update()` now accepts `assignee?: string` (empty string clears assignee; required for abandon contract's `bd update --status open --assignee ""`).
- `bind.ts`: exported `enumerateBinding` and `buildMapping` for reuse by `packet.ts`.
- Plan v6: HerdrRuntime spec rewritten to use `herdr agent start` with prompt-as-argv (pi-overseer pattern), eliminating the two-phase startWorker gap; prompt delivered atomically with agent launch.
- `beads-client.ts`: `BeadsClient.update()` now accepts `assignee?: string` (empty string clears assignee; required for abandon contract's `bd update --status open --assignee "".)
- `bind.ts`: exported `enumerateBinding` and `buildMapping` for reuse by `packet.ts`
- `runtimes/herdr.ts`: `HerdrRuntime` — production AgentRuntime using `herdr agent start` with prompt-as-argv (pi-overseer pattern); file-based completion (R3); `herdr agent get` advisory state checks.
- `run.ts`: `run` action handler — dispatches to RunEngine for start/status/resume/reap/abandon.
- `agents/ce-beads-unit.md`: bundled worker agent file (R9) with restricted tools whitelist.
- `cli.ts`: extended for `packet` and `run` actions with positional/options parsing, `--unit`/`--force`/`--retry`/`--once` flags, `makeCliArgs` helper for backward-compatible CliArgs construction.
- `worker-packet.ts`: `buildWorkerPacket` now accepts `resultFile` override; `PacketUnit` optional fields typed `string | undefined` for exactOptionalPropertyTypes.
- `run-state.ts`: `assertRunUnitRecord` parameter type changed from `Record<string, unknown>` to `object` with internal cast (TS2677 fix).
- `beads-client.ts`: `BeadsClient.update()` now accepts `assignee?: string`.
- `bind.ts`: exported `enumerateBinding` and `buildMapping`.
- Plan v6: HerdrRuntime spec rewritten to use `herdr agent start` with prompt-as-argv.
- Test files updated to use `makeCliArgs` helper (status, sync, doctor, bind).
- Plan v6: HerdrRuntime spec rewritten to use `herdr agent start` with prompt-as-argv (pi-overseer pattern), eliminating the two-phase startWorker gap; prompt delivered atomically with agent launch
- `cli.ts`: extended for `packet` and `run` actions with positional/options parsing; `--unit`/`--force`/`--retry`/`--once` flags; `makeCliArgs` helper for backward-compatible CliArgs construction
- `worker-packet.ts`: `buildWorkerPacket` now accepts `resultFile` override; `PacketUnit` optional fields typed `string | undefined` for exactOptionalPropertyTypes
- `run-state.ts`: `assertRunUnitRecord` parameter type changed from `Record<string, unknown>` to `object` with internal cast (TS2677 fix)

### Fixed
- Deduplicated repeated entries in unreleased changelog section
- Test files updated to use `makeCliArgs` helper (status, sync, doctor, bind)
- Fixed idle-race detection in HerdrRuntime wait() — tracks hasBeenWorking before treating agent-not-found as died
## 0.1.0 — 2026-07-21
### Added

- ce-beads OMP bridge MVP: imports Compound Engineering implementation-ready plans (`ce-unified-plan/v1`, `implementation-ready`, `execution: code`) into a Beads dependency graph.
- Four actions: `doctor` (read-only preflight), `bind` (idempotent plan → Beads import with preview → approval → apply flow), `status` (read-only drift report), `sync` (conservative reconciliation).
- Location-independent skill packaging: installs as an OMP plugin via `omp plugin link .` or `omp plugin install github:OWNER/ce-beads#v0.1.0`.
- `ce-beads-protocol/1` JSON envelope with stable action-specific outcomes, diagnostic codes, and exit-code taxonomy.
- OS-managed advisory lock (flock) keyed by canonical plan path — no stale-state heuristics.
- Approval-token flow: preview emits an `approval_token` computed over the canonical mutation set; `--apply <token>` verifies exact match before any mutation.
- Package-owned `UPSTREAMS.lock.json` resolution (via `import.meta.url`, never cwd) — doctor finds compatibility data from any consumer directory.
- Pinned upstream provenance: `compound-engineering-plugin`, `beads`, and `oh-my-pi` inspected commits recorded.
- 129 automated tests including packaging regressions (manifest, layout, no-`.omp/skills` guard, location independence, executable CLI, package-owned lock resolution, consumer-relative bind flow, pack payload).

### Approval-flow contract

- The initial request to bind or sync is **not** approval to apply. After preview, STOP.
- Never approve on the user's behalf — request explicit human approval using the harness's native ask tool (OMP: `ask`).
- Preserve the exact token from the displayed preview — never rerun the action to capture a token, never recompute or substitute.
- A token mismatch aborts with zero mutations.

### Tested runtime

bd 1.1.0, Bun 1.3.14, OMP 17.0.6, Node 24.18.0, Linux/WSL2.

### Known limitations

- OMP on WSL/Linux only (Claude Code, Codex integrations deferred).
- Markdown plans only (HTML, legacy plans not supported).
- `bd` CLI only (no direct Dolt, no Beads MCP).
- Single-writer (no multi-agent concurrent Beads writers).
- No PR/CI gates.
- Marketplace installation is not yet provided (direct Git/npm install only).
