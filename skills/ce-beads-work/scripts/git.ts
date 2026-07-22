// git.ts — minimal `git` helpers used by the ce-beads-work engine.
//
// Each helper shells out to the `git` binary via `node:child_process.spawn`
// and resolves with the typed result. We never mutate `process.env` and we
// run with `stdio: ["ignore", "pipe", "pipe"]` so a single helper never
// hangs on a TTY prompt. Errors surface as rejected promises with the full
// argv + stderr attached; callers decide whether the exit code is fatal
// (e.g. merge conflicts) or a successful "no-op" signal.
//
// All paths are absolute filesystem paths. `repoRoot` is the primary
// working tree; `dir` arguments (e.g. worktree paths) are run with their
// own cwd so commands resolve correctly inside a linked worktree.
import { spawn, execFileSync, execSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Result of any successful `git` invocation we bother to capture. */
export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Result of `mergeBranch` — we surface the merge SHA + a conflict flag. */
export interface MergeResult {
  mergeSha: string;
  conflict: boolean;
}

/**
 * Run `git <args>` in `dir`. Returns the captured output. Never throws on a
 * non-zero exit code; callers inspect `exitCode` themselves so they can
 * distinguish "expected non-zero" (e.g. `rev-parse` on a missing ref,
 * merge with conflicts) from "the process is on fire".
 */
export async function runInDir(dir: string, args: string[]): Promise<GitResult> {
  // Use Bun.$ shell to avoid Bun's posix_spawn ENOENT bug that occurs
  // after many process spawns in the same Bun process (Bun 1.3.x).
  // Bun.$ uses a different spawning mechanism that is more resilient.
  try {
    const proc = Bun.$`git ${args}`.cwd(dir).quiet();
    const result = await proc;
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode };
  } catch (e) {
    const err = e as { stdout?: Uint8Array; stderr?: Uint8Array; exitCode?: number; message?: string };
    const stdout = err.stdout?.toString() ?? "";
    const stderr = err.stderr?.toString() ?? err.message ?? (e as Error).message;
    const exitCode = err.exitCode ?? -1;
    return { stdout, stderr, exitCode };
  }
}

/**
 * `git worktree add <path> <branch> <baseSha>` — create a fresh worktree
 * pinned to `baseSha` on a new branch. The parent directory of `path` is
 * created if missing (worktrees frequently live under a not-yet-created
 * `.ce-beads/worktrees/<unit>/`).
 */
export async function worktreeAdd(
  repoRoot: string,
  path: string,
  branch: string,
  baseSha: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const res = await runInDir(repoRoot, [
    "worktree",
    "add",
    path,
    "-b",
    branch,
    baseSha,
  ]);
  if (res.exitCode !== 0) {
    throw new Error(
      `git worktree add ${path} -b ${branch} ${baseSha} exited ${res.exitCode}: ${res.stderr.trim()}`,
    );
  }
}

/** `git worktree remove [--force] <path>`. */
export async function worktreeRemove(
  repoRoot: string,
  path: string,
  force: boolean,
): Promise<void> {
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(path);
  const res = await runInDir(repoRoot, args);
  if (res.exitCode !== 0) {
    throw new Error(
      `git worktree remove ${path} exited ${res.exitCode}: ${res.stderr.trim()}`,
    );
  }
}

/** `git branch (-D|-d) <branch>`. */
export async function branchDelete(
  repoRoot: string,
  branch: string,
  force: boolean,
): Promise<void> {
  const res = await runInDir(repoRoot, [
    "branch",
    force ? "-D" : "-d",
    branch,
  ]);
  if (res.exitCode !== 0) {
    throw new Error(
      `git branch ${force ? "-D" : "-d"} ${branch} exited ${res.exitCode}: ${res.stderr.trim()}`,
    );
  }
}

/**
 * `git merge --no-ff -m <message> <sourceBranch>` while on `targetBranch`.
 *
 * A clean merge returns `{ mergeSha, conflict: false }`. A merge with
 * conflicts returns `{ mergeSha: "", conflict: true }` — we deliberately
 * do NOT throw because the engine treats conflicts as a recoverable
 * outcome that the caller (orchestrator) is responsible for resolving.
 * Any other non-zero exit (e.g. target branch not checked out, source
 * branch missing) is thrown.
 */
export async function mergeBranch(
  repoRoot: string,
  targetBranch: string,
  sourceBranch: string,
  message: string,
): Promise<MergeResult> {
  // Switch to the target branch in the primary working tree.
  const checkout = await runInDir(repoRoot, ["checkout", targetBranch]);
  if (checkout.exitCode !== 0) {
    throw new Error(
      `git checkout ${targetBranch} exited ${checkout.exitCode}: ${checkout.stderr.trim()}`,
    );
  }
  const res = await runInDir(repoRoot, [
    "merge",
    "--no-ff",
    "-m",
    message,
    sourceBranch,
  ]);
  if (res.exitCode === 0) {
    const sha = await revParse(repoRoot, "HEAD");
    return { mergeSha: sha, conflict: false };
  }
  // Conflict: MERGE_HEAD is set and exit code is 1. The working tree is
  // left mid-merge; the orchestrator decides whether to `git merge
  // --abort` or keep the conflict state for the next pass.
  if (res.exitCode === 1 && /CONFLICT|Merge conflict/i.test(res.stderr + res.stdout)) {
    return { mergeSha: "", conflict: true };
  }
  throw new Error(
    `git merge --no-ff -m ${JSON.stringify(message)} ${sourceBranch} exited ${res.exitCode}: ${res.stderr.trim()}`,
  );
}

/** `git diff --stat <base> <head>`. Returns the raw stat output (may be empty). */
export async function diffStat(repoRoot: string, base: string, head: string): Promise<string> {
  const res = await runInDir(repoRoot, ["diff", "--stat", base, head]);
  if (res.exitCode !== 0) {
    throw new Error(
      `git diff --stat ${base} ${head} exited ${res.exitCode}: ${res.stderr.trim()}`,
    );
  }
  return res.stdout;
}

/** `git rev-parse <ref>` — returns the trimmed full SHA. */
export async function revParse(repoRoot: string, ref: string): Promise<string> {
  const res = await runInDir(repoRoot, ["rev-parse", ref]);
  if (res.exitCode !== 0) {
    throw new Error(
      `git rev-parse ${ref} exited ${res.exitCode}: ${res.stderr.trim()}`,
    );
  }
  return res.stdout.trim();
}

/** `git rev-parse --git-common-dir` — absolute path to the shared `.git/`. */
export async function gitCommonDir(repoRoot: string): Promise<string> {
  const res = await runInDir(repoRoot, ["rev-parse", "--git-common-dir"]);
  if (res.exitCode !== 0) {
    throw new Error(
      `git rev-parse --git-common-dir exited ${res.exitCode}: ${res.stderr.trim()}`,
    );
  }
  // `git rev-parse --git-common-dir` may return a relative path (e.g., `.git`)
  // when run in a non-worktree repo. Resolve to absolute so downstream paths
  // (worktree dirs under it) work regardless of the process CWD.
  return resolve(repoRoot, res.stdout.trim());
}

/** `git status --porcelain=v1 -z -uall` — NUL-delimited, machine-friendly.
 * `-uall` is essential: without it git collapses untracked files under a
 * directory into a single `?? dir/` entry, which breaks per-file validation. */
export async function statusPorcelain(repoRoot: string): Promise<string> {
  const res = await runInDir(repoRoot, ["status", "--porcelain=v1", "-z", "-uall"]);
  if (res.exitCode !== 0) {
    throw new Error(
      `git status --porcelain=v1 -z -uall exited ${res.exitCode}: ${res.stderr.trim()}`,
    );
  }
  return res.stdout;
}

/**
 * `git add -- <paths>` — explicit-path add (never `-A`). The `--`
 * separator is non-negotiable: a path that begins with `-` would otherwise
 * be interpreted as a flag.
 */
export async function addPaths(repoRoot: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const res = await runInDir(repoRoot, ["add", "--", ...paths]);
  if (res.exitCode !== 0) {
    throw new Error(
      `git add -- ${paths.join(" ")} exited ${res.exitCode}: ${res.stderr.trim()}`,
    );
  }
}

/** `git commit -m <message>` and return the new commit SHA. */
export async function commit(repoRoot: string, message: string): Promise<string> {
  const res = await runInDir(repoRoot, ["commit", "-m", message]);
  if (res.exitCode !== 0) {
    throw new Error(
      `git commit -m ${JSON.stringify(message)} exited ${res.exitCode}: ${res.stderr.trim()}`,
    );
  }
  return revParse(repoRoot, "HEAD");
}
