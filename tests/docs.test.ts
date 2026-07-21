import { describe, expect, it } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = join(import.meta.dir, "..");
const README = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
const ACCEPTANCE = readFileSync(join(REPO_ROOT, "docs/acceptance.md"), "utf8");
const SKILL = readFileSync(join(REPO_ROOT, "skills/ce-beads/SKILL.md"), "utf8");

describe("docs: completeness", () => {
  it("docs name each of the four actions", () => {
    for (const action of ["doctor", "bind", "status", "sync"]) {
      expect(README).toContain(action);
      expect(SKILL).toContain(action);
    }
  });

  it("docs name the rejection list", () => {
    const rejectionTerms = ["requirements-only", "knowledge-work", "HTML"];
    for (const term of rejectionTerms) {
      expect(README.toLowerCase()).toContain(term.toLowerCase());
    }
  });

  it("docs name the pinned versions", () => {
    expect(README).toContain("1.1.0");
    expect(README).toContain("1.3.14");
    expect(README).toContain("17.0.5");
  });

  it("SKILL.md frontmatter parses and includes a non-empty description", () => {
    expect(SKILL.startsWith("---")).toBe(true);
    const end = SKILL.indexOf("\n---", 3);
    expect(end).toBeGreaterThan(-1);
    const frontmatter = SKILL.slice(3, end);
    expect(frontmatter).toContain("name: ce-beads");
    expect(frontmatter).toContain("description:");
    // Description is non-empty.
    const descMatch = frontmatter.match(/description:\s*"(.+)"/s);
    expect(descMatch).not.toBeNull();
    expect(descMatch![1]!.length).toBeGreaterThan(10);
  });

  it("every script path referenced in SKILL.md exists under the skill directory", () => {
    const scriptRefs = SKILL.match(/\$SKILL_DIR\/([\w./-]+)/g) ?? [];
    for (const ref of scriptRefs) {
      const rel = ref.replace("$SKILL_DIR/", "");
      const path = join(REPO_ROOT, "skills/ce-beads", rel);
      expect(existsSync(path)).toBe(true);
    }
    // The captured set must include the CLI entry point.
    expect(scriptRefs.some((r) => r.endsWith("scripts/cli.ts"))).toBe(true);
  });

  it("mapping.md names every metadata key the builder emits", () => {
    const mapping = readFileSync(join(REPO_ROOT, "skills/ce-beads/references/mapping.md"), "utf8");
    const requiredKeys = [
      "integration", "ce_plan_path", "ce_plan_digest", "ce_artifact_contract",
      "ce_unit_ids", "ce_unit_id", "ce_unit_digest", "ce_requirements", "ce_dependencies",
    ];
    for (const key of requiredKeys) {
      expect(mapping).toContain(key);
    }
  });

  it("reconciliation.md names every drift class and blocking state", () => {
    const recon = readFileSync(join(REPO_ROOT, "skills/ce-beads/references/reconciliation.md"), "utf8");
    const driftClasses = [
      "unchanged", "new-in-plan", "missing-in-beads", "content-changed",
      "dependencies-changed", "removed-from-plan", "closed-but-changed",
      "duplicate-binding", "corrupt-binding", "externally-modified",
      "dependency-baseline-corrupt", "digest-drift",
    ];
    for (const cls of driftClasses) {
      expect(recon).toContain(cls);
    }
  });

  it("acceptance.md names the launch command, prompt, and isolated workspace", () => {
    expect(ACCEPTANCE).toContain("omp --profile ce-beads-plugin-test");
    expect(ACCEPTANCE).toContain("--no-skills");
    expect(ACCEPTANCE).toContain("doctor");
    expect(ACCEPTANCE).toContain("bind");
    // Isolated disposable workspace — reruns must not delete prior bindings.
    expect(ACCEPTANCE).toContain("BEADS_DIR");
    expect(ACCEPTANCE).toContain("mktemp -d");
    expect(ACCEPTANCE).toContain("disposable");
    // Approval-flow boundary: human turn between preview and apply.
    expect(ACCEPTANCE).toContain("STOP");
    expect(ACCEPTANCE).toContain("Do not approve");
    expect(ACCEPTANCE).toContain("user's behalf");
    expect(ACCEPTANCE).toContain("wait for explicit human approval");
    expect(ACCEPTANCE).toContain("Do not rerun");
    expect(ACCEPTANCE).toContain("different token");
    expect(ACCEPTANCE).toContain("exact token from the displayed preview");
    // Recorded acceptance result must be present.
    expect(ACCEPTANCE).toContain("Recorded acceptance result");
    expect(ACCEPTANCE).toContain("PASS");
  });

  it("SKILL.md enforces the approval-flow boundary and token preservation", () => {
    // The initial request to bind is not approval to apply.
    expect(SKILL).toContain("approval to apply");
    // Must STOP after preview — no continuing to --apply in the same turn.
    expect(SKILL).toContain("STOP");
    expect(SKILL).toContain("same turn");
    // Never approve on the user's behalf.
    expect(SKILL).toContain("Never approve on the user's behalf");
    // Preserve the exact token — never rerun to capture a token.
    expect(SKILL).toContain("Preserve the exact token");
    expect(SKILL).toContain("Never rerun");
    // Token recomputation produces a different token (bold markdown splits the word).
    expect(SKILL).toMatch(/new.*preview.*different.*token/);
    // Explicit human approval required.
    expect(SKILL).toContain("explicit human approval");
  });
});

describe("docs: smoke test", () => {
  it("doctor --help exits zero", () => {
    const result = spawnSync("bun", [
      join(REPO_ROOT, "skills/ce-beads/scripts/cli.ts"),
      "doctor",
      "--help",
    ], { cwd: REPO_ROOT, timeout: 10000 });
    expect(result.status).toBe(0);
  });

  it("cli.ts with no args shows usage", () => {
    const result = spawnSync("bun", [
      join(REPO_ROOT, "skills/ce-beads/scripts/cli.ts"),
    ], { cwd: REPO_ROOT, timeout: 10000, encoding: "utf8" });
    // No args → help=true → exit 0.
    expect(result.status).toBe(0);
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    expect(output).toContain("ce-beads");
  });
});

// Published-file hygiene: no local home paths, absolute binary paths, or
// credentials may enter files that would be published to a public repository.
// `docs/local-environment.md` is gitignored and explicitly excluded — it is
// the only sanctioned place for machine-specific paths.
describe("docs: published-file hygiene", () => {
  const EXCLUDED_DIRS = new Set([".git", "node_modules", "upstream", ".beads", "tmp"]);
  const EXCLUDED_FILES = new Set(["docs/local-environment.md", "tests/docs.test.ts", "tests/packaging.test.ts"]);
  const isExcluded = (rel: string): boolean => {
    if (EXCLUDED_FILES.has(rel)) return true;
    const parts = rel.split("/");
    if (parts.some((p) => EXCLUDED_DIRS.has(p))) return true;
    // Vim swap files and temp artifacts.
    if (/\.[^/]+\.sw[a-z]+$/.test(rel)) return true;
    if (rel.endsWith(".tmp")) return true;
    return false;
  };

  function collectFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = full.replace(REPO_ROOT + "/", "");
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        collectFiles(full, acc);
      } else {
        if (isExcluded(rel)) continue;
        acc.push(rel);
      }
    }
    return acc;
  }

  // Forbidden patterns in published files. Home-directory roots (POSIX and
  // Windows), absolute binary install paths, and credential markers.
  const FORBIDDEN: { name: string; re: RegExp }[] = [
    { name: "POSIX home path (/home/<user>)", re: /\/home\/[^/]+(\/|$)/ },
    { name: "macOS home path (/Users/<user>)", re: /\/Users\/[^/]+(\/|$)/ },
    { name: "Windows home path (C:\\Users\\)", re: /C:\\\\?Users\\\\?/i },
    { name: "mise install path", re: /\.local\/share\/mise\/installs\// },
    { name: ".bun/bin path", re: /\.bun\/bin\// },
    { name: "/usr/bin binary path", re: /\/usr\/bin\/(?!env[\s\/])/ },
    { name: "generic absolute binary_path", re: /"binary_path"\s*:/ },
    { name: "generic absolute path field", re: /"absolute_path"\s*:/ },
    { name: "API key / token assignment", re: /\b(api[_-]?key|secret|password|access[_-]?token)\s*[:=]\s*['"][^'"]{8,}/i },
    { name: "Bearer token literal", re: /Bearer\s+[A-Za-z0-9._-]{16,}/ },
  ];

  it("no published file contains a local home path or credential", () => {
    const files = collectFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const rel of files) {
      const content = readFileSync(join(REPO_ROOT, rel), "utf8");
      for (const { name, re } of FORBIDDEN) {
        const m = content.match(re);
        if (m) offenders.push(`${rel}: ${name} -> ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("UPSTREAMS.lock.json contains no absolute or machine-specific paths", () => {
    const lock = readFileSync(join(REPO_ROOT, "UPSTREAMS.lock.json"), "utf8");
    expect(lock).not.toContain("/home/");
    expect(lock).not.toContain("/Users/");
    expect(lock).not.toContain("C:\\Users");
    // Forbid machine-specific JSON keys (never prose words). Match `"key":`
    // so the word "database" in descriptive prose is not a false positive.
    expect(lock).not.toContain('"binary_path":');
    expect(lock).not.toContain('"database":');
    expect(lock).not.toContain('"issue_prefix":');
    expect(lock).not.toContain('"workspace_path":');
    expect(lock).not.toContain('"backend":');
    // Provenance clarity is present.
    expect(lock).toContain('"runtime_required":');
    expect(lock).toContain("Implementation provenance");
  });
});
