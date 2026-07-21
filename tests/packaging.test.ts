// packaging.test.ts — regression tests for the installable OMP plugin packaging.
//
// Asserts the canonical layout, installable manifest, location-independent
// skill, executable CLI, package-owned lock resolution, consumer-relative
// state, and pack payload. Mirrors conventions from docs.test.ts.

import { describe, expect, it } from "bun:test";
import { readFileSync, existsSync, statSync, mkdtempSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { setupWorkspace } from "./helpers/beads-workspace.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const CLI = join(REPO_ROOT, "skills/ce-beads/scripts/cli.ts");

describe("packaging: manifest", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Record<string, unknown>;

  it("package.json has no private field (installable)", () => {
    expect(pkg.private).toBeUndefined();
  });

  it("package.json name and version", () => {
    expect(pkg.name).toBe("ce-beads");
    expect(pkg.version).toBe("0.1.0");
  });

  it("package.json bin, files, engines, os, keywords, omp deep-equal the step-2c literals", () => {
    expect(pkg.bin).toEqual({ "ce-beads": "skills/ce-beads/scripts/cli.ts" });
    expect(pkg.files).toEqual(["skills/", "README.md", "UPSTREAMS.lock.json"]);
    expect(pkg.engines).toEqual({ bun: ">=1.3.14" });
    expect(pkg.os).toEqual(["linux"]);
    expect(pkg.keywords).toEqual([
      "omp-plugin",
      "agent-skill",
      "compound-engineering",
      "beads",
    ]);
    expect(pkg.omp).toEqual({
      name: "ce-beads",
      description: "Bridge Compound Engineering implementation-ready plans into Beads dependency graphs.",
    });
  });

  it("scripts.verify wiring", () => {
    expect((pkg.scripts as Record<string, string>).verify).toBe("bun run typecheck && bun run test");
  });

  it("devDependencies pinned exactly", () => {
    expect(pkg.devDependencies).toEqual({
      "@types/bun": "1.3.14",
      typescript: "5.9.3",
    });
  });

  it("packageManager pinned", () => {
    expect(pkg.packageManager).toBe("bun@1.3.14");
  });
});

describe("packaging: layout", () => {
  const SCRIPTS = [
    "beads-client", "bind", "cli", "doctor", "graph-builder",
    "plan-parser", "protocol", "reconcile", "status", "sync",
  ];

  it("skill tree exists at the canonical path", () => {
    expect(existsSync(join(REPO_ROOT, "skills/ce-beads/SKILL.md"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "skills/ce-beads/references/mapping.md"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "skills/ce-beads/references/reconciliation.md"))).toBe(true);
    for (const s of SCRIPTS) {
      expect(existsSync(join(REPO_ROOT, `skills/ce-beads/scripts/${s}.ts`))).toBe(true);
    }
  });

  it("the old .omp directory no longer exists", () => {
    expect(existsSync(join(REPO_ROOT, ".omp"))).toBe(false);
  });
});

describe("packaging: no .omp/skills dependency", () => {
  // Walks skills/, tests/ (excluding this file), and top-level published files.
  // docs/acceptance.md is scanned only before its "## Historical evidence" heading.
  const TARGETS: string[] = [];
  const collectDir = (dir: string): string[] => {
    const acc: string[] = [];
    for (const entry of require("node:fs").readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        acc.push(...collectDir(full));
      } else {
        acc.push(full);
      }
    }
    return acc;
  };
  TARGETS.push(...collectDir(join(REPO_ROOT, "skills")));
  TARGETS.push(...collectDir(join(REPO_ROOT, "tests")).filter((f) => !f.endsWith("packaging.test.ts")));
  for (const f of ["README.md", "package.json", "tsconfig.json", "bunfig.toml", "UPSTREAMS.lock.json", ".gitignore"]) {
    TARGETS.push(join(REPO_ROOT, f));
  }

  it("no scanned file references .omp/skills (except the labelled historical section of acceptance.md)", () => {
    let offenders: string[] = [];
    for (const file of TARGETS) {
      const content = readFileSync(file, "utf8");
      if (content.includes(".omp/skills")) {
        offenders.push(file.replace(REPO_ROOT + "/", ""));
      }
    }
    // docs/acceptance.md: scan only the portion before "## Historical evidence".
    const acceptancePath = join(REPO_ROOT, "docs/acceptance.md");
    if (existsSync(acceptancePath)) {
      const acceptance = readFileSync(acceptancePath, "utf8");
      const histIdx = acceptance.indexOf("## Historical evidence");
      const preHist = histIdx >= 0 ? acceptance.slice(0, histIdx) : acceptance;
      if (preHist.includes(".omp/skills")) {
        offenders.push("docs/acceptance.md (pre-historical section)");
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("packaging: SKILL.md location independence", () => {
  const SKILL = readFileSync(join(REPO_ROOT, "skills/ce-beads/SKILL.md"), "utf8");

  it("SKILL.md contains no hardcoded install location", () => {
    const forbidden = ["/home/", "/Users/", "~/.omp", ".omp/plugins", ".omp/agent", ".omp/skills", "$HOME"];
    for (const pat of forbidden) {
      expect(SKILL).not.toContain(pat);
    }
  });

  it("SKILL.md uses $SKILL_DIR for the CLI path", () => {
    expect(SKILL).toContain("$SKILL_DIR/scripts/cli.ts");
  });
});

describe("packaging: cli executable", () => {
  it("cli.ts has a bun shebang on the first line", () => {
    const content = readFileSync(CLI, "utf8");
    const firstLine = content.split("\n")[0]!;
    expect(firstLine).toBe("#!/usr/bin/env bun");
  });

  it("cli.ts is executable", () => {
    const mode = statSync(CLI).mode;
    expect((mode & 0o111) !== 0).toBe(true);
  });
});

describe("packaging: doctor finds package compatibility data from an unrelated cwd", () => {
  it("bd_version check exists when run from a consumer dir (proves package-root lock resolution)", async () => {
    const ws = await setupWorkspace("pkgdoc");
    const consumer = mkdtempSync(join(tmpdir(), "ce-beads-consumer-"));
    const result = spawnSync("bun", [CLI, "doctor", "--json"], {
      cwd: consumer,
      env: { ...process.env, BEADS_DIR: ws.client.beadsDir },
      encoding: "utf8",
      timeout: 30000,
    });
    expect(result.status).toBe(0);
    const env = JSON.parse(result.stdout) as {
      outcome: string;
      data: { checks: Array<{ name: string; status: string }> };
    };
    expect(["healthy", "issues_found"]).toContain(env.outcome);
    const wsCheck = env.data.checks.find((c) => c.name === "workspace_initialized");
    expect(wsCheck?.status).toBe("pass");
    // The load-bearing assertion: bd_version check EXISTS from an unrelated cwd.
    // It is absent entirely when the lock is resolved from cwd.
    const versionCheck = env.data.checks.find((c) => c.name === "bd_version");
    expect(versionCheck).toBeDefined();
    expect(["pass", "warn"]).toContain(versionCheck!.status);
    await ws.cleanup();
  });
});

describe("packaging: consumer-relative state, full bind flow from an unrelated cwd", () => {
  it("bind preview → apply → already_bound all work from a consumer cwd with BEADS_DIR set", async () => {
    const ws = await setupWorkspace("pkgbind");
    const consumer = mkdtempSync(join(tmpdir(), "ce-beads-consumer-"));
    const fixture = join(REPO_ROOT, "tests/fixtures/plans/02-linear-three-unit.md");
    copyFileSync(fixture, join(consumer, "plan.md"));

    const spawnEnv = { ...process.env, BEADS_DIR: ws.client.beadsDir };
    const run = (args: string[]) => spawnSync("bun", [CLI, ...args], {
      cwd: consumer,
      env: spawnEnv,
      encoding: "utf8",
      timeout: 30000,
    });

    // 1. Preview.
    const preview = run(["bind", "plan.md", "--json"]);
    expect(preview.status).toBe(0);
    const previewEnv = JSON.parse(preview.stdout) as { outcome: string; data: { approvalToken: string } };
    expect(previewEnv.outcome).toBe("preview");
    const token = previewEnv.data.approvalToken;
    expect(token).toBeTruthy();

    // 2. Apply.
    const apply = run(["bind", "plan.md", "--json", "--apply", token]);
    expect(apply.status).toBe(0);
    const applyEnv = JSON.parse(apply.stdout) as {
      outcome: string;
      data: { mapping: Record<string, string> };
    };
    expect(applyEnv.outcome).toBe("bound");
    expect(applyEnv.data.mapping["U1"]).toBeTruthy();
    expect(applyEnv.data.mapping["U2"]).toBeTruthy();
    expect(applyEnv.data.mapping["U3"]).toBeTruthy();

    // 3. Idempotent rebind.
    const rebind = run(["bind", "plan.md", "--json"]);
    expect(rebind.status).toBe(0);
    const rebindEnv = JSON.parse(rebind.stdout) as { outcome: string };
    expect(rebindEnv.outcome).toBe("already_bound");

    await ws.cleanup();
  });

  it("doctor fails with environment_unready when BEADS_DIR is unset and no .beads exists (proves workspace lookup follows cwd)", async () => {
    const consumer = mkdtempSync(join(tmpdir(), "ce-beads-consumer-"));
    const env = { ...process.env };
    delete env.BEADS_DIR;
    const result = spawnSync("bun", [CLI, "doctor", "--json"], {
      cwd: consumer,
      env,
      encoding: "utf8",
      timeout: 30000,
    });
    expect(result.status).not.toBe(0);
    const out = JSON.parse(result.stdout) as {
      outcome: string;
      data: { checks: Array<{ name: string; status: string }> };
    };
    expect(out.outcome).toBe("environment_unready");
    const wsCheck = out.data.checks.find((c) => c.name === "workspace_initialized");
    expect(wsCheck?.status).toBe("fail");
  });
});

describe("packaging: pack payload", () => {
  it("bun pm pack --dry-run lists only the published file set", () => {
    const result = spawnSync("bun", ["pm", "pack", "--dry-run", "--ignore-scripts"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30000,
    });
    expect(result.status).toBe(0);
    const packed = new Set<string>();
    for (const line of result.stdout.split("\n")) {
      const m = line.match(/^packed \S+ (.+)$/);
      if (m) packed.add(m[1]!);
    }
    // Must include exactly the published files.
    const required = [
      "package.json",
      "README.md",
      "UPSTREAMS.lock.json",
      "skills/ce-beads/SKILL.md",
      "skills/ce-beads/references/mapping.md",
      "skills/ce-beads/references/reconciliation.md",
      "skills/ce-beads/scripts/beads-client.ts",
      "skills/ce-beads/scripts/bind.ts",
      "skills/ce-beads/scripts/cli.ts",
      "skills/ce-beads/scripts/doctor.ts",
      "skills/ce-beads/scripts/graph-builder.ts",
      "skills/ce-beads/scripts/plan-parser.ts",
      "skills/ce-beads/scripts/protocol.ts",
      "skills/ce-beads/scripts/reconcile.ts",
      "skills/ce-beads/scripts/status.ts",
      "skills/ce-beads/scripts/sync.ts",
    ];
    for (const r of required) {
      expect(packed.has(r)).toBe(true);
    }
    // Must NOT include excluded paths.
    const forbiddenPrefixes = ["tests/", "docs/", "upstream/", ".beads/", "node_modules/"];
    const forbiddenExact = [
      "ce-beads.md", "bun.lock", "bunfig.toml", "tsconfig.json", ".gitignore",
      "docs/local-environment.md",
    ];
    for (const entry of packed) {
      for (const prefix of forbiddenPrefixes) {
        expect(entry.startsWith(prefix)).toBe(false);
      }
      expect(forbiddenExact.includes(entry)).toBe(false);
    }
  });
});
