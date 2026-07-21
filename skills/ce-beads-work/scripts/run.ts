// run.ts — the `run` action handler. Dispatches to RunEngine for
// start/status/resume/reap/abandon subcommands.
//
// Usage:
//   ce-beads run start <plan-path> [--once]
//   ce-beads run status [run-id]
//   ce-beads run resume <run-id> [--once] [--retry]
//   ce-beads run reap <run-id> [--force] [--apply <token>]
//   ce-beads run abandon <run-id> [--apply <token>]

import { join } from "node:path";
import type { CliArgs, ActionHandler } from "../../ce-beads/scripts/cli.ts";
import {
  envelope,
  type ProtocolEnvelope,
  type Diagnostic,
} from "../../ce-beads/scripts/protocol.ts";
import { RunEngine, type RunData } from "./orchestrator.ts";
import { HerdrRuntime } from "./runtimes/herdr.ts";
import type { RunStatus, UnitRunState } from "./run-state.ts";

// --- Types (mirrors §2.7) --------------------------------------------------

export interface RunUnitSummary {
  beadsId: string;
  state: UnitRunState;
  workerBaseSha: string | null;
  workerCommitSha: string | null;
  mergeSha: string | null;
  integratedSha: string | null;
}

export type { RunData } from "./orchestrator.ts";
export type { RunStatus, UnitRunState } from "./run-state.ts";

// --- Handler ---------------------------------------------------------------

export const handler: ActionHandler = {
  async run(args: CliArgs): Promise<ProtocolEnvelope> {
    return runAction(args);
  },
};

function readExtension(args: CliArgs): {
  positional: string[];
} {
  return { positional: extractArray(args, "positional") };
}

function extractArray(obj: unknown, key: string): string[] {
  if (obj !== null && typeof obj === "object" && key in obj) {
    const val = (obj as Record<string, unknown>)[key];
    if (Array.isArray(val)) {
      return val.filter((x): x is string => typeof x === "string");
    }
  }
  return [];
}


async function runAction(args: CliArgs): Promise<ProtocolEnvelope> {
  const { positional } = readExtension(args);
  // positional[0] = "run", positional[1] = subcommand; flags live on the
  // dedicated CliArgs fields (cli.ts never puts them in the options bag).
  const sub = positional[1] ?? args.runSub ?? "";
  const repoRoot = process.cwd();
  const beadsDir = process.env.BEADS_DIR ?? join(repoRoot, ".beads");

  const runtime = new HerdrRuntime({
    repoRoot,
    ...(process.env.CE_BEADS_WORKER_MODEL !== undefined ? { model: process.env.CE_BEADS_WORKER_MODEL } : {}),
    ...(process.env.CE_BEADS_OMP_PROFILE !== undefined ? { profile: process.env.CE_BEADS_OMP_PROFILE } : {}),
  });
  const engine = new RunEngine({
    repoRoot,
    beadsDir,
    runtime,
    workerTimeoutMs: 30 * 60 * 1000,
  });

  switch (sub) {
    case "start": {
      const planPath = positional[2] ?? args.planPath;
      if (!planPath) {
        return envelope("run", false, "refused", null, [
          {
            code: "USAGE",
            severity: "blocking",
            message: "Missing plan path. Usage: ce-beads run start <plan-path> [--once]",
          },
        ]);
      }
      const once = args.once === true;
      return engine.start(planPath, { once });
    }
    case "status": {
      const runId = positional[2] as string | undefined;
      return engine.status(runId);
    }
    case "resume": {
      const runId = positional[2];
      if (!runId) {
        return envelope("run", false, "not_found", null, [
          {
            code: "RUN_NOT_FOUND",
            severity: "blocking",
            message: "Missing run ID. Usage: ce-beads run resume <run-id> [--once] [--retry]",
          },
        ]);
      }
      const once = args.once === true;
      const retry = args.retry === true;
      return engine.resume(runId, { once, retry });
    }
    case "reap": {
      const runId = positional[2];
      if (!runId) {
        return envelope("run", false, "not_found", null, [
          {
            code: "RUN_NOT_FOUND",
            severity: "blocking",
            message: "Missing run ID. Usage: ce-beads run reap <run-id> [--force] [--apply <token>]",
          },
        ]);
      }
      const force = args.force === true;
      const applyToken = args.applyToken;
      return engine.reap(runId, { force, ...(applyToken !== undefined ? { applyToken } : {}) });
    }
    case "abandon": {
      const runId = positional[2];
      if (!runId) {
        return envelope("run", false, "not_found", null, [
          {
            code: "RUN_NOT_FOUND",
            severity: "blocking",
            message: "Missing run ID. Usage: ce-beads run abandon <run-id> [--apply <token>]",
          },
        ]);
      }
      const applyToken = args.applyToken;
      return engine.abandon(runId, ...(applyToken !== undefined ? [{ applyToken }] : [{}]));
    }
    default: {
      void beadsDir;
      const diags: Diagnostic[] = [
        {
          code: "USAGE",
          severity: "blocking",
          message: `Unknown run subcommand: "${sub}". Usage: ce-beads run {start|status|resume|reap|abandon} ...`,
        },
      ];
      return envelope("run", false, "refused", null, diags);
    }
  }
}
