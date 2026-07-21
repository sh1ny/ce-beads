# Changelog

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
