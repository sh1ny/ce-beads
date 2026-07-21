# ce-beads

OMP-native bridge that imports Compound Engineering implementation-ready plans into a Beads dependency graph.

## Prerequisites

- **WSL/Linux** (tested on WSL2 with Linux 6.18)
- **Bun** 1.3.14+ (scripts run directly under Bun; no build step)
- **OMP** 17.0.5+ (for skill discovery)
- **bd** 1.1.0 (Beads CLI — installed via the official checksum-verifying path)

Verify your environment:

```bash
bd --version    # bd version 1.1.0
bun --version   # 1.3.14
omp --version   # omp/17.0.5
```

## Setup

```bash
# From the project root:
bun install --frozen-lockfile

# Initialize the development Beads workspace:
bd init --non-interactive --init-if-missing --skip-agents --skip-hooks --stealth
```

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
bun .omp/skills/ce-beads/scripts/cli.ts doctor [plan-path] [--json]

# Import a plan into Beads (idempotent)
bun .omp/skills/ce-beads/scripts/cli.ts bind <plan-path> [--json] [--apply <token>]

# Read-only drift report
bun .omp/skills/ce-beads/scripts/cli.ts status <plan-path> [--json]

# Reconcile plan changes into Beads
bun .omp/skills/ce-beads/scripts/cli.ts sync <plan-path> [--json] [--apply <token>]
```

### Supported CE contract

- `artifact_contract: ce-unified-plan/v1`
- `artifact_readiness: implementation-ready`
- `execution: code`

Rejected: requirements-only, knowledge-work, HTML, legacy contracts, duplicate U-IDs, missing dependencies, cycles, missing required fields, paths outside the repo.

### Beads mapping

- 1 epic per plan, 1 task per unit, blocking dependencies from CE deps
- Identity: canonical plan path + stable U-ID (stored as metadata, never titles)
- Metadata: all string-valued (KTD10), with `ce_plan_digest` on the epic and `ce_unit_digest` per task

See `.omp/skills/ce-beads/references/mapping.md` for the full metadata key reference.

## Idempotency and reconciliation

- **bind** is idempotent: rebinding an unchanged plan returns the existing mapping
- **bind refuses drift**: any drifted/partial/duplicate binding → `binding_drift`, zero mutations
- **sync** is conservative: creates new units, updates open units, labels removed units (never deletes), treats closed-unit changes as conflicts
- **Recovery is checkpointless**: all state derives from plan + Beads metadata; a fresh rerun converges

See `.omp/skills/ce-beads/references/reconciliation.md` for drift classes and blocking states.

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
```

Tests exercise the real `bd` CLI in isolated `BEADS_DIR` temp workspaces. The development repository's real `.beads` database is never touched.

## Clean-profile acceptance test

See `docs/acceptance.md` for the exact procedure to validate the deliverable with a fresh OMP profile.

## Known MVP limitations

- OMP on WSL/Linux only (Claude Code, Codex integrations deferred)
- Markdown plans only (HTML, legacy plans not supported)
- `bd` CLI only (no direct Dolt, no Beads MCP)
- Single-writer (no multi-agent concurrent Beads writers)
- No PR/CI gates
- No npm package or marketplace plugin

## Pinned upstreams and tool versions

See `UPSTREAMS.lock.json` for:
- `compound-engineering-plugin` commit `74ba763608d9f00172ca0b4b52e433934642dd0b`
- `beads` commit `1823f47ae42c93cb753536dfc49fa2337ace8eb1`
- Tested: `bd` 1.1.0, Bun 1.3.14, OMP 17.0.5, Node 24.18.0

The upstream checkouts (`upstream/compound-engineering-plugin`, `upstream/beads`) are **implementation provenance** — read-only references used during development to target the CE plan schema and the `bd` CLI surface. They are gitignored and **not required at runtime**: the skill invokes the `bd` binary from PATH and never reads the upstream trees. `UPSTREAMS.lock.json` intentionally omits machine-specific paths (binary locations, local DB/workspace state); a local environment report, if present, lives at `docs/local-environment.md` (gitignored).
