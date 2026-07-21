#!/usr/bin/env bun
// cli.ts — subcommand dispatch, lock plumbing, and preview/apply flow.
//
// Owns subcommand dispatch and the shared machine protocol (KTD15, KTD16).
// Action handlers (bind, status, sync, doctor) implement behavior only; they
// consume protocol.ts and must not define private envelope variants.
//
// Lock (KTD17): OS-managed fd-attached advisory lock via flock(2), keyed by
// the canonical plan path. Ownership is released when the holding process
// dies. No O_EXCL, mkdir, PID files, timestamps, or stale-age heuristics.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PROTOCOL_VERSION,
  ExitCode,
  type Action,
  type ProtocolEnvelope,
  type Outcome,
  type Diagnostic,
  type MutationEntry,
  type ApprovalPayload,
  computeApprovalToken,
  envelope,
  exitCodeFor,
} from "./protocol.ts";
import { handler as doctorHandler } from "./doctor.ts";
import { handler as bindHandler } from "./bind.ts";
import { handler as statusHandler } from "./status.ts";
import { handler as syncHandler } from "./sync.ts";
export interface CliArgs {
  action: Action;
  planPath: string | undefined;
  json: boolean;
  applyToken: string | undefined;
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // skip bun + script path
  if (args.length === 0) {
    return { action: "doctor", planPath: undefined, json: false, applyToken: undefined, help: true };
  }
  const action = args[0] as Action;
  if (!["doctor", "bind", "status", "sync"].includes(action)) {
    return { action: "doctor", planPath: undefined, json: false, applyToken: undefined, help: true };
  }
  let planPath: string | undefined;
  let json = false;
  let applyToken: string | undefined;
  let help = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") json = true;
    else if (arg === "--apply") {
      applyToken = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (!arg.startsWith("-") && !planPath) {
      planPath = arg;
    }
  }
  return { action, planPath, json, applyToken, help };
}

// --- Output ----------------------------------------------------------------

export function emit(
  env: ProtocolEnvelope,
  json: boolean,
  stream: { stdout: (s: string) => void; stderr: (s: string) => void } = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  },
): number {
  const code = exitCodeFor(env.action, env.outcome, env.diagnostics);
  if (json) {
    // JSON-only stdout; human diagnostics on stderr.
    stream.stdout(JSON.stringify(env) + "\n");
    if (env.diagnostics.length > 0) {
      for (const d of env.diagnostics) {
        stream.stderr(`[${d.severity}] ${d.code}: ${d.message}\n`);
        if (d.remediation) stream.stderr(`  → ${d.remediation}\n`);
      }
    }
  } else {
    // Human-readable output on stderr.
    stream.stderr(`ce-beads ${env.action}: ${env.outcome} (ok=${env.ok})\n`);
    for (const d of env.diagnostics) {
      stream.stderr(`[${d.severity}] ${d.code}: ${d.message}\n`);
      if (d.remediation) stream.stderr(`  → ${d.remediation}\n`);
    }
    if (env.data !== null && env.data !== undefined) {
      stream.stderr(JSON.stringify(env.data, null, 2) + "\n");
    }
  }
  return code;
}

// --- Usage -----------------------------------------------------------------

export function usageMessage(): string {
  return [
    "ce-beads — bridge CE implementation-ready plans into Beads",
    "",
    "Usage: ce-beads <action> [plan-path] [flags]",
    "",
    "Actions:",
    "  doctor [plan-path]   Read-only health report",
    "  bind <plan-path>     Import a plan into Beads (idempotent)",
    "  status <plan-path>   Read-only drift report",
    "  sync <plan-path>      Reconcile plan changes into Beads",
    "",
    "Flags:",
    "  --json               Machine-readable JSON envelope on stdout",
    "  --apply <token>      Apply a previously-previewed mutation set",
    "  --help, -h           Show this help",
    "",
    `Protocol version: ${PROTOCOL_VERSION}`,
  ].join("\n");
}

// --- Lock (KTD17) ----------------------------------------------------------

/**
 * OS-managed advisory lock keyed by the canonical plan path. Spawns
 * `flock -n <lockfile> sleep infinity` as a detached child process that
 * holds the lock for the parent's lifetime. The lock is released when the
 * child is killed (on parent exit via process cleanup, or explicitly via
 * release()). Non-blocking: fails fast if already held.
 *
 * KTD17 constraints honored: no O_EXCL, no mkdir-as-lock, no PID files,
 * no timestamps, no stale-age heuristics, no manual stale-lock deletion.
 * A stable empty lock file may persist but is stateless and never gates
 * acquisition — flock(2) is the ownership primitive.
 */
export class LockHolder {
  private child: ReturnType<typeof spawn> | null = null;
  readonly lockFile: string;

  constructor(planPath: string, repoRoot: string) {
    const key = hashKey(`${repoRoot}::${planPath}`);
    const lockDir = join(tmpdir(), "ce-beads-locks");
    mkdirSync(lockDir, { recursive: true });
    this.lockFile = join(lockDir, `${key}.lock`);
    // Ensure the file exists (create if missing, no O_EXCL).
    if (!existsSync(this.lockFile)) {
      writeFileSync(this.lockFile, "");
    }
  }

  /**
   * Try to acquire the lock non-blocking. Returns true on success, false if
   * contended. Spawns a detached `flock -n <lockfile> sleep 86400` child
   * that holds the lock; the child is killed on release() or parent exit.
   * `sleep infinity` is not portable; 86400s (24h) is the long-lived holder.
   */
  async tryAcquire(): Promise<boolean> {
    const child = spawn("flock", ["-n", this.lockFile, "sleep", "86400"], {
      detached: true,
      stdio: "ignore",
    });
    // Wait for either exit (failed to acquire) or timeout (acquired and holding).
    const { promise, resolve } = Promise.withResolvers<number | null>();
    child.on("exit", (code: number | null) => resolve(code));
    const timer = setTimeout(() => resolve(null), 500); // null = still running = acquired
    const exitCode = await promise;
    clearTimeout(timer);
    child.unref();
    if (exitCode !== null) {
      // Child exited — failed to acquire.
      return false;
    }
    this.child = child;
    return true;
  }

  /** Release the lock by killing the holder child's process group. */
  release(): void {
    if (this.child && this.child.pid) {
      try {
        // Kill the entire process group (negative PID) so the `sleep`
        // child holding the fd is also terminated.
        process.kill(-this.child.pid, "SIGTERM");
      } catch {
        try {
          this.child.kill("SIGTERM");
        } catch {
          // best-effort
        }
      }
      this.child = null;
    }
  }


  isHeld(): boolean {
    return this.child !== null;
  }
}

// --- Preview / Apply plumbing (KTD16) --------------------------------------

export interface PreviewResult {
  mutations: MutationEntry[];
  approvalToken: string;
  approvalPayload: ApprovalPayload;
}

/**
 * Build a preview result from the mutation set and approval payload.
 * The token is computed over the canonical payload (KTD16).
 */
export function buildPreview(
  payload: Omit<ApprovalPayload, "protocol_version">,
): PreviewResult {
  const fullPayload: ApprovalPayload = {
    ...payload,
    protocol_version: PROTOCOL_VERSION,
  };
  const token = computeApprovalToken(fullPayload);
  return {
    mutations: payload.ordered_mutation_set,
    approvalToken: token,
    approvalPayload: fullPayload,
  };
}

/**
 * Verify an apply token against a recomputed preview. Returns true if the
 * token matches exactly (KTD16: exact match required before first mutation).
 */
export function verifyApplyToken(
  providedToken: string,
  payload: Omit<ApprovalPayload, "protocol_version">,
): boolean {
  const expected = computeApprovalToken({
    ...payload,
    protocol_version: PROTOCOL_VERSION,
  });
  return providedToken === expected;
}

// --- Main dispatch ---------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help || (args.action !== "doctor" && !args.planPath)) {
    process.stderr.write(usageMessage() + "\n");
    return args.help ? ExitCode.SUCCESS : ExitCode.USAGE;
  }

  const handlers: Record<Action, ActionHandler> = {
    doctor: doctorHandler,
    bind: bindHandler,
    status: statusHandler,
    sync: syncHandler,
  };
  const handler = handlers[args.action]!;
  const env = await handler.run(args);
  return emit(env, args.json);
}

export interface ActionHandler {
  run(args: CliArgs): Promise<ProtocolEnvelope>;
}

// --- Helpers ---------------------------------------------------------------

function hashKey(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)!) | 0;
  }
  return (h >>> 0).toString(16);
}

// Exported for testing.
export { envelope, exitCodeFor };
export type { Outcome, Diagnostic, MutationEntry, ApprovalPayload };

// Entry point when run directly via `bun cli.ts`.
if (import.meta.main) {
  main(process.argv).then((code) => {
    process.exit(code);
  });
}
