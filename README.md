# ce-beads

OMP-native bridge that imports Compound Engineering implementation-ready plans into a Beads dependency graph.

## Prerequisites

- **Linux/WSL** (tested on WSL2 with Linux 6.18)
- **Bun** 1.3.14+ (scripts run directly under Bun; no build step)
- **bd** 1.1.0 (Beads CLI — installed via the official checksum-verifying path)
- **OMP** 17.0.5+ (for skill discovery)

**No Compound Engineering installation is required** at runtime. The skill
parses CE plan Markdown directly and writes to Beads via the `bd` CLI.

Verify your environment:

```bash
bd --version    # bd version 1.1.0
bun --version   # 1.3.14
omp --version   # omp/17.0.5
```

## Install as an OMP plugin

**GitHub**:

```bash
omp plugin install github:sh1ny/ce-beads#v0.1.0
```

**Local development from a checkout:**

```bash
omp plugin link .
# equivalently: omp install .   (local paths route to link)
```

Links are symlinks — source edits take effect without reinstall.

**Profile note (load-bearing):** plugins install into the **active profile's**
plugin store (`~/.omp/profiles/<name>/plugins` for named profiles, `~/.omp/plugins`
for the default). Prefix plugin commands with `OMP_PROFILE=<name>` so the
profile you launch actually sees the plugin.

**Discovery fact:** installed plugins contribute `skills/<name>/SKILL.md` from
the package root; a valid plugin package needs only a package.json `omp` object
and that skill tree.

## Manage the plugin

```bash
omp plugin list                       # human-readable
omp plugin list --json                # machine-readable
omp plugin doctor                     # health checks
omp plugin doctor --json

# update: re-install with a new git ref (moves the pin)
omp plugin install github:sh1ny/ce-beads#<new-ref>
```

## Skill vs standalone CLI

**Inside OMP:** invoke `/skill:ce-beads` and follow the skill — the agent
runs `bun "$SKILL_DIR/scripts/cli.ts" …` itself, where `SKILL_DIR` is the
absolute skill directory OMP injects in the `[Skill directory: …]` line.

**Outside OMP:** the same four actions are a plain CLI:

```bash
ce-beads <action> [plan-path] [flags]                 # bin shim (created on install)
bun skills/ce-beads/scripts/cli.ts …                  # from a checkout
```

Run it with the **consumer project** as cwd — the CE plan and the Beads
workspace (`.beads` or `$BEADS_DIR`) live there, never in the package.

## Architecture

```
CE plan Markdown → plan-parser.ts → CePlan/CeUnit IR
                                        ↓
                                   graph-builder.ts → bd create --graph JSON
                                        ↓                     ↓
                                   reconcile.ts ← ← ← beads-client.ts → bd CLI
                                        ↓
                              status.ts (read-only) / sync.ts (mutations)
```

**Source of truth**: The CE plan is the immutable decision artifact; Beads owns all mutable execution state. Nothing is ever written back to the plan file.

## Actions

```bash
# Read-only health check
ce-beads doctor [plan-path] [--json]

# Import a plan into Beads (idempotent)
ce-beads bind <plan-path> [--json] [--apply <token>]

# Read-only drift report
ce-beads status <plan-path> [--json]

# Reconcile plan changes into Beads
ce-beads sync <plan-path> [--json] [--apply <token>]
```

Inside OMP, the same actions run as `bun "$SKILL_DIR/scripts/cli.ts" …` (see
the skill's `SKILL.md`).

### Supported CE contract

- `artifact_contract: ce-unified-plan/v1`
- `artifact_readiness: implementation-ready`
- `execution: code`

Rejected: requirements-only, knowledge-work, HTML, legacy contracts, duplicate U-IDs, missing dependencies, cycles, missing required fields, paths outside the repo.

### Beads mapping

- 1 epic per plan, 1 task per unit, blocking dependencies from CE deps
- Identity: canonical plan path + stable U-ID (stored as metadata, never titles)
- Metadata: all string-valued (KTD10), with `ce_plan_digest` on the epic and `ce_unit_digest` per task

See `skills/ce-beads/references/mapping.md` for the full metadata key reference.

## Idempotency and reconciliation

- **bind** is idempotent: rebinding an unchanged plan returns the existing mapping
- **bind refuses drift**: any drifted/partial/duplicate binding → `binding_drift`, zero mutations
- **sync** is conservative: creates new units, updates open units, labels removed units (never deletes), treats closed-unit changes as conflicts
- **Recovery is checkpointless**: all state derives from plan + Beads metadata; a fresh rerun converges

See `skills/ce-beads/references/reconciliation.md` for drift classes and blocking states.

## Failure and recovery

- Parse/contract failures stop before any `bd` mutation
- Dry-run failures stop before live creation
- Live-apply failures are indeterminate: re-query, never blindly retry
- Per-mutation sync failures are contained and reported as applied/pending/conflict/indeterminate
- A partial sync rerun converges — each mutation is read back before being reported `applied`

## Running tests

```bash
bun test --timeout 30000        # all tests
bun test tests/plan-parser.test.ts  # parser only
bun run typecheck               # tsc --noEmit (strict)
bun run verify                  # typecheck + test
```

Tests exercise the real `bd` CLI in isolated `BEADS_DIR` temp workspaces. The development repository's real `.beads` database is never touched.

## Distribution

The package ships exactly `skills/`, `README.md`, `UPSTREAMS.lock.json` (the
npm `files` allowlist) plus `package.json`; `tests/`, `docs/`, `upstream/`,
`.beads/` are excluded. Upstream checkouts are **provenance only**.

Marketplace installation is not yet provided (direct Git/npm install only).

## License

Dual-licensed under either of:

- MIT License ([LICENSE-MIT](LICENSE-MIT))
- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))

at your option.

## Clean-profile acceptance test

See `docs/acceptance.md` for the exact procedure to validate the **installed
plugin** from an unrelated consumer project.

## Known MVP limitations

- OMP on WSL/Linux only (Claude Code, Codex integrations deferred)
- Markdown plans only (HTML, legacy plans not supported)
- `bd` CLI only (no direct Dolt, no Beads MCP)
- Single-writer (no multi-agent concurrent Beads writers)
- No PR/CI gates
- Marketplace installation is not yet provided (direct Git/npm install only)

## Pinned upstreams and tool versions

See `UPSTREAMS.lock.json` for:
- `compound-engineering-plugin` commit `74ba763608d9f00172ca0b4b52e433934642dd0b`
- `beads` commit `1823f47ae42c93cb753536dfc49fa2337ace8eb1`
- Tested: `bd` 1.1.0, Bun 1.3.14, OMP 17.0.6, Node 24.18.0

The upstream checkouts (`upstream/compound-engineering-plugin`, `upstream/beads`) are **implementation provenance** — read-only references used during development to target the CE plan schema and the `bd` CLI surface. They are gitignored and **not required at runtime**: the skill invokes the `bd` binary from PATH and never reads the upstream trees. `UPSTREAMS.lock.json` intentionally omits machine-specific paths (binary locations, local DB/workspace state).
