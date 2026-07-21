// beads-workspace.ts — test helper for isolated Beads workspaces.
//
// Wraps createIsolatedWorkspace with init + cleanup lifecycle hooks and
// dev-repo isolation assertions. Every integration test uses this helper;
// no test ever touches the development repository's real .beads database.

import { afterEach, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  BeadsClient,
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "../../skills/ce-beads/scripts/beads-client.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

export interface WorkspaceFixture extends IsolatedWorkspace {
  client: BeadsClient;
}

/**
 * Set up an isolated Beads workspace for a test. Initializes with --stealth
 * and registers cleanup. Returns the workspace; the test uses `ws.client`.
 */
export async function setupWorkspace(prefix = "cebeadstest"): Promise<WorkspaceFixture> {
  const ws = createIsolatedWorkspace({ prefix });
  await ws.client.init({ prefix });
  return ws as WorkspaceFixture;
}

/**
 * Snapshot of the dev repo's real .beads + .git/info/exclude state, for
 * before/after isolation assertions.
 */
export interface DevRepoSnapshot {
  beadsFingerprint: string;
  excludeHash: string;
  beadsExists: boolean;
}

/**
 * Snapshot the dev repo's real .beads database fingerprint and
 * `.git/info/exclude` hash, for before/after isolation assertions.
 */
export function snapshotDevRepo(): DevRepoSnapshot {
  const beadsPath = join(REPO_ROOT, ".beads");
  const excludePath = join(REPO_ROOT, ".git", "info", "exclude");
  let beadsFingerprint = "absent";
  let beadsExists = false;
  if (existsSync(beadsPath)) {
    beadsExists = true;
    try {
      const stat = statSync(beadsPath);
      beadsFingerprint = `mtime:${stat.mtimeMs}`;
    } catch {
      beadsFingerprint = "stat-error";
    }
  }
  let excludeHash = "absent";
  if (existsSync(excludePath)) {
    const content = readFileSync(excludePath, "utf8");
    excludeHash = createHash("sha256").update(content).digest("hex");
  }
  return { beadsFingerprint, excludeHash, beadsExists };
}

/**
 * Assert the dev repo's real .beads and .git/info/exclude are unchanged.
 * Call in an afterEach with a snapshot taken in beforeEach.
 */
export function assertDevRepoUnchanged(before: DevRepoSnapshot): void {
  const after = snapshotDevRepo();
  if (after.beadsFingerprint !== before.beadsFingerprint) {
    throw new Error(
      `Dev repo .beads fingerprint changed: ${before.beadsFingerprint} -> ${after.beadsFingerprint}`,
    );
  }
  if (after.excludeHash !== before.excludeHash) {
    throw new Error(
      `Dev repo .git/info/exclude changed: ${before.excludeHash} -> ${after.excludeHash}`,
    );
  }
}

/** Convenience: snapshot before each integration test, assert after. */
export function devRepoIsolationGuards(): { snapshot: () => DevRepoSnapshot } {
  let snap: DevRepoSnapshot;
  beforeEach(() => {
    snap = snapshotDevRepo();
  });
  afterEach(() => {
    assertDevRepoUnchanged(snap);
  });
  return { snapshot: () => snap };
}
