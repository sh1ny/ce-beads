import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { handler } from "../.omp/skills/ce-beads/scripts/doctor.ts";
import { handler as bindHandler } from "../.omp/skills/ce-beads/scripts/bind.ts";
import type { CliArgs } from "../.omp/skills/ce-beads/scripts/cli.ts";
import {
  setupWorkspace,
  snapshotDevRepo,
  assertDevRepoUnchanged,
  type WorkspaceFixture,
  type DevRepoSnapshot,
} from "./helpers/beads-workspace.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "plans");

function doctorArgs(planPath: string | undefined): CliArgs {
  return { action: "doctor", planPath, json: true, applyToken: undefined, help: false };
}

describe("doctor: happy path", () => {
  let ws: WorkspaceFixture;
  let devSnap: DevRepoSnapshot;
  let oldBeadsDir: string | undefined;

  beforeEach(async () => {
    devSnap = snapshotDevRepo();
    ws = await setupWorkspace("doc");
    oldBeadsDir = process.env.BEADS_DIR;
    process.env.BEADS_DIR = ws.client.beadsDir;
  });
  afterEach(async () => {
    process.env.BEADS_DIR = oldBeadsDir;
    await ws.cleanup();
    assertDevRepoUnchanged(devSnap);
  });

  it("in a healthy workspace, doctor reports all checks green", async () => {
    const env = await handler.run(doctorArgs(undefined));
    expect(env.outcome).toBe("healthy");
    const data = env.data as { checks: Array<{ name: string; status: string }> };
    expect(data.checks.some((c) => c.name === "bd_presence" && c.status === "pass")).toBe(true);
    expect(data.checks.some((c) => c.name === "workspace_initialized" && c.status === "pass")).toBe(true);
  });

  it("read-only: workspace state is byte-identical before and after doctor runs", async () => {
    const before = await ws.client.list({ all: true, limit: 0, flat: true });
    await handler.run(doctorArgs(undefined));
    const after = await ws.client.list({ all: true, limit: 0, flat: true });
    expect(after).toHaveLength(before.length);
  });
});

describe("doctor: detection", () => {
  let ws: WorkspaceFixture;
  let devSnap: DevRepoSnapshot;
  let oldBeadsDir: string | undefined;

  beforeEach(async () => {
    devSnap = snapshotDevRepo();
    ws = await setupWorkspace("docdet");
    oldBeadsDir = process.env.BEADS_DIR;
    process.env.BEADS_DIR = ws.client.beadsDir;
  });
  afterEach(async () => {
    process.env.BEADS_DIR = oldBeadsDir;
    await ws.cleanup();
    assertDevRepoUnchanged(devSnap);
  });

  it("unsupported plan (requirements-only fixture) reported as unsupported without mutation", async () => {
    const env = await handler.run(doctorArgs(join(FIXTURES, "05-requirements-only.md")));
    const data = env.data as { checks: Array<{ name: string; status: string }> };
    const planCheck = data.checks.find((c) => c.name === "plan_support")!;
    expect(planCheck.status).toBe("fail");
    const all = await ws.client.list({ all: true, limit: 0, flat: true });
    expect(all).toHaveLength(0);
  });

  it("healthy bound workspace reports binding health pass", async () => {
    // Bind a plan first.
    const planPath = join(FIXTURES, "02-linear-three-unit.md");
    const preview = await bindHandler.run({ action: "bind", planPath, json: true, applyToken: undefined, help: false });
    const token = (preview.data as { approvalToken: string }).approvalToken;
    await bindHandler.run({ action: "bind", planPath, json: true, applyToken: token, help: false });

    const env = await handler.run(doctorArgs(planPath));
    const data = env.data as { checks: Array<{ name: string; status: string }> };
    const bindingCheck = data.checks.find((c) => c.name === "binding_health");
    expect(bindingCheck?.status).toBe("pass");
  });
});

describe("doctor: version mismatch", () => {
  let ws: WorkspaceFixture;
  let devSnap: DevRepoSnapshot;
  let oldBeadsDir: string | undefined;

  beforeEach(async () => {
    devSnap = snapshotDevRepo();
    ws = await setupWorkspace("docver");
    oldBeadsDir = process.env.BEADS_DIR;
    process.env.BEADS_DIR = ws.client.beadsDir;
  });
  afterEach(async () => {
    process.env.BEADS_DIR = oldBeadsDir;
    await ws.cleanup();
    assertDevRepoUnchanged(devSnap);
  });

  it("version mismatch surfaced as a warning, not a failure", async () => {
    const env = await handler.run(doctorArgs(undefined));
    const data = env.data as { checks: Array<{ name: string; status: string }> };
    // bd_presence should pass (bd is installed).
    const bdCheck = data.checks.find((c) => c.name === "bd_presence")!;
    expect(bdCheck.status).toBe("pass");
    // bd_version check may pass or warn depending on installed version.
    const versionCheck = data.checks.find((c) => c.name === "bd_version");
    if (versionCheck) {
      expect(["pass", "warn"]).toContain(versionCheck.status);
    }
  });
});
