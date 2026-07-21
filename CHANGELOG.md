# Changelog

## Unreleased

### Added
- ce-beads-work serial orchestrator: protocol extended with `packet` and `run` actions, `PacketOutcome`/`RunOutcome` enums, and 14 new diagnostic codes (`UNIT_NOT_FOUND` through `EXTERNAL_CHANGE`) with `exitCodeFor` mappings.
- Plan parser extended: parses Verification Contract tables into typed `VerificationEntry[]`, requirement definitions (`R-ID` → text) into `requirement_defs`, and KTD excerpts per unit.
- `worker-packet.ts`: bounded `WorkerPacket` schema (`ce-beads-packet/1`) with `buildWorkerPacket()`.
- `packet.ts`: `packet` action handler — standalone packet builder (read-only, no Beads mutation).
- `runtimes/runtime.ts`: `AgentRuntime` interface — pluggable worker runtime contract.
- `runtimes/mock.ts`: `MockRuntime` — scripted, deterministic AgentRuntime for CI; real git worktrees, no Herdr/OMP.
- `runtimes/herdr.ts`: HerdrRuntime — production AgentRuntime using `herdr agent start` with prompt-as-argv (pi-overseer pattern); file-based completion (R3); manual pane split fallback.
- `worker-prompt.ts`: `WORKER_AGENT_BODY` + `renderWorkerPrompt()` for pane delivery.
- `worker-report.ts`: `WorkerReport` schema (`ce-beads-worker-report/1`), strict structural validation, fallback pane-output JSON extraction.
- `run-state.ts`: `RunState`/`RunUnitRecord` with 6-state unit lifecycle, crash recovery via `last_successful_state` + `prompt_lifecycle`, atomic file persistence, `findActiveRunForPlan`.
- `git.ts`: minimal git helpers (worktree add/remove, branch delete, merge with conflict detection, porcelain status, atomic add+commit).
- `orchestrator.ts`: `RunEngine` — serial control loop + 6-state integrate-before-close state machine; reap/abandon with preview→apply approval tokens; crash-recovery; P0-1 worker-base-sha freshness; two-way changed_files equality validation.
- `run.ts`: `run` action handler — dispatches to RunEngine for start/status/resume/reap/abandon.
- `agents/ce-beads-unit.md`: bundled worker agent file (R9) with restricted tools whitelist.
- `skills/ce-beads-work/SKILL.md`: coordinator skill instructions.
- Test fixtures: `17-work-failing-verification.md`, `18-work-u2-depends-on-u1-impl.md`, and `worker-reports/` (valid/invalid JSON fixtures).
- Test suites: `tests/orchestrator.test.ts` (9 tests), `tests/worker-report.test.ts` (29 tests), `tests/run-state.test.ts` (21 tests), `tests/packet.test.ts` (6 tests).
- `package.json`: `agents/` added to `files` allowlist.
- README: documented `ce-beads-work` actions (`packet`, `run start/resume/reap/abandon/status`).

### Changed
- `beads-client.ts`: `BeadsClient.update()` now accepts `assignee?: string` (empty string clears assignee).
- `bind.ts`: exported `enumerateBinding` and `buildMapping` for reuse by `packet.ts`.
- `cli.ts`: extended for `packet` and `run` actions with positional/options parsing; `--unit`/`--force`/`--retry`/`--once` flags; `makeCliArgs` helper.
- `worker-packet.ts`: `buildWorkerPacket` now accepts `resultFile` override; `PacketUnit` optional fields typed `string | undefined` for exactOptionalPropertyTypes.
- `run-state.ts`: `assertRunUnitRecord` parameter type changed from `Record<string, unknown>` to `object` with internal cast (TS2677 fix).
- Test files updated to use `makeCliArgs` helper (status, sync, doctor, bind).

### Fixed
- `git.ts`: `runInDir` now uses `Bun.$` shell to avoid Bun 1.3.x `posix_spawn` ENOENT bug that occurs after many process spawns in the same Bun process.
- `git.ts`: `gitCommonDir` now resolves relative paths to absolute (worktree dirs under it work regardless of process CWD).
- `git.ts`: `statusPorcelain` now uses `-uall` to show individual untracked files (default collapses untracked dirs, breaking per-file validation).
- `orchestrator.ts`: `findActiveRunForPlan` check moved BEFORE binding check (prevents NOT_BOUND when workspace state changed during a run).
- `orchestrator.ts`: `record.beads_id` now set from `readyTask.beadsId` after claim (was using CE unit ID instead of Beads task ID).
- `orchestrator.ts`: `initialUnitRecord` now uses `attempt: 1` (validator requires `>= 1`).
- `runtimes/mock.ts`: `hrtime` comparison fixed (was comparing number to `[number, number]`).
- `runtimes/mock.ts`: `worktreeRemove`/`branchDelete` replaced with `execFileSync` (mock doesn't have `repoRoot`).
- Idle-race detection in HerdrRuntime `wait()` — tracks `hasBeenWorking` before treating agent-not-found as died.

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
