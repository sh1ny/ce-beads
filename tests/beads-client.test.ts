import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  BeadsClient,
  BdError,
  createIsolatedWorkspace,
} from "../.omp/skills/ce-beads/scripts/beads-client.ts";
import {
  setupWorkspace,
  snapshotDevRepo,
  assertDevRepoUnchanged,
  type DevRepoSnapshot,
  type WorkspaceFixture,
} from "./helpers/beads-workspace.ts";

const REPO_ROOT = join(import.meta.dir, "..");

describe("beads-client: happy paths", () => {
  let ws: WorkspaceFixture;
  let devSnap: DevRepoSnapshot;

  beforeEach(async () => {
    devSnap = snapshotDevRepo();
    ws = await setupWorkspace("bc");
  });
  afterEach(async () => {
    await ws.cleanup();
    assertDevRepoUnchanged(devSnap);
  });

  it("creates an issue via the client and reads it back with matching title and metadata", async () => {
    const issue = await ws.client.create({
      title: "Test issue",
      type: "task",
      metadata: { ce_unit_id: "U1", integration: "ce-beads/v1" },
    });
    expect(issue.id).toBeTruthy();
    expect(issue.title).toBe("Test issue");
    expect(issue.metadata).toEqual({ ce_unit_id: "U1", integration: "ce-beads/v1" });

    const shown = await ws.client.show(issue.id);
    expect(shown).not.toBeNull();
    expect(shown!.title).toBe("Test issue");
    expect(shown!.metadata?.ce_unit_id).toBe("U1");
  });

  it("filtered readiness wrapper returns only open unblocked unit tasks — never the epic", async () => {
    // Create an epic and two tasks under it with a blocking dependency.
    const epic = await ws.client.create({ title: "Epic", type: "epic", metadata: { integration: "ce-beads/v1", ce_plan_path: "docs/plans/x.md" } });
    const u1 = await ws.client.create({
      title: "U1",
      type: "task",
      parent: epic.id,
      metadata: { integration: "ce-beads/v1", ce_plan_path: "docs/plans/x.md", ce_unit_id: "U1" },
    });
    const u2 = await ws.client.create({
      title: "U2",
      type: "task",
      parent: epic.id,
      metadata: { integration: "ce-beads/v1", ce_plan_path: "docs/plans/x.md", ce_unit_id: "U2" },
    });
    await ws.client.depAdd(u2.id, u1.id, "blocks");

    const ready = await ws.client.readyTasks("docs/plans/x.md");
    const readyIds = ready.map((i) => i.id);
    expect(readyIds).toContain(u1.id);
    expect(readyIds).not.toContain(u2.id); // blocked
    expect(readyIds).not.toContain(epic.id); // epic excluded by --type task
    // All returned issues are tasks, never epics.
    for (const i of ready) {
      expect(i.issue_type).toBe("task");
    }
  });

  it("dep add then filtered ready shows dependent blocked until blocker closes; dep remove restores readiness", async () => {
    const a = await ws.client.create({ title: "A", type: "task", metadata: { integration: "ce-beads/v1", ce_plan_path: "p.md", ce_unit_id: "U1" } });
    const b = await ws.client.create({ title: "B", type: "task", metadata: { integration: "ce-beads/v1", ce_plan_path: "p.md", ce_unit_id: "U2" } });
    await ws.client.depAdd(b.id, a.id, "blocks");

    let ready = await ws.client.readyTasks("p.md");
    expect(ready.map((i) => i.id).filter((id): id is string => id !== undefined)).toEqual([a.id]);

    // Close the blocker -> dependent unblocks.
    await ws.client.close(a.id);
    ready = await ws.client.readyTasks("p.md");
    expect(ready.map((i) => i.id)).toContain(b.id);

    // Re-open is not supported via close; instead test dep remove on a fresh pair.
    const c = await ws.client.create({ title: "C", type: "task", metadata: { integration: "ce-beads/v1", ce_plan_path: "p2.md", ce_unit_id: "U3" } });
    const d = await ws.client.create({ title: "D", type: "task", metadata: { integration: "ce-beads/v1", ce_plan_path: "p2.md", ce_unit_id: "U4" } });
    await ws.client.depAdd(d.id, c.id, "blocks");
    let ready2 = await ws.client.readyTasks("p2.md");
    expect(ready2.map((i) => i.id).filter((id): id is string => id !== undefined)).toEqual([c.id]);
    await ws.client.depRemove(d.id, c.id);
    ready2 = await ws.client.readyTasks("p2.md");
    expect(ready2.map((i) => i.id).filter((id): id is string => id !== undefined).sort()).toEqual([c.id, d.id].sort());
  });

  it("enumeration primitive returns closed issues and more than 50 issues (seed 60), proving --all --limit 0", async () => {
    // Seed 60 issues, close one, then enumerate.
    for (let i = 0; i < 60; i++) {
      const issue = await ws.client.create({
        title: `Issue ${i}`,
        type: "task",
        metadata: { integration: "ce-beads/v1", ce_plan_path: "docs/plans/enum.md", ce_unit_id: `U${i}` },
      });
      if (i === 0) {
        await ws.client.close(issue.id);
      }
    }
    const all = await ws.client.enumerateBinding("docs/plans/enum.md");
    expect(all.length).toBe(60);
    // At least one is closed.
    expect(all.some((i) => i.status === "closed")).toBe(true);
  });

  it("parent-child enumeration returns children of an epic", async () => {
    const epic = await ws.client.create({ title: "Epic", type: "epic", metadata: { integration: "ce-beads/v1", ce_plan_path: "docs/plans/pc.md" } });
    const t1 = await ws.client.create({ title: "T1", type: "task", parent: epic.id, metadata: { integration: "ce-beads/v1", ce_plan_path: "docs/plans/pc.md", ce_unit_id: "U1" } });
    const t2 = await ws.client.create({ title: "T2", type: "task", parent: epic.id, metadata: { integration: "ce-beads/v1", ce_plan_path: "docs/plans/pc.md", ce_unit_id: "U2" } });
    // An unrelated task not under the epic.
    await ws.client.create({ title: "Other", type: "task", metadata: { integration: "ce-beads/v1", ce_plan_path: "docs/plans/other.md" } });

    const children = await ws.client.children(epic.id);
    const childIds = children.map((c) => c.id);
    expect(childIds).toContain(t1.id);
    expect(childIds).toContain(t2.id);
    expect(children).toHaveLength(2);
  });
});

describe("beads-client: error path", () => {
  it("a failing bd command surfaces stderr and exit code, not a thrown string", async () => {
    const ws = await setupWorkspace("err");
    try {
      // show on a nonexistent id returns an error object (not non-zero exit);
      // to get a real non-zero exit, run dep add with a bad id.
      try {
        await ws.client.depAdd("nonexistent-id", "also-bad", "blocks");
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(BdError);
        const err = e as BdError;
        expect(err.kind).toBe("bd_failure");
        expect(err.exitCode).not.toBe(0);
        expect(err.stderr.length).toBeGreaterThan(0);
      }
    } finally {
      await ws.cleanup();
    }
  });
});

describe("beads-client: isolation", () => {
  it("with BEADS_DIR set to a temp workspace, the dev repo's .beads is never read or written", async () => {
    const devSnap = snapshotDevRepo();
    const ws = await setupWorkspace("iso");
    try {
      await ws.client.create({ title: "Iso test", type: "task", metadata: { integration: "ce-beads/v1", ce_plan_path: "iso.md" } });
      const list = await ws.client.enumerateBinding("iso.md");
      expect(list).toHaveLength(1);
    } finally {
      await ws.cleanup();
    }
    assertDevRepoUnchanged(devSnap);
  });

  it("two parallel test workspaces do not see each other's issues", async () => {
    const wsA = await setupWorkspace("parA");
    const wsB = await setupWorkspace("parB");
    try {
      await wsA.client.create({ title: "A-only", type: "task", metadata: { integration: "ce-beads/v1", ce_plan_path: "shared.md", ce_unit_id: "U1" } });
      await wsB.client.create({ title: "B-only", type: "task", metadata: { integration: "ce-beads/v1", ce_plan_path: "shared.md", ce_unit_id: "U2" } });

      const inA = await wsA.client.enumerateBinding("shared.md");
      const inB = await wsB.client.enumerateBinding("shared.md");
      expect(inA).toHaveLength(1);
      expect(inB).toHaveLength(1);
      expect(inA[0]!.title).toBe("A-only");
      expect(inB[0]!.title).toBe("B-only");
    } finally {
      wsA.cleanup();
      wsB.cleanup();
    }
  });
});

describe("beads-client: graph create", () => {
  it("graph dry-run returns preview without writing", async () => {
    const ws = await setupWorkspace("gd");
    try {
      const tmpGraph = join(ws.dir, "g.json");
      writeFileSync(
        tmpGraph,
        JSON.stringify({
          nodes: [
            { key: "epic", title: "E", type: "epic", metadata: { integration: "ce-beads/v1", ce_plan_path: "g.md" } },
            { key: "u1", title: "U1", type: "task", parent_key: "epic", metadata: { integration: "ce-beads/v1", ce_plan_path: "g.md", ce_unit_id: "U1" } },
          ],
          edges: [],
        }),
      );
      const dry = await ws.client.createGraph(tmpGraph, { dryRun: true });
      expect(dry).toHaveProperty("dry_run", true);
      expect(dry).toHaveProperty("node_count", 2);
      const list = await ws.client.list({ all: true, limit: 0, flat: true });
      expect(list).toHaveLength(0); // nothing written
    } finally {
      await ws.cleanup();
    }
  });

  it("graph apply returns key->id mapping and creates the issues", async () => {
    const ws = await setupWorkspace("ga");
    try {
      const tmpGraph = join(ws.dir, "g.json");
      writeFileSync(
        tmpGraph,
        JSON.stringify({
          nodes: [
            { key: "epic", title: "E", type: "epic", metadata: { integration: "ce-beads/v1", ce_plan_path: "g.md", ce_plan_digest: "abc" } },
            { key: "u1", title: "U1", type: "task", parent_key: "epic", metadata: { integration: "ce-beads/v1", ce_plan_path: "g.md", ce_unit_id: "U1", ce_dependencies: "[]" } },
            { key: "u2", title: "U2", type: "task", parent_key: "epic", metadata: { integration: "ce-beads/v1", ce_plan_path: "g.md", ce_unit_id: "U2", ce_dependencies: "[\"U1\"]" } },
          ],
          edges: [{ from_key: "u2", to_key: "u1", type: "blocks" }],
        }),
      );
      const result = await ws.client.createGraph(tmpGraph);
      expect(result).toHaveProperty("ids");
      const ids = (result as { ids: Record<string, string> }).ids;
      expect(Object.keys(ids)).toHaveLength(3);
      // u2 is blocked by u1; ready should show only u1.
      const ready = await ws.client.readyTasks("g.md");
      expect(ready.map((i) => i.id).filter((id): id is string => id !== undefined)).toEqual([ids["u1"]!]);
    } finally {
      await ws.cleanup();
    }
  });
});
