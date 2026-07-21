---
name: ce-beads
description: "Bridge Compound Engineering implementation-ready plans into a Beads dependency graph. Supports doctor, bind, status, and sync actions with deterministic Bun/TypeScript scripts and proven Beads CLI integration."
---

# ce-beads — CE Plans → Beads Bridge

[Skill directory: .omp/skills/ce-beads]

## What this skill does

ce-beads imports a Compound Engineering (CE) implementation-ready Markdown plan into a persistent Beads dependency graph. One epic represents the plan; one child task per implementation unit; blocking dependencies derived from CE unit dependencies. Plans remain immutable decision artifacts; Beads owns all mutable execution state.

## Actions

All actions are run via the CLI at `.omp/skills/ce-beads/scripts/cli.ts`:

```bash
bun .omp/skills/ce-beads/scripts/cli.ts doctor [plan-path] [--json]
bun .omp/skills/ce-beads/scripts/cli.ts bind <plan-path> [--json] [--apply <token>]
bun .omp/skills/ce-beads/scripts/cli.ts status <plan-path> [--json]
bun .omp/skills/ce-beads/scripts/cli.ts sync <plan-path> [--json] [--apply <token>]
```

Always use `--json` for machine-readable output. The JSON envelope is:

```json
{
  "schema_version": "ce-beads-protocol/1",
  "action": "bind|status|sync|doctor",
  "ok": true|false,
  "outcome": "<action-specific>",
  "data": { ... },
  "diagnostics": [{ "code": "...", "severity": "...", "message": "..." }]
}
```

### doctor

Read-only preflight. Checks: `bd` presence, version match, workspace initialization, plan support, binding health. Reports exact corrective commands but never executes them.

### bind

Imports a plan into Beads. Idempotent: rebinding an unchanged plan returns the existing mapping. Refuses to mutate against any drifted, partial, or duplicate binding — directs to `status`/`sync` instead.

**Flow**: preview → user approval → `--apply <token>` → live creation + read-back verification.

### status

Strictly read-only drift report. Classifies each unit as: unchanged, new-in-plan, missing-in-Beads, content-changed, dependencies-changed, removed-from-plan, closed-but-changed, duplicate-binding, corrupt-binding, externally-modified, dependency-baseline-corrupt, digest-drift.

### sync

Conservative reconciliation. Creates new units, updates changed open units, adds unambiguous dependencies, labels removed units (never deletes), treats closed-unit changes as conflicts. Preview → approval → apply. Idempotent on rerun.

## Operating contract for cold agents

1. **Preconditions**: `bd` must be on PATH; the workspace must be initialized (`bd init --non-interactive --init-if-missing --skip-agents --skip-hooks --stealth`); the plan must be `artifact_contract: ce-unified-plan/v1`, `artifact_readiness: implementation-ready`, `execution: code`.

2. **Initial bind vs existing binding**: If no binding exists, `bind` creates it. If a complete unchanged binding exists, `bind` returns the existing mapping. If any drift/partial/duplicate exists, `bind` refuses with `binding_drift` — go to `status` then `sync`.

3. **Machine output**: Always pass `--json`. The envelope's `outcome` and `diagnostics` drive your behavior. Ordinary drift is exit 0 with a semantic outcome; exit codes 2-9 are reserved for failures.

4. **Approval flow for mutations**: `bind` and `sync` emit a preview with `approval_token` when run without `--apply`. Show the preview to the user, obtain approval, then re-invoke with `--apply <token>`. A token mismatch aborts with zero mutations. Non-TTY never prompts.

5. **Direct `bd` boundary**: For readiness queries, use `bd ready --json --limit 0 --type task --metadata-field integration=ce-beads/v1 --metadata-field ce_plan_path=<path>`. The `--type task` filter is load-bearing — unfiltered `bd ready` returns the epic alongside tasks.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (including reported drift) |
| 2 | Usage error |
| 3 | Unsupported plan |
| 4 | Precondition failure (environment/workspace) |
| 5 | Conflict (blocking state, token mismatch) |
| 6 | Partial or indeterminate mutation |
| 7 | `bd` failure |
| 8 | Read-back failure |
| 9 | Lock busy |

## References

- `references/mapping.md` — CE contract → Beads mapping rules and metadata keys
- `references/reconciliation.md` — status/sync drift classes and blocking states

## Pinned upstreams

See `UPSTREAMS.lock.json` for pinned upstream SHAs and tested tool versions. The upstream checkouts (`upstream/compound-engineering-plugin`, `upstream/beads`) are **implementation provenance** — read-only references used during development to target the CE plan schema and the `bd` CLI surface. They are gitignored and are **not required at runtime**: the skill invokes the `bd` binary from PATH and never reads the upstream trees. Machine-specific paths (binary locations, local DB/workspace state) are intentionally omitted from the lock file; a local environment report, if present, lives at `docs/local-environment.md` (gitignored).
