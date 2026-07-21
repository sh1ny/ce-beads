import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { parsePlan } from "../skills/ce-beads/scripts/plan-parser.ts";
import {
  buildGraph,
  nodeKey,
  epicKey,
  canonicalUnitIds,
  canonicalDependencies,
  canonicalRequirements,
  unitDigest,
  renderUnitDescription,
  type GraphApplyNode,
} from "../skills/ce-beads/scripts/graph-builder.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "plans");
const REPO_ROOT = join(import.meta.dir, "..");

function plan(name: string) {
  return parsePlan(join(FIXTURES, name), { repoRoot: REPO_ROOT });
}

// Known field sets from upstream/beads/cmd/bd/graph_apply.go knownGraphNodeFields.
const KNOWN_NODE_FIELDS = new Set([
  "key", "title", "type", "description", "assignee", "assign_after_create",
  "priority", "estimate", "labels", "metadata", "metadata_refs",
  "external_ref", "parent", "parent_key", "parent_id", "deps",
]);

const KNOWN_EDGE_FIELDS = new Set([
  "from_key", "from_id", "to_key", "to_id", "type",
]);

describe("graph-builder: happy path", () => {
  it("linear fixture produces 1 epic + 3 task nodes, 2 edges, each task's parent_key = epic key", () => {
    const p = plan("02-linear-three-unit.md");
    const g = buildGraph(p);
    const epics = g.nodes.filter((n) => n.type === "epic");
    const tasks = g.nodes.filter((n) => n.type === "task");
    expect(epics).toHaveLength(1);
    expect(tasks).toHaveLength(3);
    expect(g.edges).toHaveLength(2);
    const eKey = epics[0]!.key;
    for (const task of tasks) {
      expect(task.parent_key).toBe(eKey);
    }
  });
});

describe("graph-builder: direction", () => {
  it("the U2->U1 edge has from_key = U2's key and to_key = U1's key", () => {
    const p = plan("02-linear-three-unit.md");
    const g = buildGraph(p);
    const u1Key = nodeKey(p.path, "U1");
    const u2Key = nodeKey(p.path, "U2");
    const u3Key = nodeKey(p.path, "U3");

    const edge21 = g.edges.find((e) => e.from_key === u2Key && e.to_key === u1Key);
    expect(edge21).toBeDefined();
    expect(edge21!.type).toBe("blocks");

    const edge32 = g.edges.find((e) => e.from_key === u3Key && e.to_key === u2Key);
    expect(edge32).toBeDefined();

    // Assert no inverted edges exist.
    const inverted21 = g.edges.find((e) => e.from_key === u1Key && e.to_key === u2Key);
    expect(inverted21).toBeUndefined();
  });
});

describe("graph-builder: independence", () => {
  it("parallel-units fixture produces zero edges between the independent units", () => {
    const p = plan("03-parallel-units.md");
    const g = buildGraph(p);
    expect(g.edges).toHaveLength(0);
    expect(g.nodes.filter((n) => n.type === "task")).toHaveLength(2);
  });
});

describe("graph-builder: metadata", () => {
  it("every node carries the required string-valued metadata keys", () => {
    const p = plan("02-linear-three-unit.md");
    const g = buildGraph(p);
    const epic = g.nodes.find((n) => n.type === "epic")!;
    expect(epic.metadata.integration).toBe("ce-beads/v1");
    expect(epic.metadata.ce_plan_path).toBe(p.path);
    expect(epic.metadata.ce_plan_digest).toBe(p.digest);
    expect(epic.metadata.ce_artifact_contract).toBe("ce-unified-plan/v1");
    expect(epic.metadata.ce_unit_ids).toBe(canonicalUnitIds(p.units));

    for (const task of g.nodes.filter((n) => n.type === "task")) {
      expect(task.metadata.integration).toBe("ce-beads/v1");
      expect(task.metadata.ce_plan_path).toBe(p.path);
      expect(typeof task.metadata.ce_unit_id).toBe("string");
      expect(task.metadata.ce_unit_id).toMatch(/^U\d+$/);
      expect(typeof task.metadata.ce_unit_digest).toBe("string");
      expect(task.metadata.ce_unit_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof task.metadata.ce_requirements).toBe("string");
      expect(typeof task.metadata.ce_dependencies).toBe("string");
    }
  });

  it("ce_unit_ids on the epic is a sorted canonical JSON-array string", () => {
    const p = plan("02-linear-three-unit.md");
    const g = buildGraph(p);
    const epic = g.nodes.find((n) => n.type === "epic")!;
    expect(epic.metadata.ce_unit_ids).toBe('["U1","U2","U3"]');
  });

  it("ce_dependencies is a canonical JSON-array string, '[]' for dependency-free units", () => {
    const p = plan("02-linear-three-unit.md");
    const g = buildGraph(p);
    const u1 = g.nodes.find((n) => n.metadata.ce_unit_id === "U1")!;
    const u2 = g.nodes.find((n) => n.metadata.ce_unit_id === "U2")!;
    expect(u1.metadata.ce_dependencies).toBe("[]");
    expect(u2.metadata.ce_dependencies).toBe('["U1"]');
  });

  it("ce_requirements joins IDs with commas", () => {
    const p = plan("02-linear-three-unit.md");
    const g = buildGraph(p);
    const u1 = g.nodes.find((n) => n.metadata.ce_unit_id === "U1")!;
    expect(u1.metadata.ce_requirements).toBe("R1");
  });
});

describe("graph-builder: boundedness", () => {
  it("descriptions include all snapshot sections and exclude unrelated plan content", () => {
    const p = plan("02-linear-three-unit.md");
    const g = buildGraph(p);
    const u1 = g.nodes.find((n) => n.metadata.ce_unit_id === "U1")!;
    const u2 = g.nodes.find((n) => n.metadata.ce_unit_id === "U2")!;

    // U1 description includes U1's goal.
    expect(u1.description).toContain("Be the root of the chain.");
    // U1 description does NOT include U2's goal text.
    expect(u1.description).not.toContain("Depend on U1");
    // U2 description includes its own goal.
    expect(u2.description).toContain("Depend on U1");

    // All snapshot sections present.
    expect(u1.description).toContain("## Goal");
    expect(u1.description).toContain("## Requirements");
    expect(u1.description).toContain("## Files");
    expect(u1.description).toContain("## Approach");
    expect(u1.description).toContain("## Patterns to follow");
    expect(u1.description).toContain("## Test scenarios");
    expect(u1.description).toContain("## Verification");
    expect(u1.description).toContain("**Source plan:**");

    // Never includes the raw plan digest (KTD12: on epic only).
    expect(u1.description).not.toContain(p.digest);
  });
});

describe("graph-builder: schema", () => {
  it("emitted JSON validates against the upstream node/edge field set (no unknown top-level node fields)", () => {
    const p = plan("02-linear-three-unit.md");
    const g = buildGraph(p);
    for (const node of g.nodes) {
      for (const key of Object.keys(node)) {
        expect(KNOWN_NODE_FIELDS.has(key)).toBe(true);
      }
    }
    for (const edge of g.edges) {
      for (const key of Object.keys(edge)) {
        expect(KNOWN_EDGE_FIELDS.has(key)).toBe(true);
      }
    }
  });

  it("emitted JSON is serializable (no undefined values leak)", () => {
    const p = plan("02-linear-three-unit.md");
    const g = buildGraph(p);
    const json = JSON.stringify(g);
    expect(json).not.toContain("undefined");
    const parsed = JSON.parse(json) as { nodes: GraphApplyNode[]; edges: unknown[] };
    expect(parsed.nodes).toHaveLength(4);
    expect(parsed.edges).toHaveLength(2);
  });
});

describe("graph-builder: determinism", () => {
  it("golden JSON output for the linear fixture is stable across runs", () => {
    const p = plan("02-linear-three-unit.md");
    const g1 = buildGraph(p);
    const g2 = buildGraph(parsePlan(join(FIXTURES, "02-linear-three-unit.md"), { repoRoot: REPO_ROOT }));
    expect(JSON.stringify(g1)).toBe(JSON.stringify(g2));
  });

  it("golden JSON output for the parallel fixture is stable across runs", () => {
    const p = plan("03-parallel-units.md");
    const g1 = buildGraph(p);
    const g2 = buildGraph(parsePlan(join(FIXTURES, "03-parallel-units.md"), { repoRoot: REPO_ROOT }));
    expect(JSON.stringify(g1)).toBe(JSON.stringify(g2));
  });

  it("node keys are deterministic and independent of title", () => {
    const p = plan("02-linear-three-unit.md");
    const key1 = nodeKey(p.path, "U1");
    const key2 = nodeKey(p.path, "U1");
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(16);
    expect(key1).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("graph-builder: unit digest", () => {
  it("unit digest changes when unit content changes", () => {
    const p1 = plan("02-linear-three-unit.md");
    const p2 = plan("15-revised-change-u2.md");
    const eKey = epicKey(p1.path);
    const u2_1 = p1.units.find((u) => u.id === "U2")!;
    const u2_2 = p2.units.find((u) => u.id === "U2")!;
    const digest1 = unitDigest(u2_1, p1.path, eKey);
    const digest2 = unitDigest(u2_2, p2.path, eKey);
    expect(digest1).not.toBe(digest2);
  });

  it("unit digest is stable for unchanged units", () => {
    const p = plan("02-linear-three-unit.md");
    const eKey = epicKey(p.path);
    const u1 = p.units.find((u) => u.id === "U1")!;
    expect(unitDigest(u1, p.path, eKey)).toBe(unitDigest(u1, p.path, eKey));
  });
});

describe("graph-builder: optional fields", () => {
  it("optional fields render in description when present", () => {
    const p = plan("04-optional-fields.md");
    const g = buildGraph(p);
    const u1 = g.nodes.find((n) => n.metadata.ce_unit_id === "U1")!;
    expect(u1.description).toContain("## Execution note");
    expect(u1.description).toContain("## Technical design");
  });
});
