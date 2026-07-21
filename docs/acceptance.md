# Installed-Plugin Acceptance Procedure

Manual acceptance gate for the ce-beads **installed OMP plugin**. The
implementation agent must not run this procedure — it launches a separate OMP
profile and invokes `omp` commands the agent is forbidden from running. Only
the human runs this gate.

## Prerequisites

- The ce-beads repository is checked out locally (referred to as `<repo>` below)
- `bd` 1.1.0 is installed and on PATH
- Bun 1.3.14+ is installed
- OMP 17.0.5+ is installed

## Step 0 — Link the plugin into the acceptance profile

From the ce-beads repo root, link the plugin into a dedicated acceptance
profile. Plugin storage is profile-scoped (`~/.omp/profiles/<name>/plugins` for
named profiles), so the `OMP_PROFILE` prefix is load-bearing: a default-profile
link is invisible to a named profile.

```bash
OMP_PROFILE=ce-beads-plugin-test omp plugin link .
OMP_PROFILE=ce-beads-plugin-test omp plugin list --json
OMP_PROFILE=ce-beads-plugin-test omp plugin doctor --json
```

Expected: `plugin list --json` shows `ce-beads@0.1.0` under npm plugins;
`plugin doctor --json` shows `plugin:ce-beads` ok and no error checks.

## Step 1 — Disposable consumer project (required for every run)

Every acceptance run binds the fixture plan into a **fresh, disposable** Beads
workspace isolated from the repository's normal `.beads` database. This makes
reruns hermetic: no prior binding state to clean up, and the repository's
development workspace is never touched. Do **not** delete bindings from an
existing workspace to reset state — create a new isolated one each time.

```bash
export CE_CONSUMER="$(mktemp -d -t ce-beads-consumer-XXXXXX)"
export BEADS_DIR="$(mktemp -d -t ce-beads-beads-XXXXXX)"
cd "$CE_CONSUMER"
bd init --non-interactive --init-if-missing --skip-agents --skip-hooks --stealth
cp <repo>/tests/fixtures/plans/02-linear-three-unit.md ./plan.md
```

`BEADS_DIR` is read by `bd` and by the ce-beads scripts (they inherit it from
the environment). Every command in the workflow below runs with this `BEADS_DIR`
exported in the same shell. The disposable dirs can be `rm -rf`'d after the run.

## Step 2 — Launch

From `$CE_CONSUMER`, with `BEADS_DIR` exported as above, run:

```bash
omp --profile ce-beads-plugin-test
```

**Important**: Do NOT use `--no-skills` or `--no-rules`. The acceptance profile
must discover the installed `ce-beads` plugin skill.

## Step 3 — Prompt

Paste this prompt into the `ce-beads-plugin-test` profile. It assumes `BEADS_DIR`
is already exported in the launching shell (omp inherits the environment):

```
A skill named `ce-beads` is installed as an OMP plugin in this profile.
Invoke it with /skill:ce-beads and follow its instructions.

The shell environment has BEADS_DIR set to a fresh, disposable Beads workspace.
Use only that workspace; do not target any other .beads database, and do not
delete existing bindings anywhere.

Using only the ce-beads skill and direct bd commands, accomplish this workflow:

1. Run `doctor` to verify the environment is healthy.
2. Bind the plan at `plan.md` into Beads. Use the preview → approval flow:
   - Run `bind plan.md --json` to get the preview.
   - STOP after the preview. Do not apply in the same turn. Do not approve
     on the user's behalf. Present the preview and the exact approval_token
     to the user and wait for explicit human approval.
   - After human approval, apply the exact token from the displayed preview
     with `bind plan.md --json --apply <token>`. Do not rerun `bind` to
     capture the token — that generates a new preview with a different token.
3. Verify that U1 is initially ready (use `bd ready` with the correct filters).
4. Claim and close U1 using Beads commands.
5. Verify that U2 becomes ready.
6. Rebind the same plan — verify no duplicates are created.
7. Run `status` on the bound plan — verify it reports the current state.
8. Report what you did and what you observed.

Do not install Compound Engineering. Do not invoke ce-plan, ce-work, or any CE
runtime skill. Use only the ce-beads skill and direct bd commands.
```

## Step 4 — Expected observable results

The acceptance profile should:

1. **Skill injection**: `/skill:ce-beads` injects the skill with a
   `[Skill directory: <abs path>]` line ending in
   `…/node_modules/ce-beads/skills/ce-beads` under the profile's plugin store.
2. **doctor**: `outcome: "healthy"`, all checks pass (run via
   `bun "$SKILL_DIR/scripts/cli.ts" doctor --json`).
3. **bind preview**: `outcome: "preview"`, `approval_token`, 4 mutations
   (1 epic + 3 tasks).
4. **Human approval boundary**: the agent STOPS after the preview and waits
   for explicit human approval. There is a genuine user-turn boundary
   between the preview and the `--apply` call — the agent does not approve
   on the user's behalf or continue to apply in the same turn.
5. **bind apply**: the agent applies the **exact token from the displayed
   preview** (not a recomputed one). `outcome: "bound"` with U1/U2/U3 → Beads
   ID mapping.
6. **readiness**: `bd ready --json --limit 0 --type task --metadata-field integration=ce-beads/v1 --metadata-field ce_plan_path=plan.md`
   returns only U1's task.
7. **after `bd close <U1-id>`**: readiness returns U2.
8. **idempotent rebind**: `outcome: "already_bound"`, identical IDs, zero new issues.
9. **status**: U1 `unchanged` with `isClosed: true`; U2/U3 `unchanged`.
10. **No CE dependency**: no `ce-plan`, `ce-work`, `lfg`, Claude, Codex, MCP, or
    Dolt in the transcript.

## Step 5 — Return results

Return the acceptance profile's transcript (or a summary of what it did and
observed) to the builder session. Optional cleanup afterwards:

```bash
OMP_PROFILE=ce-beads-plugin-test omp plugin uninstall ce-beads
```

(Or leave the link in place for development; linked plugins reflect source
edits without reinstall.)

---

## Recorded acceptance result — installed plugin (2026-07-21)

**Status: PASS.** The installed-plugin acceptance gate passed on the second
run. The first run exposed a P1 approval-flow violation: the agent approved
the bind on the user's behalf and reran `bind` inside `TOKEN=$(…)` to capture
a recomputed token instead of preserving the one shown to the human. Fixed by
strengthening `SKILL.md` contract item 4 and the acceptance prompt with
explicit STOP / never-approve / preserve-exact-token rules, with documentation
regression assertions added to `tests/docs.test.ts`.

Observed results matched every expected observation, including the two
approval-flow requirements:

1. **Skill injection**: `/skill:ce-beads` injected the skill with
   `[Skill directory: …/node_modules/ce-beads/skills/ce-beads]`.
2. **doctor**: `outcome: "healthy"` — all 5 checks passing.
3. **bind preview**: `outcome: "preview"` with `approval_token` and 4
   mutations (1 epic + 3 tasks).
4. **Human approval boundary**: the agent STOPPED after the preview,
   presented the mutation table and exact token, and waited for explicit
   human approval. A genuine user-turn boundary existed between preview
   and apply — the agent did not approve on the user's behalf.
5. **bind apply**: the agent applied the exact token from the displayed
   preview (not a recomputed one). `outcome: "bound"` with U1/U2/U3 →
   Beads ID mapping.
6. **initial readiness**: only U1 ready (U2, U3 blocked).
7. **after closing U1**: only U2 ready (U3 still blocked).
8. **idempotent rebind**: `outcome: "already_bound"` with identical Beads
   IDs — zero new issues, zero mutations (verified 4 total issues with
   `--status all`).
9. **status**: U1 `unchanged` with `isClosed: true`; U2/U3 `unchanged`.
10. **No CE dependency**: only the ce-beads skill and `bd` used.

Runtime: OMP 17.0.6, bd 1.1.0, Bun 1.3.14. Accepted on a linked plugin
checkout (`OMP_PROFILE=ce-beads-plugin-test omp plugin link .`).

---

## Historical evidence — MVP acceptance (2026-07-21)

This section is preserved as historical evidence. It records the MVP
acceptance run, which used project-local `.omp/skills` discovery — the
discovery mechanism superseded by the installed-plugin packaging above.
The bridge behavior evidence remains valid.

### Recorded acceptance result — U11 (2026-07-21)

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
