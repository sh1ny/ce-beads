// run-state.test.ts — unit tests for the run-state persistence module.
//
// Tests atomic round-trip save/load (T5), corrupt/missing error codes (T6),
// findActiveRunForPlan ownership semantics (T7), and the R10 invariant that
// run state lives under $GIT_DIR/ce-beads/, not in the consumer working tree (T8).

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  RUN_STATE_SCHEMA_VERSION,
  newRunId,
  runStateDir,
  runStatePath,
  saveRunState,
  loadRunState,
  listRunIds,
  latestRunId,
  findActiveRunForPlan,
  RunStateError,
  type RunState,
  type RunUnitRecord,
  type RunStatus,
  type UnitRunState,
} from "../skills/ce-beads-work/scripts/run-state.ts";

function setupGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ce-beads-rs-"));
  execSync('git init', { cwd: dir });
  execSync('git config user.email "t@t.com"', { cwd: dir });
  execSync('git config user.name "T"', { cwd: dir });
  execSync('git config commit.gpgsign false', { cwd: dir });
  execSync('echo "# test" > README.md', { cwd: dir });
  execSync('git add README.md && git commit -m init', { cwd: dir });
  return dir;
}

/** Build a synthetic RunState with all fields populated for round-trip tests. */
function makeFullRunState(
  repoDir: string,
  planPath: string,
  status: RunStatus,
  unitState: UnitRunState,
  runIdOverride?: string,
): RunState {
  const runId = runIdOverride ?? newRunId();
  return {
    schema_version: RUN_STATE_SCHEMA_VERSION,
    run_id: runId,
    plan_path: planPath,
    plan_digest: "sha256:abcdef1234567890",
    base_sha: "abc123def456789",
    integration_branch: `ce-beads/${runId}`,
    integration_worktree: join(repoDir, "wt", runId),
    status,
    started_at: "2026-07-21T08:00:00.000Z",
    finished_at: status === "completed" || status === "failed" || status === "abandoned"
      ? "2026-07-21T09:00:00.000Z"
      : null,
    units: {
      U1: {
        beads_id: "cbt-1",
        state: unitState,
        worker_pane_id: unitState === "pending" ? null : "mock-pane",
        worker_branch: unitState === "pending" ? null : `ce-beads-worker/${runId}/U1`,
        worktree_path: unitState === "pending" ? null : join(repoDir, "wt", runId, "U1"),
        worker_base_sha: unitState === "pending" ? null : "abc123def456789",
        claimed_at: unitState === "pending" ? null : "2026-07-21T08:01:00.000Z",
        worker_commit_sha: unitState === "captured" || unitState === "merged" || unitState === "verified" || unitState === "closed"
          ? "def456abc789"
          : null,
        merge_sha: unitState === "merged" || unitState === "verified" || unitState === "closed"
          ? "ghi789def012"
          : null,
        integrated_sha: unitState === "closed" ? "jkl012ghi345" : null,
        result: unitState === "worker_finished" || unitState === "captured" || unitState === "merged" || unitState === "verified" || unitState === "closed" || unitState === "blocked"
          ? {
              schema_version: "ce-beads-worker-report/1",
              u_id: "U1",
              status: "complete",
              changed_files: ["src/u1.ts"],
              verification_evidence: { commands: ["bun test"], results: "ok" },
              blockers: "",
            }
          : null,
        last_successful_state: unitState === "blocked" ? "claimed" : null,
        blocker_reason: unitState === "blocked" ? "verification failed" : "",
        prompt_lifecycle: unitState === "pending" ? "not_sent" : "sent",
        attempt: 1,
      },
    },
  };
}

describe("run-state: round-trip (T5)", () => {
  let repoDir: string;

  beforeEach(() => { repoDir = setupGitRepo(); });
  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  it("save→load preserves every field", () => {
    const state = makeFullRunState(repoDir, "plan.md", "in_progress", "claimed");
    saveRunState(state, repoDir);

    const loaded = loadRunState(state.run_id, repoDir);
    expect(loaded).toEqual(state);
  });

  it("preserves all unit lifecycle states through round-trip", () => {
    const states: UnitRunState[] = [
      "pending", "claimed", "worker_finished", "captured",
      "merged", "verified", "closed", "blocked",
    ];
    for (const us of states) {
      const state = makeFullRunState(repoDir, `plan-${us}.md`, "in_progress", us);
      saveRunState(state, repoDir);
      const loaded = loadRunState(state.run_id, repoDir);
      expect(loaded.units.U1!.state).toBe(us);
    }
  });

  it("atomic rename leaves no tmp file", () => {
    const state = makeFullRunState(repoDir, "plan.md", "in_progress", "claimed");
    saveRunState(state, repoDir);

    const dir = runStateDir(repoDir);
    const files = readdirSync(dir);
    // Only the final run-<id>.json should exist; no .tmp files.
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`run-${state.run_id}.json`);
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
  });

  it("enforces the schema_version on save", () => {
    const state = makeFullRunState(repoDir, "plan.md", "in_progress", "claimed");
    saveRunState(state, repoDir);
    const loaded = loadRunState(state.run_id, repoDir);
    expect(loaded.schema_version).toBe(RUN_STATE_SCHEMA_VERSION);
  });
});

describe("run-state: corrupt / missing (T6)", () => {
  let repoDir: string;

  beforeEach(() => { repoDir = setupGitRepo(); });
  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  it("loadRunState throws RUN_STATE_CORRUPT on invalid JSON", () => {
    const state = makeFullRunState(repoDir, "plan.md", "in_progress", "claimed");
    saveRunState(state, repoDir);

    // Corrupt the file.
    const path = runStatePath(state.run_id, repoDir);
    writeFileSync(path, "{ this is not valid JSON", "utf8");

    expect(() => loadRunState(state.run_id, repoDir)).toThrow(RunStateError);
    try {
      loadRunState(state.run_id, repoDir);
    } catch (e) {
      expect((e as RunStateError).code).toBe("RUN_STATE_CORRUPT");
    }
  });

  it("loadRunState throws RUN_NOT_FOUND for a non-existent run", () => {
    expect(() => loadRunState("nonexistent-run-id", repoDir)).toThrow(RunStateError);
    try {
      loadRunState("nonexistent-run-id", repoDir);
    } catch (e) {
      expect((e as RunStateError).code).toBe("RUN_NOT_FOUND");
    }
  });

  it("RUN_STATE_CORRUPT and RUN_NOT_FOUND are distinguishable", () => {
    const state = makeFullRunState(repoDir, "plan.md", "in_progress", "claimed");
    saveRunState(state, repoDir);
    const path = runStatePath(state.run_id, repoDir);
    writeFileSync(path, "garbage", "utf8");

    let corruptCode: string | null = null;
    try { loadRunState(state.run_id, repoDir); } catch (e) { corruptCode = (e as RunStateError).code; }

    let notFoundCode: string | null = null;
    try { loadRunState("does-not-exist", repoDir); } catch (e) { notFoundCode = (e as RunStateError).code; }

    expect(corruptCode).toBe("RUN_STATE_CORRUPT");
    expect(notFoundCode).toBe("RUN_NOT_FOUND");
    expect(corruptCode).not.toBe(notFoundCode);
  });

  it("loadRunState throws RUN_STATE_CORRUPT on wrong schema_version", () => {
    const state = makeFullRunState(repoDir, "plan.md", "in_progress", "claimed");
    // Save a valid state first (creates the directory), then overwrite with bad schema.
    saveRunState(state, repoDir);
    const bad = { ...state, schema_version: "ce-beads-run/999" };
    const path = runStatePath(state.run_id, repoDir);
    writeFileSync(path, JSON.stringify(bad, null, 2), "utf8");

    expect(() => loadRunState(state.run_id, repoDir)).toThrow(RunStateError);
    try {
      loadRunState(state.run_id, repoDir);
    } catch (e) {
      expect((e as RunStateError).code).toBe("RUN_STATE_CORRUPT");
    }
  });
});

describe("run-state: findActiveRunForPlan (T7)", () => {
  let repoDir: string;

  beforeEach(() => { repoDir = setupGitRepo(); });
  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  it("finds an in_progress run as active (even with all units pending)", () => {
    const state = makeFullRunState(repoDir, "plan.md", "in_progress", "pending");
    saveRunState(state, repoDir);
    const active = findActiveRunForPlan("plan.md", repoDir);
    expect(active).not.toBeNull();
    expect(active!.run_id).toBe(state.run_id);
  });

  it("finds a blocked run with a blocked unit as active", () => {
    const state = makeFullRunState(repoDir, "plan.md", "blocked", "blocked");
    saveRunState(state, repoDir);
    const active = findActiveRunForPlan("plan.md", repoDir);
    expect(active).not.toBeNull();
    expect(active!.run_id).toBe(state.run_id);
  });

  it("finds a failed run with an unfinished (claimed) unit as active", () => {
    const state = makeFullRunState(repoDir, "plan.md", "failed", "claimed");
    saveRunState(state, repoDir);
    const active = findActiveRunForPlan("plan.md", repoDir);
    expect(active).not.toBeNull();
  });

  it("does NOT find a completed run as active", () => {
    const state = makeFullRunState(repoDir, "plan.md", "completed", "closed");
    saveRunState(state, repoDir);
    const active = findActiveRunForPlan("plan.md", repoDir);
    expect(active).toBeNull();
  });

  it("does NOT find a failed run with all units closed as active", () => {
    const state = makeFullRunState(repoDir, "plan.md", "failed", "closed");
    saveRunState(state, repoDir);
    const active = findActiveRunForPlan("plan.md", repoDir);
    expect(active).toBeNull();
  });

  it("does NOT find a run for a different plan path", () => {
    const state = makeFullRunState(repoDir, "plan.md", "in_progress", "claimed");
    saveRunState(state, repoDir);
    const active = findActiveRunForPlan("different-plan.md", repoDir);
    expect(active).toBeNull();
  });

  it("returns the most recent active run when multiple exist", () => {
    // Create two runs; the later one (lexicographically larger ID) should be returned.
    const earlier = makeFullRunState(repoDir, "plan.md", "in_progress", "claimed", "20260101-000000-aaaaaa");
    const later = makeFullRunState(repoDir, "plan.md", "in_progress", "claimed", "20260102-000000-bbbbbb");
    saveRunState(earlier, repoDir);
    saveRunState(later, repoDir);
    const active = findActiveRunForPlan("plan.md", repoDir);
    expect(active).not.toBeNull();
    // findActiveRunForPlan scans newest-first.
    expect(active!.run_id).toBe("20260102-000000-bbbbbb");
  });
});

describe("run-state: R10 location (T8)", () => {
  let repoDir: string;

  beforeEach(() => { repoDir = setupGitRepo(); });
  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  it("run state lives under $GIT_DIR/ce-beads/, not the repo working tree", () => {
    const state = makeFullRunState(repoDir, "plan.md", "in_progress", "claimed");
    saveRunState(state, repoDir);

    const stateDir = runStateDir(repoDir);
    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      cwd: repoDir, encoding: 'utf8',
    }).trim();
    const expectedBase = join(repoDir, gitCommonDir, "ce-beads");

    expect(stateDir).toBe(expectedBase);
    expect(existsSync(stateDir)).toBe(true);
    expect(existsSync(runStatePath(state.run_id, repoDir))).toBe(true);
  });

  it("the consumer repo working tree has no untracked run-state files", () => {
    const state = makeFullRunState(repoDir, "plan.md", "in_progress", "claimed");
    saveRunState(state, repoDir);

    const status = execSync('git status --porcelain', {
      cwd: repoDir, encoding: 'utf8',
    }).trim();
    // The working tree should be clean — run state lives under .git/, not ./
    expect(status).toBe("");
  });

  it("listRunIds and latestRunId read from the git-common-dir location", () => {
    const state1 = makeFullRunState(repoDir, "plan.md", "in_progress", "claimed", "20260101-000000-aaaaaa");
    const state2 = makeFullRunState(repoDir, "plan.md", "in_progress", "claimed", "20260102-000000-bbbbbb");
    saveRunState(state1, repoDir);
    saveRunState(state2, repoDir);

    const ids = listRunIds(repoDir);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("20260101-000000-aaaaaa");
    expect(ids).toContain("20260102-000000-bbbbbb");

    const latest = latestRunId(repoDir);
    expect(latest).toBe("20260102-000000-bbbbbb");
  });
});

describe("run-state: runStateDir and latestRunId edge cases", () => {
  let repoDir: string;

  beforeEach(() => { repoDir = setupGitRepo(); });
  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  it("runStateDir ends with ce-beads and uses GIT_DIR when available", () => {
    const dir = runStateDir(repoDir);
    expect(dir.endsWith("ce-beads")).toBe(true);
  });

  it("latestRunId returns null when no runs exist", () => {
    expect(latestRunId(repoDir)).toBeNull();
  });

  it("listRunIds returns empty array when no runs exist", () => {
    expect(listRunIds(repoDir)).toEqual([]);
  });
});

describe("run-state: newRunId", () => {
  it("produces a sortable timestamped ID with a random suffix", () => {
    const id = newRunId(new Date("2026-07-21T08:14:30.000Z"));
    // Format: YYYYMMDD-HHMMSS-<6 hex chars>
    expect(id).toMatch(/^20260721-081430-[0-9a-f]{6}$/);
  });

  it("rejects an invalid Date", () => {
    expect(() => newRunId(new Date("invalid"))).toThrow(TypeError);
  });

  it("produces unique IDs across calls (random suffix)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(newRunId(new Date("2026-07-21T08:14:30.000Z")));
    }
    // Overwhelmingly likely to be all unique (6 hex chars = 16M space).
    expect(ids.size).toBeGreaterThan(95);
  });
});
