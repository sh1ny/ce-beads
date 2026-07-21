import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { handler } from "../skills/ce-beads-work/scripts/packet.ts";
import type { CliArgs } from "../skills/ce-beads/scripts/cli.ts";
import { BeadsClient } from "../skills/ce-beads/scripts/beads-client.ts";
import { parsePlan } from "../skills/ce-beads/scripts/plan-parser.ts";
import type { VerificationEntry } from "../skills/ce-beads/scripts/plan-parser.ts";
import {
  buildWorkerPacket,
  planSlug,
  PACKET_SCHEMA_VERSION,
} from "../skills/ce-beads-work/scripts/worker-packet.ts";

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

// ---------------------------------------------------------------------------
// buildWorkerPacket + planSlug (worker-packet.ts) — unit-level coverage
// ---------------------------------------------------------------------------

describe("buildWorkerPacket", () => {
  const REPO_ROOT = join(import.meta.dir, "..");
  const FIXTURES = join(import.meta.dir, "fixtures", "plans");
  const plan = parsePlan(join(FIXTURES, "02-linear-three-unit.md"), { repoRoot: REPO_ROOT });
  const u1 = plan.units.find((u) => u.id === "U1")!;
  const u2 = plan.units.find((u) => u.id === "U2")!;

  it("standalone packet: schema_version, run_id=null, all run-context fields null", () => {
    const packet = buildWorkerPacket(plan, u1, plan.verification_commands);

    expect(packet.schema_version).toBe(PACKET_SCHEMA_VERSION);
    expect(packet.schema_version).toBe("ce-beads-packet/1");
    expect(packet.run_id).toBeNull();
    expect(packet.beads_id).toBeNull();
    expect(packet.base_sha).toBeNull();
    expect(packet.branch).toBeNull();
    expect(packet.worktree_path).toBeNull();
    expect(packet.result_file).toBeNull();
  });

  it("live packet: opts set run-context fields, result_file derived from worktreePath", () => {
    const packet = buildWorkerPacket(plan, u1, plan.verification_commands, {
      runId: "run-abc",
      beadsId: "bead-xyz",
      baseSha: "abc123def456",
      branch: "feat/my-unit",
      worktreePath: "/tmp/worktrees/my-unit",
    });

    expect(packet.run_id).toBe("run-abc");
    expect(packet.beads_id).toBe("bead-xyz");
    expect(packet.base_sha).toBe("abc123def456");
    expect(packet.branch).toBe("feat/my-unit");
    expect(packet.worktree_path).toBe("/tmp/worktrees/my-unit");
    expect(packet.result_file).toBe("/tmp/worktrees/my-unit/.ce-beads-worker/result.json");
  });

  it("PacketUnit has correct fields from CeUnit", () => {
    const packet = buildWorkerPacket(plan, u1, plan.verification_commands);
    const pu = packet.unit;

    expect(pu.id).toBe("U1");
    expect(pu.title).toBe("First unit");
    expect(pu.goal).toBe("Be the root of the chain.");
    expect(pu.requirements).toEqual(["R1"]);
    expect(pu.dependencies).toEqual([]);
    expect(pu.files).toEqual(["src/u1.ts"]);
    expect(pu.approach).toBe("Implement unit one.");
    expect(pu.patterns).toEqual(["Linear ordering."]);
    expect(pu.test_scenarios).toEqual(["U1 is ready first."]);
    expect(pu.verification).toEqual(["U1 parses."]);
    expect(pu.execution_note).toBeUndefined();
    expect(pu.technical_design).toBeUndefined();
  });

  it("verification_commands reflect the passed-in filtered list", () => {
    const u1Cmds: VerificationEntry[] = [{ unit_id: "U1", command: "bun test" }];
    const u2Cmds: VerificationEntry[] = [{ unit_id: "U2", command: "bun test:unit2" }];

    const p1 = buildWorkerPacket(plan, u1, u1Cmds);
    expect(p1.verification_commands).toHaveLength(1);
    expect(p1.verification_commands[0]!.unit_id).toBe("U1");
    expect(p1.verification_commands[0]!.command).toBe("bun test");

    const p2 = buildWorkerPacket(plan, u2, u2Cmds);
    expect(p2.verification_commands).toHaveLength(1);
    expect(p2.verification_commands[0]!.unit_id).toBe("U2");
    expect(p2.verification_commands[0]!.command).toBe("bun test:unit2");
  });

  it("requirement_defs are filtered to the unit's requirements (R-IDs)", () => {
    const packet = buildWorkerPacket(plan, u1, plan.verification_commands);

    expect(packet.unit.requirement_defs).toHaveLength(1);
    expect(packet.unit.requirement_defs[0]!.id).toBe("R1");
    expect(packet.unit.requirement_defs[0]!.text).toBe("Unit one.");
  });
});

describe("planSlug", () => {
  it("produces a kebab-case slug from the plan path", () => {
    expect(planSlug("plans/02-Linear-Three-Unit.md")).toBe("02-linear-three-unit");
    expect(planSlug("/abs/path/MyPlan.MD")).toBe("myplan");
    expect(planSlug("relative/path/to/My-Cool_Plan.md")).toBe("my-cool-plan");
    expect(planSlug("simple.md")).toBe("simple");
    expect(planSlug("__UPPER__Path__.md")).toBe("upper-path");
  });
});
