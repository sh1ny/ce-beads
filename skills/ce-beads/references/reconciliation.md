# Reconciliation: Status and Sync Semantics

This reference documents every drift class `status` reports and every blocking
state that prevents `sync` mutation.

## Drift classes (status)

| Class | Meaning | Blocking? |
|-------|---------|-----------|
| `unchanged` | Unit is bound and matches the plan | No |
| `new-in-plan` | Unit is in the plan but not bound in Beads | No |
| `missing-in-beads` | Bound task was deleted outside ce-beads | Yes |
| `content-changed` | Open unit's content differs from the stored snapshot | No |
| `dependencies-changed` | Open unit's dependencies differ from baseline | No |
| `removed-from-plan` | Task exists in Beads but the U-ID is no longer in the plan | No |
| `closed-but-changed` | Closed unit's content changed since last sync | No (conflict) |
| `duplicate-binding` | Multiple Beads tasks have the same `ce_unit_id` | Yes |
| `corrupt-binding` | Task discovered via parent but missing `ce_unit_id` | Yes |
| `externally-modified` | Live projection hash ≠ stored `ce_unit_digest` | Yes |
| `dependency-baseline-corrupt` | Missing or malformed `ce_dependencies` metadata | Yes |
| `digest-drift` | Epic `ce_plan_digest` ≠ current raw plan digest | No |

## Blocking states (KTD19)

These states block ALL mutation by `bind` and `sync` until manually repaired:

- **DUPLICATE_BINDING**: more than one Beads task with the same `ce_unit_id`
- **CORRUPT_BINDING**: a discovered child lacks `ce_unit_id` metadata
- **EXTERNALLY_MODIFIED**: live projection hash ≠ stored `ce_unit_digest`
- **MISSING_IN_BEADS**: a bound task was deleted outside ce-beads
- **DEPENDENCY_BASELINE_CORRUPT**: missing or malformed `ce_dependencies`

## Sync rules (R8)

- **Creates** newly added U-IDs (wired to epic + declared dependencies)
- **Updates** the bounded snapshot for changed open units (preserves Beads ID)
- **Adds** desired-minus-live dependency edges automatically
- **Reports** baseline-minus-desired edges as conflicts with exact `bd dep remove` commands (never deletes edges itself — KTD18)
- **Labels** removed open units with `ce-plan-removed` (never deletes)
- **Removes** exactly the `ce-plan-removed` label when a U-ID returns to the plan (all other labels preserved)
- **Never reopens** a closed unit (KTD14)
- **Never overwrites** a closed unit's content (reports as conflict)
- **Final mutation** is the epic commit marker (`ce_plan_digest` + `ce_unit_ids`), applied only when every preceding mutation read back clean
- **Idempotent** on rerun — a fresh rerun derives all remaining work from plan + Beads alone

## Approval flow (KTD16)

1. `sync <plan-path>` (without `--apply`) emits the full mutation set + `approval_token`
2. User reviews the preview
3. `sync <plan-path> --apply <token>` recomputes the token under the lock and requires exact match before the first mutation
4. A mismatch produces zero mutations and a `TOKEN_MISMATCH` diagnostic

## Lock (KTD17)

Every mutating action (`bind`, `sync`) acquires a repo-scoped advisory lock keyed by the canonical plan path. The lock is OS-managed via `flock(2)`; ownership is released when the holding process dies. A contender fails fast with exit code 9 (LOCK_BUSY).
