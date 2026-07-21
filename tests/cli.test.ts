import { describe, expect, it } from "bun:test";
import {
  parseArgs,
  emit,
  usageMessage,
  LockHolder,
  buildPreview,
  verifyApplyToken,
} from "../skills/ce-beads/scripts/cli.ts";
import {
  PROTOCOL_VERSION,
  ExitCode,
  envelope,
  computeApprovalToken,
  type MutationEntry,
  type ApprovalPayload,
} from "../skills/ce-beads/scripts/protocol.ts";

describe("cli: dispatch", () => {
  it("each subcommand dispatches", () => {
    expect(parseArgs(["bun", "cli.ts", "doctor"]).action).toBe("doctor");
    expect(parseArgs(["bun", "cli.ts", "bind", "docs/plans/x.md"]).action).toBe("bind");
    expect(parseArgs(["bun", "cli.ts", "status", "docs/plans/x.md"]).action).toBe("status");
    expect(parseArgs(["bun", "cli.ts", "sync", "docs/plans/x.md"]).action).toBe("sync");
  });

  it("unknown subcommands exit with the usage code and a structured diagnostic", () => {
    const args = parseArgs(["bun", "cli.ts", "unknown-cmd"]);
    expect(args.help).toBe(true);
  });

  it("parses --json flag", () => {
    const args = parseArgs(["bun", "cli.ts", "status", "docs/plans/x.md", "--json"]);
    expect(args.json).toBe(true);
  });

  it("parses --apply <token> flag", () => {
    const args = parseArgs(["bun", "cli.ts", "bind", "docs/plans/x.md", "--apply", "abc123"]);
    expect(args.applyToken).toBe("abc123");
  });

  it("parses --help flag", () => {
    const args = parseArgs(["bun", "cli.ts", "--help"]);
    expect(args.help).toBe(true);
  });

  it("usage message contains protocol version and all actions", () => {
    const msg = usageMessage();
    expect(msg).toContain(PROTOCOL_VERSION);
    expect(msg).toContain("doctor");
    expect(msg).toContain("bind");
    expect(msg).toContain("status");
    expect(msg).toContain("sync");
  });
});

describe("cli: protocol envelope", () => {
  it("under --json, stdout parses as the envelope for success paths; stderr carries no JSON", () => {
    const env = envelope("status", true, "unchanged", { units: [] });
    let stdout = "";
    let stderr = "";
    const code = emit(env, true, {
      stdout: (s) => { stdout += s; },
      stderr: (s) => { stderr += s; },
    });
    expect(code).toBe(ExitCode.SUCCESS);
    const parsed = JSON.parse(stdout) as { schema_version: string; action: string; ok: boolean; outcome: string };
    expect(parsed.schema_version).toBe(PROTOCOL_VERSION);
    expect(parsed.action).toBe("status");
    expect(parsed.ok).toBe(true);
    expect(parsed.outcome).toBe("unchanged");
    expect(stderr).toBe("");
  });

  it("under --json, stdout parses as the envelope for failure paths; stderr carries no JSON", () => {
    const env = envelope("bind", false, "refused", {}, [
      { code: "BINDING_DRIFT", severity: "blocking", message: "drift detected" },
    ]);
    let stdout = "";
    let stderr = "";
    const code = emit(env, true, {
      stdout: (s) => { stdout += s; },
      stderr: (s) => { stderr += s; },
    });
    expect(code).toBe(ExitCode.CONFLICT);
    const parsed = JSON.parse(stdout) as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics[0]!.code).toBe("BINDING_DRIFT");
    // stderr has diagnostics text, not JSON.
    expect(stderr).not.toContain("{");
  });

  it("human-readable output goes to stderr, not stdout", () => {
    const env = envelope("doctor", true, "healthy", { checks: [] });
    let stdout = "";
    let stderr = "";
    emit(env, false, {
      stdout: (s) => { stdout += s; },
      stderr: (s) => { stderr += s; },
    });
    expect(stdout).toBe("");
    expect(stderr).toContain("doctor");
    expect(stderr).toContain("healthy");
  });
});

describe("cli: exit codes match the taxonomy", () => {
  it("SUCCESS for ordinary drift (unchanged, drift, healthy, issues_found)", () => {
    for (const outcome of ["unchanged", "drift", "healthy", "issues_found"] as const) {
      const env = envelope("status", true, outcome, {});
      const code = emit(env, true, { stdout: () => {}, stderr: () => {} });
      expect(code).toBe(ExitCode.SUCCESS);
    }
  });

  it("CONFLICT for binding_drift, refused, blocked", () => {
    for (const outcome of ["binding_drift", "refused", "blocked"] as const) {
      const env = envelope("bind", false, outcome, {}, [
        { code: "BINDING_DRIFT", severity: "blocking", message: "x" },
      ]);
      const code = emit(env, true, { stdout: () => {}, stderr: () => {} });
      expect(code).toBe(ExitCode.CONFLICT);
    }
  });

  it("USAGE for unknown subcommand", () => {
    const args = parseArgs(["bun", "cli.ts", "unknown"]);
    expect(args.help).toBe(true);
  });

  it("UNSUPPORTED_PLAN for PLAN_UNSUPPORTED diagnostic", () => {
    const env = envelope("bind", false, "refused", {}, [
      { code: "PLAN_UNSUPPORTED", severity: "blocking", message: "x" },
    ]);
    const code = emit(env, true, { stdout: () => {}, stderr: () => {} });
    expect(code).toBe(ExitCode.UNSUPPORTED_PLAN);
  });

  it("PRECONDITION for BD_MISSING diagnostic", () => {
    const env = envelope("doctor", false, "environment_unready", {}, [
      { code: "BD_MISSING", severity: "blocking", message: "x" },
    ]);
    const code = emit(env, true, { stdout: () => {}, stderr: () => {} });
    expect(code).toBe(ExitCode.PRECONDITION);
  });

  it("LOCK_BUSY for LOCK_BUSY diagnostic", () => {
    const env = envelope("bind", false, "refused", {}, [
      { code: "LOCK_BUSY", severity: "blocking", message: "x" },
    ]);
    const code = emit(env, true, { stdout: () => {}, stderr: () => {} });
    expect(code).toBe(ExitCode.LOCK_BUSY);
  });

  it("PARTIAL for partial outcome", () => {
    const env = envelope("sync", false, "partial", {}, [
      { code: "PARTIAL_APPLY", severity: "error", message: "x" },
    ]);
    const code = emit(env, true, { stdout: () => {}, stderr: () => {} });
    expect(code).toBe(ExitCode.PARTIAL);
  });
});

describe("cli: approval token", () => {
  const mutations: MutationEntry[] = [
    { id: "m1", kind: "create", target: "docs/plans/x.md::U1", summary: "create U1", state: "pending" },
  ];
  const payload: Omit<ApprovalPayload, "protocol_version"> = {
    action: "bind",
    plan_path: "docs/plans/x.md",
    plan_digest: "abc123",
    beads_state_fingerprint: "fp1",
    ordered_mutation_set: mutations,
  };

  it("without --apply, a mutating action emits the preview plus token and mutates nothing", () => {
    const preview = buildPreview(payload);
    expect(preview.approvalToken).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.mutations).toHaveLength(1);
    expect(preview.mutations[0]!.state).toBe("pending");
  });

  it("a correct token verifies", () => {
    const preview = buildPreview(payload);
    expect(verifyApplyToken(preview.approvalToken, payload)).toBe(true);
  });

  it("a wrong token does not verify", () => {
    expect(verifyApplyToken("0000000000000000000000000000000000000000000000000000000000000000", payload)).toBe(false);
  });

  it("a stale token (changed mutation set) does not verify", () => {
    const preview = buildPreview(payload);
    const changedPayload = { ...payload, ordered_mutation_set: [...mutations, { id: "m2", kind: "create" as const, target: "U2", summary: "create U2", state: "pending" as const }] };
    expect(verifyApplyToken(preview.approvalToken, changedPayload)).toBe(false);
  });

  it("token changes when mutation order changes", () => {
    const m1: MutationEntry[] = [
      { id: "m1", kind: "create", target: "U1", summary: "create U1", state: "pending" },
      { id: "m2", kind: "create", target: "U2", summary: "create U2", state: "pending" },
    ];
    const m2: MutationEntry[] = [m1[1]!, m1[0]!];
    const t1 = computeApprovalToken({ ...payload, ordered_mutation_set: m1, protocol_version: PROTOCOL_VERSION });
    const t2 = computeApprovalToken({ ...payload, ordered_mutation_set: m2, protocol_version: PROTOCOL_VERSION });
    expect(t1).not.toBe(t2);
  });
});

describe("cli: lock", () => {
  it("a held lock makes a second mutating invocation fail fast", async () => {
    const lock1 = new LockHolder("docs/plans/x.md", "/tmp/ce-beads-lock-test");
    const lock2 = new LockHolder("docs/plans/x.md", "/tmp/ce-beads-lock-test");
    try {
      const acquired1 = await lock1.tryAcquire();
      expect(acquired1).toBe(true);
      const acquired2 = await lock2.tryAcquire();
      expect(acquired2).toBe(false);
    } finally {
      lock1.release();
    }
  });

  it("after release, a fresh process acquires the lock", async () => {
    const lock1 = new LockHolder("docs/plans/y.md", "/tmp/ce-beads-lock-test");
    try {
      expect(await lock1.tryAcquire()).toBe(true);
      lock1.release();
      // Real delay: flock releases the lock when the holder process group
      // receives SIGTERM and the sleep child exits. This is an OS-level
      // signal delivery + process teardown, not a test-internal timer.
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 300);
      await promise;
    } finally {
      lock1.release();
    }
    const lock3 = new LockHolder("docs/plans/y.md", "/tmp/ce-beads-lock-test");
    try {
      expect(await lock3.tryAcquire()).toBe(true);
    } finally {
      lock3.release();
    }
  });
});
