// worker-report.test.ts — unit tests for worker report schema validation.
//
// Tests strict structural validation (T9-T10) and edge cases that defend
// the schema invariants: status enum, blockers iff blocked, unknown-key
// rejection, and the pane-output sentinel parser.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  WORKER_REPORT_SCHEMA_VERSION,
  WORKER_RESULT_FILE,
  WORKER_RESULT_TEMP,
  WORKER_SYSTEM_PROMPT_FILE,
  validateWorkerReport,
  parseReportFromPaneOutput,
  type WorkerReport,
} from "../skills/ce-beads-work/scripts/worker-report.ts";

const REPORT_FIXTURES = join(import.meta.dir, "fixtures", "worker-reports");

function loadFixture(name: string): string {
  return readFileSync(join(REPORT_FIXTURES, name), "utf8");
}

// A canonical valid report used as a base for mutation in edge-case tests.
const VALID_COMPLETE: WorkerReport = {
  schema_version: WORKER_REPORT_SCHEMA_VERSION,
  u_id: "U1",
  status: "complete",
  changed_files: ["src/u1.ts"],
  verification_evidence: {
    commands: ["bun test"],
    results: "all tests passed",
  },
  blockers: "",
};

const VALID_BLOCKED: WorkerReport = {
  schema_version: WORKER_REPORT_SCHEMA_VERSION,
  u_id: "U2",
  status: "blocked",
  changed_files: [],
  verification_evidence: {
    commands: [],
    results: "could not proceed: missing dependency artifact",
  },
  blockers: "U1's implementation file is not present in the worktree; cannot import.",
};

describe("worker-report: constants", () => {
  it("exports the expected schema version string", () => {
    expect(WORKER_REPORT_SCHEMA_VERSION).toBe("ce-beads-worker-report/1");
  });

  it("exports the expected result-file relative paths", () => {
    expect(WORKER_RESULT_FILE).toBe(".ce-beads-worker/result.json");
    expect(WORKER_RESULT_TEMP).toBe(".ce-beads-worker/.result.tmp");
    expect(WORKER_SYSTEM_PROMPT_FILE).toBe(".ce-beads-worker/system-prompt.md");
  });
});

describe("worker-report: valid reports accepted (T9)", () => {
  it("accepts the valid-complete fixture", () => {
    const raw = JSON.parse(loadFixture("valid-complete.json"));
    const result = validateWorkerReport(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.report;
    expect(report.schema_version).toBe(WORKER_REPORT_SCHEMA_VERSION);
    expect(report.u_id).toBe("U1");
    expect(report.status).toBe("complete");
    expect(report.changed_files).toEqual(["src/u1.ts"]);
    expect(report.verification_evidence.commands).toEqual(["bun test"]);
    expect(report.verification_evidence.results).toBe("all tests passed");
    expect(report.blockers).toBe("");
    expect(report.notes).toBe("Implementation complete.");
  });

  it("accepts the valid-blocked fixture", () => {
    const raw = JSON.parse(loadFixture("valid-blocked.json"));
    const result = validateWorkerReport(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.status).toBe("blocked");
    // blockers invariant: non-empty iff blocked
    expect(result.report.blockers.length).toBeGreaterThan(0);
  });

  it("accepts a valid report with status failed and empty blockers", () => {
    const report = { ...VALID_COMPLETE, status: "failed" as const };
    const result = validateWorkerReport(report);
    expect(result.ok).toBe(true);
  });

  it("blockers invariant: non-empty iff blocked", () => {
    // blocked with empty blockers → invalid
    const blockedEmpty = { ...VALID_BLOCKED, blockers: "" };
    expect(validateWorkerReport(blockedEmpty).ok).toBe(false);

    // complete with non-empty blockers → invalid
    const completeNonEmpty = { ...VALID_COMPLETE, blockers: "something" };
    expect(validateWorkerReport(completeNonEmpty).ok).toBe(false);
  });
});

describe("worker-report: invalid reports rejected (T10)", () => {
  it("rejects the bad-status fixture", () => {
    const raw = JSON.parse(loadFixture("invalid-bad-status.json"));
    const result = validateWorkerReport(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.toLowerCase()).toContain("status");
  });

  it("rejects the missing-fields fixture", () => {
    const raw = JSON.parse(loadFixture("invalid-missing-fields.json"));
    const result = validateWorkerReport(raw);
    expect(result.ok).toBe(false);
  });

  it("rejects raw non-JSON text (passed as string)", () => {
    const raw = loadFixture("invalid-not-json.json");
    // validateWorkerReport receives unknown; a raw string is not an object.
    const result = validateWorkerReport(raw);
    expect(result.ok).toBe(false);
  });
});

describe("worker-report: edge cases defend the schema", () => {
  it("rejects null", () => {
    expect(validateWorkerReport(null).ok).toBe(false);
  });

  it("rejects undefined", () => {
    expect(validateWorkerReport(undefined).ok).toBe(false);
  });

  it("rejects a string", () => {
    expect(validateWorkerReport("not an object").ok).toBe(false);
  });

  it("rejects an array", () => {
    expect(validateWorkerReport([1, 2, 3]).ok).toBe(false);
  });

  it("rejects an empty object", () => {
    expect(validateWorkerReport({}).ok).toBe(false);
  });

  it("rejects an object with an unknown top-level key", () => {
    const report = { ...VALID_COMPLETE, extra_field: "bad" };
    expect(validateWorkerReport(report).ok).toBe(false);
  });

  it("rejects a wrong schema_version", () => {
    const report = { ...VALID_COMPLETE, schema_version: "ce-beads-worker-report/2" };
    expect(validateWorkerReport(report).ok).toBe(false);
  });

  it("rejects changed_files containing a non-string element", () => {
    const report = { ...VALID_COMPLETE, changed_files: ["ok", 42 as unknown as string] };
    expect(validateWorkerReport(report).ok).toBe(false);
  });

  it("rejects changed_files that is not an array", () => {
    const report = { ...VALID_COMPLETE, changed_files: "src/u1.ts" };
    expect(validateWorkerReport(report).ok).toBe(false);
  });

  it("rejects verification_evidence with an extra key", () => {
    const report = {
      ...VALID_COMPLETE,
      verification_evidence: {
        ...VALID_COMPLETE.verification_evidence,
        extra: "bad",
      },
    };
    expect(validateWorkerReport(report).ok).toBe(false);
  });

  it("rejects verification_evidence.commands that is not a string array", () => {
    const report = {
      ...VALID_COMPLETE,
      verification_evidence: {
        commands: "bun test",
        results: "ok",
      },
    };
    expect(validateWorkerReport(report).ok).toBe(false);
  });

  it("rejects verification_evidence.results that is not a string", () => {
    const report = {
      ...VALID_COMPLETE,
      verification_evidence: {
        commands: ["bun test"],
        results: 42,
      },
    };
    expect(validateWorkerReport(report).ok).toBe(false);
  });

  it("rejects u_id that is not a string", () => {
    const report = { ...VALID_COMPLETE, u_id: 123 };
    expect(validateWorkerReport(report).ok).toBe(false);
  });

  it("rejects blockers that is not a string", () => {
    const report = { ...VALID_COMPLETE, blockers: 42 };
    expect(validateWorkerReport(report).ok).toBe(false);
  });

  it("rejects notes that is not a string when present", () => {
    const report = { ...VALID_COMPLETE, notes: 42 };
    expect(validateWorkerReport(report).ok).toBe(false);
  });

  it("accepts a report without the optional notes field", () => {
    const { notes: _omit, ...withoutNotes } = VALID_COMPLETE;
    const result = validateWorkerReport(withoutNotes);
    expect(result.ok).toBe(true);
  });
});

describe("worker-report: parseReportFromPaneOutput", () => {
  // The sentinel regex requires non-empty content after the colon on the
  // same line (e.g., "CE_BEADS_RESULT:json"). The JSON payload is parsed
  // from the lines AFTER the sentinel line.
  it("parses JSON from lines after the CE_BEADS_RESULT: sentinel", () => {
    const report = VALID_COMPLETE;
    const text = `some log output\nCE_BEADS_RESULT:json\n${JSON.stringify(report)}`;
    const parsed = parseReportFromPaneOutput(text);
    expect(parsed).toEqual(report);
  });

  it("returns null when the sentinel is absent", () => {
    const text = "just some log output with no sentinel";
    expect(parseReportFromPaneOutput(text)).toBeNull();
  });

  it("returns null when the sentinel line has no following JSON", () => {
    const text = "CE_BEADS_RESULT:json\n";
    expect(parseReportFromPaneOutput(text)).toBeNull();
  });

  it("parses multi-line pretty-printed JSON after the sentinel", () => {
    const report = { ...VALID_COMPLETE, u_id: "U9" };
    const json = JSON.stringify(report, null, 2);
    const text = `CE_BEADS_RESULT:json\n${json}`;
    const parsed = parseReportFromPaneOutput(text);
    expect(parsed).toEqual(report);
  });
});
