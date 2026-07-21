---
name: ce-beads-work
description: "Serial orchestrator that executes CE plans imported into Beads by launching Herdr-backed OMP workers, integrating their work, and closing Beads tasks safely (integrate-before-close invariant). Supports packet and run actions with crash recovery, reap, and abandon."
---

# ce-beads-work — Serial Plan Orchestrator

## What this skill does

ce-beads-work takes a CE plan that has already been bound to Beads (via
`ce-beads bind`) and executes it serially: one unit at a time, from
ready-task to closed-task, with a Herdr-backed OMP worker per unit.

The orchestrator drives a 6-state lifecycle per unit:

```
pending → claimed → worker_finished → captured → merged → verified → closed
                                                              ↘ blocked (from any state)
```

**Integrate-before-close invariant**: a Beads task is never closed until
the worker's changes are committed, merged into the integration branch,
and verified. A crash at any point is recoverable via persisted run-state.

## Actions

OMP injects this skill's absolute directory when you invoke
`/skill:ce-beads-work`, as a `[Skill directory: <absolute path>]` line in
the injected message. Set `SKILL_DIR` to that path — never assume a fixed
install location:

```bash
SKILL_DIR="<absolute path from the Skill directory line>"

# Build a standalone worker packet for inspection (no Beads mutation)
bun "$SKILL_DIR/../ce-beads/scripts/cli.ts" packet <plan-path> --unit <U-ID> [--json]

# Start a new orchestration run
bun "$SKILL_DIR/../ce-beads/scripts/cli.ts" run start <plan-path> [--once] [--json]

# Check run status
bun "$SKILL_DIR/../ce-beads/scripts/cli.ts" run status [run-id] [--json]

# Resume a blocked/failed run (optionally retry the blocked unit)
bun "$SKILL_DIR/../ce-beads/scripts/cli.ts" run resume <run-id> [--retry] [--json]

# Reap: clean up panes/worktrees/branches for a run (preview → apply)
bun "$SKILL_DIR/../ce-beads/scripts/cli.ts" run reap <run-id> [--force] [--apply <token>] [--json]

# Abandon: release Beads tasks for a blocked/failed run (preview → apply)
bun "$SKILL_DIR/../ce-beads/scripts/cli.ts" run abandon <run-id> [--apply <token>] [--json]
```

Always use `--json` for machine-readable output.

## Prerequisites

1. **ce-beads bind** must have been run first — the plan must be bound to
   a Beads epic with child tasks for each unit.
2. **Herdr** must be running (the coordinator launches workers via
   `herdr agent start`).
3. **OMP** must be installed (`--profile chinese` with `@smol` model role
   configured, or override via `CE_BEADS_OMP_PROFILE` and
   `CE_BEADS_WORKER_MODEL` env vars).
4. **bd** must be in PATH (Beads CLI for task management).

## Run lifecycle

### Starting a run

```bash
ce-beads run start docs/plans/my-plan.md
```

The orchestrator:
1. Parses the plan and verifies it's bound to Beads.
2. Refuses if an active run exists for the plan (`RUN_ACTIVE`).
3. Writes an initializing run-state (crash-recoverable).
4. Creates an integration branch + worktree.
5. Drives the serial loop: claim → worker → capture → verify → merge →
   verify → close, one unit at a time.

### Worker dispatch

Each unit gets:
- A dedicated git worktree forked from the integration HEAD (P0-1:
  worker sees prior units' merged work).
- An OMP worker launched via `herdr agent start` with the prompt as argv
  (atomic prompt delivery, no send-text/send-keys gap).
- A bounded packet (unit + verification commands + requirement defs +
  KTDs) written to `.ce-beads-worker/packet.json`.
- A system prompt (ce-beads-unit agent) at `.ce-beads-worker/system-prompt.md`.
- File-based completion: the worker writes `.ce-beads-worker/result.json`
  atomically (temp-then-rename). The orchestrator polls for file
  existence, NOT scrollback text.

### Crash recovery

Run-state is persisted after every state transition (under
`$GIT_DIR/ce-beads/run-<run-id>.json`). If the coordinator crashes:

```bash
ce-beads run resume <run-id>
```

Resume reads the run-state, validates the plan digest hasn't drifted
(`PLAN_DIGEST_DRIFT` refusal if it has), and re-enters the loop at the
correct step for the in-flight unit.

### Blocked runs

A unit can block at any state (verification failure, worker failure,
merge conflict, changed_files mismatch). A blocked run STOPS — the
serial MVP does not skip blocked units.

To retry:
```bash
ce-beads run resume <run-id> --retry
```

`--retry` reads the blocked unit's `last_successful_state` and re-enters
the loop at the correct step. Merge-conflict blocks are NOT auto-retried
(human must resolve).

### Cleanup

**Reap** cleans up panes/worktrees/branches without touching Beads:
```bash
ce-beads run reap <run-id>              # preview
ce-beads run reap <run-id> --apply <token>  # execute
```

**Abandon** releases Beads tasks (reopens, clears labels/metadata)
without touching worktrees:
```bash
ce-beads run abandon <run-id>              # preview
ce-beads run abandon <run-id> --apply <token>  # execute
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CE_BEADS_OMP_PROFILE` | `chinese` | OMP profile for workers |
| `CE_BEADS_WORKER_MODEL` | `@smol` | OMP model role for workers |
| `BEADS_DIR` | `<repo>/.beads` | Beads workspace directory |

## Worker agent

The worker agent (`agents/ce-beads-unit.md`) is a restricted OMP agent:
- Tools: read, grep, glob, bash, edit, write, lsp, ast_grep (no `task`,
  no `bd`)
- Cannot commit, push, merge, or create branches
- Cannot spawn sub-agents
- Completes by writing `.ce-beads-worker/result.json` atomically

This is defense-in-depth, not physical isolation — the coordinator
validates all worker output and owns all integration/commits.

## Protocol

All output follows `ce-beads-protocol/1`. New diagnostics for the
orchestrator: `UNIT_NOT_FOUND`, `NOT_BOUND`, `RUN_ACTIVE`, `RUN_NOT_FOUND`,
`RUN_STATE_CORRUPT`, `WORKER_FAILED`, `WORKER_BLOCKED`, `VERIFICATION_FAILED`,
`INTEGRATION_FAILED`, `CHANGED_FILES_INVALID`, `RUNTIME_FAILURE`,
`PLAN_DIGEST_DRIFT`, `EXTERNAL_CHANGE`.
