# Clean-Profile Acceptance Procedure

This document defines the manual acceptance gate (U11) for ce-beads. The
implementation agent must not run this procedure — it is launched by the user
with a fresh OMP profile.

## Prerequisites

- The ce-beads repository is checked out locally (referred to as `<repo>` below)
- `bd` 1.1.0 is installed and on PATH
- Bun 1.3.14+ is installed
- OMP 17.0.5+ is installed

## Isolated disposable workspace (required for every run)

Every acceptance run binds the fixture plan into a **fresh, disposable** Beads
workspace isolated from the repository's normal `.beads` database. This makes
reruns hermetic: no prior binding state to clean up, and the repository's
development workspace is never touched. Do **not** delete bindings from an
existing workspace to reset state — create a new isolated one each time.

Before launching the profile, create and export a throwaway `BEADS_DIR`:

```bash
# From the repository root. Use a fresh temp dir per run.
export BEADS_DIR="$(mktemp -d -t ce-beads-acceptance-XXXXXX)"
bd init --non-interactive --init-if-missing --skip-agents --skip-hooks --stealth
```

`BEADS_DIR` is read by `bd` and by the ce-beads scripts (they inherit it from
the environment). Every command in the workflow below runs with this `BEADS_DIR`
exported in the same shell. The disposable dir can be `rm -rf`'d after the run.

## Step 1: Launch the acceptance profile

From the repository root, with `BEADS_DIR` exported as above, run:

```bash
omp --profile ce-beads-test
```

**Important**: Do NOT use `--no-skills` or `--no-rules`. The acceptance profile
must discover the project-local `.omp/skills/ce-beads` skill.

## Step 2: Give the acceptance prompt

Paste this prompt into the `ce-beads-test` profile. It assumes `BEADS_DIR` is
already exported in the launching shell (omp inherits the environment):

```
You are in the ce-beads repository. A project-local skill `ce-beads` is
available at `.omp/skills/ce-beads/`.

The shell environment has BEADS_DIR set to a fresh, disposable Beads workspace.
Use only that workspace; do not target any other .beads database, and do not
delete existing bindings anywhere.

Using only the skill (discover it via /skill:ce-beads or by reading
.omp/skills/ce-beads/SKILL.md), accomplish this workflow:

1. Run `doctor` to verify the environment is healthy.
2. Bind the linear fixture plan at `tests/fixtures/plans/02-linear-three-unit.md`
   into Beads. Use the preview → approval flow.
3. Verify that U1 is initially ready (use `bd ready` with the correct filters).
4. Claim and close U1 using Beads commands.
5. Verify that U2 becomes ready.
6. Rebind the same plan — verify no duplicates are created.
7. Run `status` on the bound plan — verify it reports the current state.
8. Report what you did and what you observed.

Do not install Compound Engineering. Do not invoke ce-plan, ce-work, or any CE
runtime skill. Use only the ce-beads skill and direct bd commands.
```

## Step 3: Expected observable results

The acceptance profile should:

1. **Discover the skill**: The profile loads `.omp/skills/ce-beads/SKILL.md` and
   follows its instructions.

2. **doctor passes**: `bun .omp/skills/ce-beads/scripts/cli.ts doctor --json`
   returns `outcome: "healthy"` with all checks passing.

3. **bind preview**: The first `bind` call (without `--apply`) returns
   `outcome: "preview"` with an `approval_token` and 4 mutations (1 epic + 3 tasks).

4. **bind apply**: The second `bind` call (with `--apply <token>`) returns
   `outcome: "bound"` with a U-ID → Beads ID mapping for U1, U2, U3.

5. **readiness**: `bd ready --json --limit 0 --type task --metadata-field integration=ce-beads/v1 --metadata-field ce_plan_path=tests/fixtures/plans/02-linear-three-unit.md`
   returns only U1's task (U2 and U3 are blocked).

6. **close U1**: After `bd close <U1-beads-id>`, the readiness query returns U2.

7. **idempotent rebind**: A second `bind` (same plan, no `--apply`) returns
   `outcome: "already_bound"` with the same Beads IDs — zero new issues.

8. **status**: `bun .omp/skills/ce-beads/scripts/cli.ts status tests/fixtures/plans/02-linear-three-unit.md --json`
   reports U1 as closed (`isClosed: true`), U2 and U3 as unchanged (or U2 ready if claimed).

9. **No CE dependency**: The transcript shows no `ce-plan`, `ce-work`, `lfg`,
   Claude, Codex, MCP, or Dolt dependency — only the ce-beads skill and `bd`.

## Step 4: Return the results

Return the acceptance profile's transcript (or a summary of what it did and
observed) to the builder session. The builder will analyze any failures and
fix them, then stop at this gate again for another clean-profile run if needed.

---

## Recorded acceptance result — U11 (2026-07-21)

**Status: PASS.** The manual acceptance gate passed on the second clean-profile
run (the first run surfaced a closed-task discovery bug, fixed in `beads-client.ts`
`children()` with `all: true`, with regression tests added in `bind.test.ts` and
`status.test.ts`).

Observed results matched every expected observation:

1. **doctor**: `outcome: "healthy"` — all checks passing.
2. **bind preview**: `outcome: "preview"` with `approval_token` and 4 mutations
   (1 epic + 3 tasks).
3. **bind apply**: `outcome: "bound"` — epic + U1/U2/U3 mapping created.
4. **initial readiness**: only U1 ready (U2, U3 blocked).
5. **after closing U1**: only U2 ready (U3 still blocked by U3's own deps).
6. **idempotent rebind**: `outcome: "already_bound"` with identical Beads IDs —
   zero new issues, zero mutations.
7. **status**: U1 classified `unchanged` with `isClosed: true` (retained in the
   binding, not re-created); U2/U3 `unchanged`.
8. **No CE runtime installed or invoked**: transcript used only the ce-beads
   skill and `bd`. No `ce-plan`, `ce-work`, `lfg`, Claude, Codex, MCP, or Dolt
   dependency.

U11 acceptance is complete.
