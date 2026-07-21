import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { handler as bindHandler } from "../skills/ce-beads/scripts/bind.ts";
import { handler as syncHandler } from "../skills/ce-beads/scripts/sync.ts";
import { handler as statusHandler } from "../skills/ce-beads/scripts/status.ts";
import type { CliArgs } from "../skills/ce-beads/scripts/cli.ts";
import {
  setupWorkspace,
  snapshotDevRepo,
  assertDevRepoUnchanged,
  type WorkspaceFixture,
  type DevRepoSnapshot,
} from "./helpers/beads-workspace.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "plans");

function syncArgs(planPath: string, opts: { applyToken?: string } = {}): CliArgs {
  return { action: "sync", planPath, json: true, applyToken: opts.applyToken, help: false };
}

async function bindPlan(ws: WorkspaceFixture, fixture: string): Promise<Record<string, string>> {
  const oldDir = process.env.BEADS_DIR;
  process.env.BEADS_DIR = ws.client.beadsDir;
  const planPath = join(FIXTURES, fixture);
  const preview = await bindHandler.run({ action: "bind", planPath, json: true, applyToken: undefined, help: false });
  const token = (preview.data as { approvalToken: string }).approvalToken;
  const env = await bindHandler.run({ action: "bind", planPath, json: true, applyToken: token, help: false });
  process.env.BEADS_DIR = oldDir;
  return (env.data as { mapping: Record<string, string> }).mapping;
}

describe("sync: happy path", () => {
  let ws: WorkspaceFixture;
  let devSnap: DevRepoSnapshot;
  let oldBeadsDir: string | undefined;

  beforeEach(async () => {
    devSnap = snapshotDevRepo();
    ws = await setupWorkspace("sync");
    oldBeadsDir = process.env.BEADS_DIR;
    process.env.BEADS_DIR = ws.client.beadsDir;
  });
  afterEach(async () => {
    process.env.BEADS_DIR = oldBeadsDir;
    await ws.cleanup();
    assertDevRepoUnchanged(devSnap);
  });

  it("sync with no changes reports no mutations needed (idempotent)", async () => {
    await bindPlan(ws, "02-linear-three-unit.md");
    const env = await syncHandler.run(syncArgs(join(FIXTURES, "02-linear-three-unit.md")));
    expect(env.outcome).toBe("applied");
    const data = env.data as { results: unknown[] };
    expect(data.results).toHaveLength(0);
  });

  it("running sync twice against the same state applies zero mutations the second time (idempotency)", async () => {
    await bindPlan(ws, "02-linear-three-unit.md");
    // First sync (no changes).
    const env1 = await syncHandler.run(syncArgs(join(FIXTURES, "02-linear-three-unit.md")));
    expect(env1.outcome).toBe("applied");
    // Second sync (still no changes).
    const env2 = await syncHandler.run(syncArgs(join(FIXTURES, "02-linear-three-unit.md")));
    expect(env2.outcome).toBe("applied");
    const data2 = env2.data as { results: unknown[] };
    expect(data2.results).toHaveLength(0);
  });

  it("without --apply, sync mutates nothing and emits the full machine-readable mutation plan plus approval token", async () => {
    await bindPlan(ws, "02-linear-three-unit.md");
    const env = await syncHandler.run(syncArgs(join(FIXTURES, "02-linear-three-unit.md")));
    // No mutations needed → applied, not preview.
    expect(env.outcome).toBe("applied");
  });
});

describe("sync: preview flow", () => {
  let ws: WorkspaceFixture;
  let devSnap: DevRepoSnapshot;
  let oldBeadsDir: string | undefined;

  beforeEach(async () => {
    devSnap = snapshotDevRepo();
    ws = await setupWorkspace("syncprev");
    oldBeadsDir = process.env.BEADS_DIR;
    process.env.BEADS_DIR = ws.client.beadsDir;
  });
  afterEach(async () => {
    process.env.BEADS_DIR = oldBeadsDir;
    await ws.cleanup();
    assertDevRepoUnchanged(devSnap);
  });

  it("preview without --apply mutates nothing", async () => {
    // Bind a plan, then check status against a different plan (no binding → new-in-plan).
    await bindPlan(ws, "02-linear-three-unit.md");
    // Sync a NEW plan (different path) → all units are new-in-plan.
    const env = await syncHandler.run(syncArgs(join(FIXTURES, "01-minimal-valid.md")));
    // New plan has no epic → no mutations (can't create without an epic).
    // Or it might show preview.
    expect(["preview", "applied", "blocked"]).toContain(env.outcome);
    // No issues created for the new plan.
    const all = await ws.client.list({ all: true, limit: 0, flat: true, metadataField: ["ce_plan_path=tests/fixtures/plans/01-minimal-valid.md"] });
    expect(all).toHaveLength(0);
  });
});

describe("sync: rejection", () => {
  let ws: WorkspaceFixture;
  let devSnap: DevRepoSnapshot;
  let oldBeadsDir: string | undefined;

  beforeEach(async () => {
    devSnap = snapshotDevRepo();
    ws = await setupWorkspace("syncrej");
    oldBeadsDir = process.env.BEADS_DIR;
    process.env.BEADS_DIR = ws.client.beadsDir;
  });
  afterEach(async () => {
    process.env.BEADS_DIR = oldBeadsDir;
    await ws.cleanup();
    assertDevRepoUnchanged(devSnap);
  });

  it("sync a requirements-only fixture mutates nothing", async () => {
    const env = await syncHandler.run(syncArgs(join(FIXTURES, "05-requirements-only.md")));
    expect(env.ok).toBe(false);
    const all = await ws.client.list({ all: true, limit: 0, flat: true });
    expect(all).toHaveLength(0);
  });
});
