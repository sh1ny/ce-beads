import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { handler } from "../skills/ce-beads-work/scripts/packet.ts";
import type { CliArgs } from "../skills/ce-beads/scripts/cli.ts";
import { BeadsClient } from "../skills/ce-beads/scripts/beads-client.ts";
import { parsePlan } from "../skills/ce-beads/scripts/plan-parser.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "plans");

/** Build a CliArgs for the packet action with positional args. */
function makePacketArgs(planPath: string, unitId: string): CliArgs {
  return {
    action: "packet",
    planPath,
    json: true,
    applyToken: undefined,
    help: false,
    positional: ["packet", planPath, unitId],
    options: {},
    unitId,
    runSub: undefined,
    force: false,
    retry: false,
    once: false,
  };
}
function setupGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ce-beads-pkt-"));
  execSync('git init', { cwd: dir });
  execSync('git config user.email "t@t.com"', { cwd: dir });
  execSync('git config user.name "T"', { cwd: dir });
  execSync('git config commit.gpgsign false', { cwd: dir });
  execSync('git config beads.role maintainer', { cwd: dir });
  execSync('echo "# test" > README.md', { cwd: dir });
  execSync('git add README.md && git commit -m init', { cwd: dir });
  return dir;
}

function copyPlan(repoDir: string, fixture: string): string {
  const planPath = join(repoDir, "plan.md");
  execSync(`cp "${join(FIXTURES, fixture)}" "${planPath}"`);
  return planPath;
}

let savedCwd: string;
let savedBeadsDir: string | undefined;

beforeEach(() => { savedCwd = process.cwd(); savedBeadsDir = process.env.BEADS_DIR; });
afterEach(() => {
  process.chdir(savedCwd);
  if (savedBeadsDir === undefined) delete process.env.BEADS_DIR;
  else process.env.BEADS_DIR = savedBeadsDir;
});

describe("packet: builds a correct bounded packet (T1)", () => {
  let repoDir: string;
  let planPath: string;

  beforeEach(() => {
    repoDir = setupGitRepo();
    planPath = copyPlan(repoDir, "02-linear-three-unit.md");
    process.chdir(repoDir);
    // No BEADS_DIR set — unbound scenario.
    delete process.env.BEADS_DIR;
  });
  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  it("emits packet_built with verbatim plan IR fields", async () => {
    const args = makePacketArgs(planPath, "U2");
    const env = await handler.run(args);

    expect(env.ok).toBe(true);
    expect(env.outcome).toBe("packet_built");

    const data = env.data as {
      planPath: string;
      unitId: string;
      beadsId: string | null;
      packet: {
        schema_version: string;
        run_id: string | null;
        plan_path: string;
        plan_digest: string;
        unit: { id: string; title: string };
        verification_commands: unknown[];
        beads_id: string | null;
        base_sha: string | null;
        branch: string | null;
        worktree_path: string | null;
        result_file: string | null;
      };
    };

    expect(data.unitId).toBe("U2");
    expect(data.packet.unit.id).toBe("U2");
    expect(data.packet.unit.title).toMatch(/Second unit/i);
    expect(data.packet.schema_version).toBeTruthy();
    expect(data.packet.plan_path).toBeTruthy();
    expect(data.packet.plan_digest).toBeTruthy();
  });

  it("standalone packet: run-context fields are null", async () => {
    const args = makePacketArgs(planPath, "U1");
    const env = await handler.run(args);
    const data = env.data as { packet: { run_id: string | null; base_sha: string | null; branch: string | null; worktree_path: string | null; result_file: string | null } };

    expect(data.packet.run_id).toBeNull();
    expect(data.packet.base_sha).toBeNull();
    expect(data.packet.branch).toBeNull();
    expect(data.packet.worktree_path).toBeNull();
    expect(data.packet.result_file).toBeNull();
  });

  it("beads_id is null when unbound", async () => {
    const args = makePacketArgs(planPath, "U1");
    const env = await handler.run(args);
    const data = env.data as { beadsId: string | null; packet: { beads_id: string | null } };

    expect(data.beadsId).toBeNull();
    expect(data.packet.beads_id).toBeNull();
  });
});

describe("packet: resolves beads_id when bound (T2)", () => {
  let repoDir: string;
  let beadsDir: string;
  let planPath: string;

  beforeEach(() => {
    repoDir = setupGitRepo();
    beadsDir = join(repoDir, ".beads");
    planPath = copyPlan(repoDir, "02-linear-three-unit.md");
    process.chdir(repoDir);
  });
  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  it("packet carries the created Beads task id", async () => {
    // Create a Beads workspace and bind the plan directly.
    process.env.BEADS_DIR = beadsDir;
    const client = new BeadsClient({ beadsDir });
    await client.init({ prefix: "pktt2" });
    const plan = parsePlan(planPath, { repoRoot: repoDir });

    const epic = await client.create({ title: `Plan: ${plan.title}`, type: "epic" });
    await client.update(epic.id, {
      setMetadata: {
        ce_plan_path: plan.path,
        ce_plan_digest: plan.digest,
        ce_plan_title: plan.title,
        integration: "ce-beads/v1",
      },
    });

    // Create tasks with ce_unit_id metadata so enumerateBinding finds them.
    let u2TaskId = "";
    for (const unit of plan.units) {
      const task = await client.create({
        title: `${unit.id}. ${unit.title}`,
        type: "task",
        parent: epic.id,
      });
      await client.update(task.id, {
        setMetadata: {
          ce_unit_id: unit.id,
          ce_plan_path: plan.path,
          integration: "ce-beads/v1",
        },
      });
      if (unit.id === "U2") u2TaskId = task.id;
    }

    // Now call packet for U2.
    const args = makePacketArgs(planPath, "U2");
    const env = await handler.run(args);
    expect(env.ok).toBe(true);

    const data = env.data as { beadsId: string | null; packet: { beads_id: string | null } };
    expect(data.beadsId).not.toBeNull();
    expect(data.beadsId).toBe(u2TaskId);
    expect(data.packet.beads_id).toBe(u2TaskId);
  });
});

describe("packet: unknown unit (T3)", () => {
  let repoDir: string;
  let planPath: string;

  beforeEach(() => {
    repoDir = setupGitRepo();
    planPath = copyPlan(repoDir, "02-linear-three-unit.md");
    process.chdir(repoDir);
    delete process.env.BEADS_DIR;
  });
  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  it("returns unit_not_found with UNIT_NOT_FOUND diagnostic", async () => {
    const args = makePacketArgs(planPath, "U9");
    const env = await handler.run(args);

    expect(env.ok).toBe(false);
    expect(env.outcome).toBe("unit_not_found");
    expect(env.diagnostics.some((d) => d.code === "UNIT_NOT_FOUND")).toBe(true);
  });
});

describe("packet: malformed plan (T4)", () => {
  let repoDir: string;
  let planPath: string;

  beforeEach(() => {
    repoDir = setupGitRepo();
    planPath = copyPlan(repoDir, "10-malformed-frontmatter.md");
    process.chdir(repoDir);
    delete process.env.BEADS_DIR;
  });
  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  it("rejects with PLAN_MALFORMED diagnostic", async () => {
    const args = makePacketArgs(planPath, "U1");
    const env = await handler.run(args);

    expect(env.ok).toBe(false);
    expect(env.diagnostics.some((d) => d.code === "PLAN_MALFORMED")).toBe(true);
  });
});
