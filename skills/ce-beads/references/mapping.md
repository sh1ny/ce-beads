# CE Contract → Beads Mapping

This reference documents the exact mapping from CE plan artifacts to Beads graph
structures, including all metadata keys emitted by the graph builder.

## Artifact contract

ce-beads supports exactly:
- `artifact_contract: ce-unified-plan/v1`
- `artifact_readiness: implementation-ready`
- `execution: code`

All other shapes are rejected before any Beads mutation.

## Graph structure

One `bd create --graph` JSON plan per bind:

- **1 epic node** representing the plan
- **1 task node per implementation unit** (child of the epic via `parent_key`)
- **1 blocking edge per CE dependency** (`from_key` = dependent, `to_key` = blocker, `type: "blocks"`)

## Node keys

Keys derive from stable identity: `sha256(planPath + "::" + unitId)` truncated to 16 hex chars. Keys are deterministic across runs and independent of titles or ordinal position.

- Epic key: `sha256(planPath + "::__epic__")[:16]`
- Task key: `sha256(planPath + "::" + unitId)[:16]`

## Metadata keys

All metadata values are **strings** (KTD10: `bd create --graph` accepts `map[string]string`).

### Epic metadata

| Key | Value | Purpose |
|-----|-------|---------|
| `integration` | `ce-beads/v1` | Integration identifier |
| `ce_plan_path` | `docs/plans/example.md` | Canonical repo-relative plan path |
| `ce_plan_digest` | `<sha256 hex>` | sha256 over raw plan file bytes (KTD12) |
| `ce_artifact_contract` | `ce-unified-plan/v1` | Artifact contract |
| `ce_unit_ids` | `["U1","U2","U3"]` | Sorted canonical JSON-array string of unit roster (KTD12) |

### Unit (task) metadata

| Key | Value | Purpose |
|-----|-------|---------|
| `integration` | `ce-beads/v1` | Integration identifier |
| `ce_plan_path` | `docs/plans/example.md` | Canonical repo-relative plan path |
| `ce_unit_id` | `U1` | Stable CE unit ID |
| `ce_unit_digest` | `<sha256 hex>` | sha256 over versioned canonical projection (KTD12) |
| `ce_requirements` | `R1,R2` | Comma-joined requirement IDs |
| `ce_dependencies` | `["U1"]` or `[]` | Sorted, deduplicated JSON-array string (KTD18) |

## Dependency direction

If U2 depends on U1:
- Edge: `from_key` = U2's key, `to_key` = U1's key, `type: "blocks"`
- U2 is absent from `bd ready --type task` while U1 is open
- Closing U1 makes U2 ready

This direction is asserted in tests so an inverted graph fails.

## Identity

Cross-system identity is:
- **Epic**: canonical repo-relative plan path
- **Unit task**: plan path + stable CE U-ID

Titles, ordinal position, and generated Beads IDs are never used as identity. Identity is stored as searchable string metadata on the issue it identifies.

## Unit digest (KTD12)

The unit digest is sha256 over a versioned canonical projection of ce-beads-owned fields:

- `v`: `ce-beads-unit-digest/v1` (projection version)
- `title`, `goal`, `requirements`, `dependencies`, `files`, `approach`
- `executionNote`, `technicalDesign` (null when absent)
- `patterns`, `testScenarios`, `verification`
- `issueType`, `parentKey`, `planPath`, `unitId`

User-owned execution state (status, assignee, labels, notes, edges) is excluded — execution activity never produces false content drift.

## Bounded description

Each task description carries a bounded execution snapshot: goal, requirement IDs, files, approach, execution note, patterns, test scenarios, verification, source plan path + U-ID. Never the whole plan, never the raw plan digest (that lives on the epic only).
