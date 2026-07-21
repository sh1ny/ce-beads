---
name: ce-beads
description: "Bridge Compound Engineering implementation-ready plans into a Beads dependency graph. Supports doctor, bind, status, and sync actions with deterministic Bun/TypeScript scripts and proven Beads CLI integration."
---

# ce-beads — CE Plans → Beads Bridge

## What this skill does

ce-beads imports a Compound Engineering (CE) implementation-ready Markdown plan into a persistent Beads dependency graph. One epic represents the plan; one child task per implementation unit; blocking dependencies derived from CE unit dependencies. Plans remain immutable decision artifacts; Beads owns all mutable execution state.

## Actions

OMP injects this skill's absolute directory when you invoke `/skill:ce-beads`,
as a `[Skill directory: <absolute path>]` line in the injected message. Set
`SKILL_DIR` to that path — never assume a fixed install location (a project
config directory, a home directory, or a plugin store), and never hardcode a
path you happened to see:

```bash
SKILL_DIR="<absolute path from the Skill directory line>"
bun "$SKILL_DIR/scripts/cli.ts" doctor [plan-path] [--json]
bun "$SKILL_DIR/scripts/cli.ts" bind <plan-path> [--json] [--apply <token>]
bun "$SKILL_DIR/scripts/cli.ts" status <plan-path> [--json]
bun "$SKILL_DIR/scripts/cli.ts" sync <plan-path> [--json] [--apply <token>]
```

Shell commands always use the resolved `$SKILL_DIR` filesystem path — never a
`skill://` URI. `skill://ce-beads/...` is only for OMP's read interface
(references below).

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

**Flow**: preview → STOP and request human approval → `--apply <token>` → live creation + read-back verification.

The initial request to bind is **not** approval to apply. After emitting the
preview, STOP — do not continue to `--apply` in the same turn, do not approve
on the user's behalf. Present the preview and the exact `approval_token` to
the user, then request explicit human approval using your harness's native
ask tool (OMP: `ask`; other harnesses may differ). After approval, apply the
exact token from the displayed preview — never rerun `bind` to capture a token
(that generates a new preview with a different token), never recompute or
substitute a token.

### status

Strictly read-only drift report. Classifies each unit as: unchanged, new-in-plan, missing-in-Beads, content-changed, dependencies-changed, removed-from-plan, closed-but-changed, duplicate-binding, corrupt-binding, externally-modified, dependency-baseline-corrupt, digest-drift.

### sync

Conservative reconciliation. Creates new units, updates changed open units, adds unambiguous dependencies, labels removed units (never deletes), treats closed-unit changes as conflicts. Preview → human approval → apply (see contract item 4). Idempotent on rerun.

## Operating contract for cold agents

1. **Preconditions**: `bd` must be on PATH; the workspace must be initialized (`bd init --non-interactive --init-if-missing --skip-agents --skip-hooks --stealth`); the plan must be `artifact_contract: ce-unified-plan/v1`, `artifact_readiness: implementation-ready`, `execution: code`.

2. **Initial bind vs existing binding**: If no binding exists, `bind` creates it. If a complete unchanged binding exists, `bind` returns the existing mapping. If any drift/partial/duplicate exists, `bind` refuses with `binding_drift` — go to `status` then `sync`.

3. **Machine output**: Always pass `--json`. The envelope's `outcome` and `diagnostics` drive your behavior. Ordinary drift is exit 0 with a semantic outcome; exit codes 2-9 are reserved for failures.

4. **Approval flow for mutations** (bind and sync):
   - Run without `--apply` to get a preview with an `approval_token` and mutation list.
   - The initial request to bind or sync is **not** approval to apply. After the preview, **STOP**. Do not continue to `--apply` in the same turn.
   - **Never approve on the user's behalf.** Present the preview, state the exact `approval_token`, and request explicit human approval using your harness's native ask tool (OMP: `ask`; other harnesses may differ). Do not proceed until the user explicitly approves.
   - **Preserve the exact token** from the displayed preview. After approval, apply that token with `--apply <token>`. Never rerun the action to capture a token — `TOKEN=$(bun ... bind ... --json)` generates a *new* preview with a *different* token, discarding the one shown to the user. Never recompute or substitute a token.
   - A token mismatch aborts with zero mutations. Non-TTY never prompts.

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

- `skill://ce-beads/references/mapping.md` — CE contract → Beads mapping rules and metadata keys
- `skill://ce-beads/references/reconciliation.md` — status/sync drift classes and blocking states

## Pinned upstreams

See `UPSTREAMS.lock.json` at the package root (`$SKILL_DIR/../..`) for pinned upstream SHAs and tested tool versions. The upstream checkouts (`upstream/compound-engineering-plugin`, `upstream/beads`) are **implementation provenance** — read-only references used during development to target the CE plan schema and the `bd` CLI surface. They are gitignored and are **not required at runtime**: the skill invokes the `bd` binary from PATH and never reads the upstream trees. Machine-specific paths (binary locations, local DB/workspace state) are intentionally omitted from the lock file.
