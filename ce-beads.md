# CE-Beads OMP-First MVP Planning Brief

Plan an OMP-first MVP that bridges Compound Engineering implementation plans into Beads.

## Direction

Create a new standalone project named `ce-beads` that can consume a Compound Engineering implementation-ready Markdown plan and represent its implementation units as a persistent Beads dependency graph.

The first MVP targets Oh My Pi (OMP) running under WSL/Linux. Claude Code and Codex integrations will be considered later. The implementation plan must be executable by a clean OMP profile without Compound Engineering installed.

This is a brand-new repository. Assume it initially contains only this implementation plan and possibly an initialized Git repository. The plan must include all necessary project scaffolding.

## Settled decisions

Treat these as user-directed decisions.

### SD1 — OMP is the first supported harness

- Decision: Build and validate the MVP as an OMP-native project skill.
- Provenance: user-directed.
- Rejected alternative: Supporting OMP, Claude Code, and Codex simultaneously.
- Reason: Prove the integration in the harness actually used before introducing portability and packaging complexity.

### SD2 — CE is not installed in the execution environment

- Decision: The OMP builder and acceptance-test profiles must not have Compound Engineering installed.
- Provenance: user-directed.
- Rejected alternative: Running the implementation through `ce-work`.
- Reason: Avoid circular validation and prove that the CE plan contract can be consumed independently.

CE may be used to author this implementation plan, but the resulting plan must be self-contained and executable by ordinary OMP.

### SD3 — Standalone companion project

- Decision: Implement the bridge as a standalone companion project, not a fork or modification of Compound Engineering or Beads.
- Provenance: user-directed.
- Rejected alternative: Editing `ce-work` or adding Beads-specific behavior directly to CE.
- Reason: The MVP should validate the mapping and workflow before proposing an upstream tracker-provider seam.

### SD4 — OMP-native skill plus deterministic scripts

- Decision: Provide an OMP project skill under `.omp/skills/ce-beads/` backed by deterministic TypeScript/Bun scripts.
- Provenance: user-directed.
- Rejected alternative: Implementing the entire conversion through natural-language skill instructions.
- Reason: Parsing, idempotency, dependency mapping, and reconciliation need repeatable behavior and automated tests.

OMP already runs under Bun, so Bun/TypeScript is acceptable for the OMP-only MVP. Cross-platform binaries are outside this phase.

### SD5 — Markdown CE plans only

- Decision: Support `ce-unified-plan/v1` Markdown plans with `artifact_readiness: implementation-ready` and `execution: code`.
- Provenance: user-directed.
- Rejected alternative: Supporting legacy plans, requirements-only plans, HTML plans, and arbitrary Markdown immediately.
- Reason: The first version should target the current executable CE artifact contract and reject unsupported shapes clearly.

### SD6 — Beads is accessed only through its CLI

- Decision: Invoke the installed `bd` CLI using structured `--json` output.
- Provenance: user-directed.
- Rejected alternative: Accessing Dolt directly or using the Beads MCP server.
- Reason: The CLI is the canonical, lower-overhead interface and avoids coupling the bridge to Beads storage internals.

### SD7 — Plans remain immutable decision artifacts

- Decision: Never write task progress, Beads IDs, checkboxes, or status changes back into the CE plan.
- Provenance: user-directed.
- Rejected alternative: Bidirectional synchronization between plan text and Beads.
- Reason: CE defines the plan as a decision artifact; Beads owns mutable execution state.

## Bootstrap and environment requirements

The implementation plan must begin from a new WSL-native repository, preferably under a Linux path such as `~/dev/ce-beads`, not `/mnt/c` or `/mnt/f`.

The user will launch the executor approximately as:

```bash
omp --profile ce-beads-builder --no-skills --no-rules
```

and receive the instruction to read and execute the generated plan.

This builder-profile launch is external setup performed by the user. The implementation agent must not launch, nest, or spawn another OMP process, and it must not attempt to create, switch, or control OMP profiles from inside the running OMP session.

The plan must include:

1. Project scaffolding for a Bun/TypeScript CLI and test suite.
2. Read-only upstream checkouts under `upstream/`:
   - `https://github.com/EveryInc/compound-engineering-plugin`
   - `https://github.com/gastownhall/beads`
3. Recording the exact inspected commit SHAs and tested `bd` version in `UPSTREAMS.lock.json`.
4. Adding `upstream/` to `.gitignore`; do not vendor or modify the upstream repositories.
5. Verifying the upstream repositories remain clean after implementation.
6. Checking `bd --version`.
7. If `bd` is absent, installing it through the current official, checksum-verifying Beads installation path after inspecting the checked-out installation documentation or script. Do not blindly execute an unreviewed remote script.
8. Initializing the development repository with:

   ```bash
   bd init \
     --non-interactive \
     --init-if-missing \
     --skip-agents \
     --skip-hooks \
     --stealth
   ```

9. Recording the actual OMP and Bun versions used for validation.

Automated tests must use isolated temporary Beads workspaces or databases. They must never create test issues in the development repository's real `.beads` database.

## Upstream contracts to inspect

Do not plan from assumptions. The implementation agent must inspect the checked-out revisions.

From Compound Engineering, inspect at minimum:

- `skills/ce-plan/references/plan-sections.md`
- `skills/ce-plan/SKILL.md`
- `skills/ce-work/SKILL.md`
- At least one current implementation-ready plan fixture from `docs/plans/`

Determine the authoritative Markdown structure for:

- YAML frontmatter
- `Goal Capsule`
- `Implementation Units`
- `### U<N>.` unit headings
- Unit goals and titles
- Requirements references
- Dependencies
- Files
- Approach
- Execution notes
- Patterns to follow
- Test scenarios
- Verification
- Verification Contract
- Definition of Done

From Beads, inspect at minimum:

- `docs/cli-reference/init.md`
- `docs/cli-reference/create.md`
- `docs/cli-reference/list.md`
- `docs/cli-reference/update.md`
- `docs/core-concepts/dependencies.md`
- `cmd/bd/graph_apply.go`
- The bundled Beads skill's workflow and boundary documentation

Confirm:

- The `bd create --graph` schema.
- Dependency direction.
- Metadata filtering.
- Parent/child behavior.
- JSON output shapes.
- Claim and close semantics.
- Dry-run behavior.
- How to use isolated test workspaces.

## MVP deliverable

Create an OMP-native project skill:

```text
.omp/
└── skills/
    └── ce-beads/
        ├── SKILL.md
        ├── scripts/
        │   ├── cli.ts
        │   ├── plan-parser.ts
        │   ├── beads-client.ts
        │   ├── graph-builder.ts
        │   └── reconcile.ts
        └── references/
            ├── mapping.md
            └── reconciliation.md
```

The exact internal decomposition may change when planning discovers a better local structure, but the skill, deterministic implementation, and testable boundaries are required.

The skill must support these user-facing actions:

```text
ce-beads doctor
ce-beads bind <plan-path>
ce-beads status <plan-path>
ce-beads sync <plan-path>
```

Use the native OMP skill invocation conventions verified against the installed runtime.

### `doctor`

Read-only preflight that reports:

- Whether `bd` is installed.
- The tested versus installed Beads version.
- Whether the current repository is initialized for Beads.
- Whether the supplied CE plan is supported.
- Whether an existing binding is healthy.
- Duplicate mappings, missing tasks, dependency drift, or malformed metadata.
- The exact corrective command where safe.

`doctor` must not silently install Beads or initialize a project.

### `bind`

Initial import:

1. Resolve and validate the repo-relative plan path.
2. Validate the CE artifact contract and readiness.
3. Parse the plan into a typed internal representation.
4. Build a Beads graph consisting of:
   - One epic representing the plan.
   - One child task per implementation unit.
   - Blocking dependencies derived from CE unit dependencies.
5. Run `bd create --graph <temporary-file> --dry-run --json`.
6. Refuse live creation if validation or dry-run fails.
7. Apply the graph.
8. Verify the resulting graph by reading it back from Beads.
9. Return a concise mapping of CE U-IDs to Beads IDs.

Binding the same unchanged plan again must not create duplicate tasks.

### `status`

Strictly read-only comparison of the current plan against Beads.

Report:

- Bound and unchanged units.
- New plan units.
- Missing Beads tasks.
- Changed unit contents.
- Changed dependencies.
- Units removed from the plan.
- Closed Beads units whose corresponding plan unit changed.
- Duplicate bindings.
- Plan digest drift.
- Unsupported or malformed plan content.

Provide human-readable output and stable JSON output suitable for tests and later integration.

### `sync`

Reconcile safely:

- Create newly added U-IDs.
- Update the bounded snapshot for existing open units.
- Add or remove dependencies only when doing so is unambiguous and safe.
- Preserve Beads IDs.
- Never silently reopen a closed unit.
- Never silently delete a removed unit.
- Mark or report removed units using an explicit integration label such as `ce-plan-removed`.
- Treat changes to closed units as conflicts requiring user attention.
- Preview the complete mutation set before applying.
- Be idempotent when run repeatedly against the same state.
- On partial failure, report exactly what applied and make a subsequent rerun safe.

## Internal plan model

Plan for a typed intermediate representation resembling:

```ts
interface CePlan {
  path: string;
  digest: string;
  title: string;
  artifactContract: "ce-unified-plan/v1";
  readiness: "implementation-ready";
  execution: "code";
  units: CeUnit[];
}

interface CeUnit {
  id: string;
  title: string;
  goal: string;
  requirements: string[];
  dependencies: string[];
  files: string[];
  approach?: string;
  executionNote?: string;
  patterns: string[];
  testScenarios: string[];
  verification: string[];
}
```

Adjust the representation based on the actual upstream contract, but preserve a typed parsing boundary separate from Beads translation.

Reject before mutation:

- Requirements-only plans.
- Knowledge-work plans.
- HTML plans.
- Duplicate U-IDs.
- Missing dependency targets.
- Dependency cycles.
- Missing required implementation-unit fields.
- Unsupported artifact contracts.
- Paths outside the current repository.
- Plans whose current structure cannot be interpreted safely.

## Beads mapping

Use stable identity based on:

```text
canonical repo-relative plan path + stable CE U-ID
```

Do not use titles, ordinal position, or generated Beads IDs as the cross-system identity.

Store searchable string metadata similar to:

### Epic metadata

```json
{
  "integration": "ce-beads/v1",
  "ce_plan_path": "docs/plans/example.md",
  "ce_plan_digest": "sha256:...",
  "ce_artifact_contract": "ce-unified-plan/v1"
}
```

### Unit metadata

```json
{
  "integration": "ce-beads/v1",
  "ce_plan_path": "docs/plans/example.md",
  "ce_plan_digest": "sha256:...",
  "ce_unit_id": "U2",
  "ce_requirements": "R2,R4"
}
```

Respect the actual Beads graph-import metadata schema discovered upstream.

Each Beads task description should contain a bounded, readable execution snapshot:

- Goal
- Requirement IDs
- Files
- Approach
- Execution note
- Patterns
- Test scenarios
- Verification
- Source plan path and U-ID
- Plan digest

Avoid copying the entire plan into every task.

## Dependency semantics

Translate a CE unit dependency carefully.

If U2 depends on U1:

- U1 must be ready first.
- U2 must not appear in `bd ready` while U1 is open.
- Closing U1 must unblock U2.

Include explicit automated coverage for the dependency direction so an inverted graph cannot pass tests.

## Required fixtures and tests

Use Bun's test runner unless upstream or runtime investigation reveals a stronger OMP-native convention.

Create at least these fixtures:

1. Minimal valid implementation-ready plan.
2. Three-unit linear plan: U1 → U2 → U3.
3. Plan with independent units that should be ready in parallel.
4. Revised plan adding U4.
5. Revised plan changing an open U2.
6. Revised plan changing an already-closed U1.
7. Revised plan removing U2.
8. Requirements-only plan.
9. Knowledge-work plan.
10. Duplicate U-ID plan.
11. Missing dependency target.
12. Cyclic dependencies.
13. Malformed frontmatter.
14. HTML plan, rejected explicitly.

Test at least:

- Correct parsing of the supported CE contract.
- Clear rejection before mutation for unsupported plans.
- Correct graph JSON generation.
- Initial dry-run does not mutate Beads.
- Initial binding creates one epic and the expected tasks.
- U-ID-to-Beads-ID mappings are persisted and recoverable.
- Rebinding an unchanged plan creates no duplicates.
- `bd ready` initially exposes only U1 in the linear fixture.
- Closing U1 exposes U2.
- Independent units appear ready together.
- `status` detects all required drift classes without mutation.
- `sync` adds new units.
- `sync` safely updates open units.
- `sync` does not reopen or overwrite closed units.
- Removed units are reported or marked but not deleted.
- Dependency reconciliation has the correct direction.
- Interrupted or partial synchronization is safely rerunnable.
- Tests cannot reach or pollute the development repository's real Beads database.
- Upstream checkouts remain unmodified.

Tests should exercise the real `bd` CLI in isolated integration tests, not only mocked command output.

## Manual clean-profile acceptance test and required user gate

The plan must include a final acceptance procedure for a second empty OMP profile, but the implementation agent must not launch that profile itself. After implementation, automated tests, and acceptance-test documentation are ready, the agent must stop and ask the user to run:

```bash
omp --profile ce-beads-test
```

At this gate, the agent must provide:

- The exact working directory from which to launch OMP.
- The exact prompt to give the `ce-beads-test` profile.
- Any prerequisite model authentication or environment setup.
- The expected observable results.
- A request for the user to return the test output or failure details to the builder session.

The implementation agent must wait for the user's result. It must not use `omp -p`, shell scripts, subprocesses, terminal multiplexers, background processes, or any other mechanism to start OMP recursively. After the user returns the result, the builder may analyze failures, make fixes, rerun ordinary local tests, and stop at the same manual acceptance gate again when another clean-profile run is required.

When manually launched by the user, the acceptance profile must:

- Have no Compound Engineering installation.
- Load the project-local `.omp/skills/ce-beads` skill.
- Run `doctor`.
- Bind the linear fixture plan.
- Verify U1 is initially ready.
- Claim and close U1 using Beads.
- Verify U2 becomes ready.
- Rebind or synchronize without duplicates.
- Modify a copied fixture and verify drift detection.
- Demonstrate that the workflow can be understood and resumed using only the CE plan, Beads state, and the OMP-native skill.

Document the exact acceptance commands and expected observable results.

## Documentation deliverables

Include:

- `README.md` with prerequisites, WSL assumptions, setup, and examples.
- Architecture and source-of-truth explanation.
- Supported CE contract.
- Beads mapping.
- Idempotency and reconciliation behavior.
- Failure and recovery behavior.
- How to run tests.
- How to perform the clean-profile acceptance test.
- Known MVP limitations.
- Recorded upstream SHAs and tested tool versions.

## Non-goals

Explicitly exclude:

- Modifying Compound Engineering.
- Modifying Beads.
- Installing CE into OMP.
- Invoking `ce-plan`, `ce-work`, `lfg`, or other CE runtime skills from the MVP.
- Live lifecycle callbacks from `ce-work`.
- Claude Code integration.
- Codex integration.
- HTML plan support.
- Legacy CE plan support.
- Requirements-only plan enrichment.
- Direct Dolt access.
- Beads MCP integration.
- Multi-agent concurrent Beads writers.
- PR or CI gates.
- `ce-compound` or `bd remember` integration.
- Publishing an npm package or marketplace plugin.
- Cross-platform packaging outside OMP on WSL.
- Writing execution progress back into CE plans.

## Completion standard

The plan must be implementation-ready and executable from the empty WSL repository without relying on CE being present.

Completion requires:

- The OMP-native skill is discovered by a fresh OMP profile.
- All unit and integration tests pass.
- Initial import is correct and idempotent.
- Dependency readiness is proven through the real `bd` CLI.
- Drift detection and conservative synchronization work.
- Unsupported inputs fail before Beads mutation.
- The development Beads database is not polluted by tests.
- Both upstream checkouts remain clean.
- The implementation agent stops at the documented clean-profile acceptance gate and asks the user to run it without spawning OMP recursively.
- After the user supplies the result, the documented clean-profile acceptance scenario succeeds.
- No Claude, Codex, CE runtime, MCP, or direct Dolt dependency is introduced.

## Open naming choice

One naming choice can remain open during planning: whether the user-facing action should be called `bind` or `import`. The underlying identity and reconciliation semantics must remain unchanged either way.
