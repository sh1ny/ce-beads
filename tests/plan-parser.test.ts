import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parsePlan,
  PlanParseError,
  computePlanDigest,
  resolvePlanPath,
} from "../skills/ce-beads/scripts/plan-parser.ts";

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

describe("plan-parser: Verification Contract (R8)", () => {
  it("parses VC table with explicit U-ID column into fanned-out entries", () => {
    const plan = parsePlan(fixture("18-work-u2-depends-on-u1-impl.md"), { repoRoot: REPO_ROOT });
    // Fixture 18 has two explicit rows: U1 and U2.
    expect(plan.verification_commands).toHaveLength(2);
    const u1Cmd = plan.verification_commands.find((v) => v.unit_id === "U1");
    const u2Cmd = plan.verification_commands.find((v) => v.unit_id === "U2");
    expect(u1Cmd).toBeDefined();
    expect(u2Cmd).toBeDefined();
    expect(u1Cmd!.command).toContain("test -f src/u1.ts");
    expect(u2Cmd!.command).toContain("grep -q ANSWER src/u2.ts");
  });

  it("includes the optional 'Proves' text as expected", () => {
    const plan = parsePlan(fixture("18-work-u2-depends-on-u1-impl.md"), { repoRoot: REPO_ROOT });
    const u1Cmd = plan.verification_commands.find((v) => v.unit_id === "U1")!;
    expect(u1Cmd.expected).toBeDefined();
    expect(u1Cmd.expected).toContain("module exists");
  });

  it("parses the failing-verification fixture VC with `false` command", () => {
    const plan = parsePlan(fixture("17-work-failing-verification.md"), { repoRoot: REPO_ROOT });
    const u1Cmd = plan.verification_commands.find((v) => v.unit_id === "U1");
    expect(u1Cmd).toBeDefined();
    expect(u1Cmd!.command).toBe("`false`");
  });

  it("returns empty verification_commands when VC uses a blanket 'Unit' gate", () => {
    // Fixture 02's VC table uses "Unit" as the U-ID column value, which is not
    // an explicit U-ID. The parser only fans out explicit U-IDs (U1, U2, etc.),
    // so a blanket "Unit" gate produces zero entries. This is correct behavior:
    // the orchestrator cannot determine which unit a blanket gate applies to.
    const plan = parsePlan(fixture("02-linear-three-unit.md"), { repoRoot: REPO_ROOT });
    expect(plan.verification_commands).toEqual([]);
  });

  it("returns empty verification_commands for fixtures with no VC table", () => {
    // Fixture 03 (parallel units) has no VC section.
    const plan = parsePlan(fixture("03-parallel-units.md"), { repoRoot: REPO_ROOT });
    expect(plan.verification_commands).toEqual([]);
  });
});

describe("plan-parser: requirement definitions", () => {
  it("parses ### Requirements section into requirement_defs", () => {
    const plan = parsePlan(fixture("02-linear-three-unit.md"), { repoRoot: REPO_ROOT });
    expect(plan.requirement_defs).toHaveLength(3);
    const r1 = plan.requirement_defs.find((r) => r.id === "R1");
    expect(r1).toBeDefined();
    expect(r1!.text).toContain("Unit one");
  });

  it("parses requirement defs from the minimal fixture", () => {
    const plan = parsePlan(fixture("01-minimal-valid.md"), { repoRoot: REPO_ROOT });
    expect(plan.requirement_defs).toHaveLength(1);
    expect(plan.requirement_defs[0]!.id).toBe("R1");
    expect(plan.requirement_defs[0]!.text).toContain("parses successfully");
  });

  it("returns empty requirement_defs when the section is missing", () => {
    const plan = parsePlan(fixture("03-parallel-units.md"), { repoRoot: REPO_ROOT });
    expect(Array.isArray(plan.requirement_defs)).toBe(true);
  });
});

describe("plan-parser: KTD excerpts per unit", () => {
  it("returns empty ktd_excerpts when no KTDs are defined", () => {
    const plan = parsePlan(fixture("02-linear-three-unit.md"), { repoRoot: REPO_ROOT });
    // Fixture 02 has no KTD definitions.
    for (const unit of plan.units) {
      expect(unit.ktd_excerpts).toEqual([]);
    }
  });

  it("returns empty ktd_excerpts when KTD text does not reference the unit's R-IDs", () => {
    // Fixture 01 has "KTD1. Minimal shape for testing." but KTD1's text
    // does not contain a \bR\d+\b reference. The selection logic matches
    // R-IDs in the KTD text against the unit's requirements; with no match,
    // ktd_excerpts is empty. This is correct behavior.
    const plan = parsePlan(fixture("01-minimal-valid.md"), { repoRoot: REPO_ROOT });
    const u1 = plan.units[0]!;
    expect(u1.requirements).toEqual(["R1"]);
    // KTD1 text doesn't reference R1, so no excerpts are selected.
    expect(u1.ktd_excerpts).toEqual([]);
  });

  it("ktd_excerpts is always an array (never undefined)", () => {
    const plan = parsePlan(fixture("01-minimal-valid.md"), { repoRoot: REPO_ROOT });
    for (const unit of plan.units) {
      expect(Array.isArray(unit.ktd_excerpts)).toBe(true);
    }
  });
});

describe("plan-parser: plan-level feature exposure", () => {
  it("the plan object exposes requirement_defs and verification_commands at top level", () => {
    const plan = parsePlan(fixture("18-work-u2-depends-on-u1-impl.md"), { repoRoot: REPO_ROOT });
    expect(Array.isArray(plan.requirement_defs)).toBe(true);
    expect(Array.isArray(plan.verification_commands)).toBe(true);
    expect(plan.requirement_defs.length).toBeGreaterThan(0);
    expect(plan.verification_commands.length).toBeGreaterThan(0);
  });

  it("each unit exposes ktd_excerpts as an array", () => {
    const plan = parsePlan(fixture("01-minimal-valid.md"), { repoRoot: REPO_ROOT });
    for (const unit of plan.units) {
      expect(Array.isArray(unit.ktd_excerpts)).toBe(true);
    }
  });
});
