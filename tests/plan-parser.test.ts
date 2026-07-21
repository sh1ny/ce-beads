import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parsePlan,
  PlanParseError,
  computePlanDigest,
  resolvePlanPath,
} from "../.omp/skills/ce-beads/scripts/plan-parser.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "plans");
const REPO_ROOT = join(import.meta.dir, "..");

function fixture(name: string): string {
  return join(FIXTURES, name);
}

describe("plan-parser: happy paths", () => {
  it("minimal valid fixture parses into one unit with all required fields populated", () => {
    const plan = parsePlan(fixture("01-minimal-valid.md"), { repoRoot: REPO_ROOT });
    expect(plan.units).toHaveLength(1);
    const u1 = plan.units[0]!;
    expect(u1.id).toBe("U1");
    expect(u1.title).toBe("Do the thing");
    expect(u1.goal).toBe("Produce a parseable minimal unit.");
    expect(u1.requirements).toEqual(["R1"]);
    expect(u1.dependencies).toEqual([]);
    expect(u1.files).toEqual(["src/thing.ts"]);
    expect(u1.approach).toBe("Implement the thing.");
    expect(u1.patterns).toEqual(["Keep it minimal."]);
    expect(u1.testScenarios).toEqual(["Parses into one unit."]);
    expect(u1.verification).toEqual(["The fixture parses."]);
    expect(u1.executionNote).toBeUndefined();
    expect(u1.technicalDesign).toBeUndefined();
    expect(plan.artifactContract).toBe("ce-unified-plan/v1");
    expect(plan.readiness).toBe("implementation-ready");
    expect(plan.execution).toBe("code");
    expect(plan.title).toBe("feat: Minimal valid plan");
    expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("three-unit linear fixture parses with dependency edges U2->U1, U3->U2", () => {
    const plan = parsePlan(fixture("02-linear-three-unit.md"), { repoRoot: REPO_ROOT });
    expect(plan.units).toHaveLength(3);
    const [u1, u2, u3] = plan.units;
    expect(u1!.id).toBe("U1");
    expect(u1!.dependencies).toEqual([]);
    expect(u2!.id).toBe("U2");
    expect(u2!.dependencies).toEqual(["U1"]);
    expect(u3!.id).toBe("U3");
    expect(u3!.dependencies).toEqual(["U2"]);
  });

  it("parallel-units fixture produces zero edges between independent units", () => {
    const plan = parsePlan(fixture("03-parallel-units.md"), { repoRoot: REPO_ROOT });
    expect(plan.units).toHaveLength(2);
    for (const u of plan.units) {
      expect(u.dependencies).toEqual([]);
    }
  });

  it("optional fields (Execution note, Technical design) parse when present", () => {
    const plan = parsePlan(fixture("04-optional-fields.md"), { repoRoot: REPO_ROOT });
    const u1 = plan.units[0]!;
    expect(u1.executionNote).toBe("Start with the failing test for optional field presence.");
    expect(u1.technicalDesign).toBe("Use a discriminated union for optionality.");
  });

  it("optional fields are absent (not empty strings) when omitted", () => {
    const plan = parsePlan(fixture("01-minimal-valid.md"), { repoRoot: REPO_ROOT });
    const u1 = plan.units[0]!;
    expect(u1.executionNote).toBeUndefined();
    expect(u1.technicalDesign).toBeUndefined();
  });

  it("plan digest is sha256 over raw plan file bytes", () => {
    const raw = readFileSync(fixture("01-minimal-valid.md"), "utf8");
    const plan = parsePlan(fixture("01-minimal-valid.md"), { repoRoot: REPO_ROOT });
    expect(plan.digest).toBe(computePlanDigest(raw));
  });

  it("canonical repo-relative path uses forward slashes", () => {
    const plan = parsePlan(fixture("01-minimal-valid.md"), { repoRoot: REPO_ROOT });
    expect(plan.path).toBe("tests/fixtures/plans/01-minimal-valid.md");
  });
});

describe("plan-parser: rejections", () => {
  it("requirements-only fixture rejected with a contract error before any Beads call", () => {
    try {
      parsePlan(fixture("05-requirements-only.md"), { repoRoot: REPO_ROOT });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PlanParseError);
      expect((e as PlanParseError).code).toBe("PLAN_UNSUPPORTED");
    }
  });

  it("knowledge-work fixture (execution: knowledge-work) rejected", () => {
    try {
      parsePlan(fixture("06-knowledge-work.md"), { repoRoot: REPO_ROOT });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PlanParseError);
      expect((e as PlanParseError).code).toBe("PLAN_UNSUPPORTED");
    }
  });

  it("duplicate U-ID fixture rejected naming the duplicated ID", () => {
    try {
      parsePlan(fixture("07-duplicate-uid.md"), { repoRoot: REPO_ROOT });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PlanParseError);
      expect((e as PlanParseError).code).toBe("DUPLICATE_UNIT_ID");
      expect((e as Error).message).toContain("U1");
    }
  });

  it("missing dependency target rejected naming the dangling reference", () => {
    try {
      parsePlan(fixture("08-dangling-dependency.md"), { repoRoot: REPO_ROOT });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PlanParseError);
      expect((e as PlanParseError).code).toBe("DANGLING_DEPENDENCY");
      expect((e as Error).message).toContain("U9");
    }
  });

  it("cyclic dependency fixture rejected with the cycle reported", () => {
    try {
      parsePlan(fixture("09-cyclic-dependencies.md"), { repoRoot: REPO_ROOT });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PlanParseError);
      expect((e as PlanParseError).code).toBe("DEPENDENCY_CYCLE");
      const msg = (e as Error).message;
      expect(msg).toContain("U1");
      expect(msg).toContain("U2");
    }
  });

  it("malformed frontmatter rejected with a frontmatter error", () => {
    try {
      parsePlan(fixture("10-malformed-frontmatter.md"), { repoRoot: REPO_ROOT });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PlanParseError);
      const code = (e as PlanParseError).code;
      // Malformed frontmatter (unterminated / broken key:value) surfaces as
      // FRONTMATTER_MALFORMED or PLAN_UNSUPPORTED (no frontmatter detected).
      expect(["FRONTMATTER_MALFORMED", "PLAN_UNSUPPORTED", "PLAN_MALFORMED"]).toContain(code);
    }
  });

  it("HTML fixture rejected explicitly (extension and/or missing frontmatter contract)", () => {
    try {
      parsePlan(fixture("11-html-plan.html"), { repoRoot: REPO_ROOT });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PlanParseError);
      const code = (e as PlanParseError).code;
      expect(["PLAN_UNSUPPORTED", "PLAN_MALFORMED"]).toContain(code);
    }
  });

  it("a unit missing **Test scenarios:** rejected as missing required field", () => {
    try {
      parsePlan(fixture("12-missing-required-field.md"), { repoRoot: REPO_ROOT });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PlanParseError);
      expect((e as PlanParseError).code).toBe("MISSING_REQUIRED_FIELD");
      expect((e as Error).message).toContain("Test scenarios");
    }
  });

  it("unsupported artifact contract rejected", () => {
    try {
      parsePlan(fixture("13-unsupported-contract.md"), { repoRoot: REPO_ROOT });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PlanParseError);
      expect((e as PlanParseError).code).toBe("PLAN_UNSUPPORTED");
    }
  });

  it("plan path resolving outside the repository rejected", () => {
    // Resolve a path that escapes the repo root via `..` to an existing file.
    try {
      resolvePlanPath("../../../../etc/hostname", REPO_ROOT);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PlanParseError);
      expect((e as PlanParseError).code).toBe("PATH_OUTSIDE_REPO");
    }
  });
});

describe("plan-parser: revised fixtures parse (for U6/U7)", () => {
  it("revised add-U4 fixture parses with four units and U4->U3", () => {
    const plan = parsePlan(fixture("14-revised-add-u4.md"), { repoRoot: REPO_ROOT });
    expect(plan.units).toHaveLength(4);
    const u4 = plan.units.find((u) => u.id === "U4")!;
    expect(u4.dependencies).toEqual(["U3"]);
  });

  it("revised change-U2 fixture parses with changed U2 content", () => {
    const plan = parsePlan(fixture("15-revised-change-u2.md"), { repoRoot: REPO_ROOT });
    const u2 = plan.units.find((u) => u.id === "U2")!;
    expect(u2.goal).toContain("revised");
  });

  it("revised remove-U2 fixture parses with U2 absent and U3->U1", () => {
    const plan = parsePlan(fixture("16-revised-remove-u2.md"), { repoRoot: REPO_ROOT });
    expect(plan.units.find((u) => u.id === "U2")).toBeUndefined();
    const u3 = plan.units.find((u) => u.id === "U3")!;
    expect(u3.dependencies).toEqual(["U1"]);
  });
});
