// doctor.ts — doctor action handler.
//
// Read-only preflight reporting:
//   - bd presence on PATH
//   - installed bd version vs tested version in UPSTREAMS.lock.json
//   - whether the current repository has an initialized Beads workspace
//   - whether a supplied plan path parses under the supported contract
//   - when a binding exists, binding health via U6 classification
//
// Doctor never executes corrections, installs bd, or initializes anything.
// Each finding prints the exact corrective command where safe.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliArgs, ActionHandler } from "./cli.ts";
import type { ProtocolEnvelope, Diagnostic } from "./protocol.ts";
import { envelope } from "./protocol.ts";
import { BeadsClient, BdError } from "./beads-client.ts";
import { parsePlan, PlanParseError } from "./plan-parser.ts";
import { reconcile } from "./reconcile.ts";

export interface DoctorData {
  checks: Array<{
    name: string;
    status: "pass" | "warn" | "fail";
    detail: string;
    remediation: string | undefined;
  }>;
}

export const handler: ActionHandler = {
  async run(args: CliArgs): Promise<ProtocolEnvelope> {
    const repoRoot = process.cwd();

    const checks: DoctorData["checks"] = [];
    const diagnostics: Diagnostic[] = [];

    // 1. bd presence on PATH.
    let bdPath = "bd";
    let bdFound = false;
    try {
      const client = new BeadsClient({ beadsDir: join(repoRoot, ".beads") });
      const version = await client.version();
      bdFound = true;
      checks.push({
        name: "bd_presence",
        status: "pass",
        detail: `bd found: ${version}`,
        remediation: undefined,
      });

      // 2. Version check against UPSTREAMS.lock.json.
      // UPSTREAMS.lock.json is package-owned: resolve relative to this module, never cwd.
      const lockPath = fileURLToPath(new URL("../../../UPSTREAMS.lock.json", import.meta.url));
      if (existsSync(lockPath)) {
        const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { tools?: { bd?: { version?: string } } };
        const testedVersion = lock.tools?.bd?.version;
        if (testedVersion) {
          const installedVersion = version.replace(/^bd version /, "").split(" ")[0]!;
          if (installedVersion === testedVersion) {
            checks.push({
              name: "bd_version",
              status: "pass",
              detail: `bd version ${installedVersion} matches tested version ${testedVersion}.`,
              remediation: undefined,
            });
          } else {
            checks.push({
              name: "bd_version",
              status: "warn",
              detail: `bd version ${installedVersion} differs from tested version ${testedVersion}.`,
              remediation: "Install the tested version or verify compatibility.",
            });
            diagnostics.push({
              code: "BD_VERSION_MISMATCH",
              severity: "warning",
              message: `Installed bd ${installedVersion} differs from tested ${testedVersion}.`,
            });
          }
        }
      }
    } catch (e) {
      if (e instanceof BdError && e.kind === "bd_missing") {
        checks.push({
          name: "bd_presence",
          status: "fail",
          detail: "bd binary not found on PATH.",
          remediation: "Install bd via the official checksum-verifying path (see upstream/beads install docs).",
        });
        diagnostics.push({
          code: "BD_MISSING",
          severity: "blocking",
          message: "bd binary not found on PATH.",
          remediation: "Install bd via the official checksum-verifying path.",
        });
      } else {
        checks.push({
          name: "bd_presence",
          status: "fail",
          detail: `Error checking bd: ${(e as Error).message}`,
          remediation: undefined,
        });
      }
    }

    if (!bdFound) {
      // Can't check anything else without bd.
      return envelope("doctor", false, "environment_unready", { checks }, diagnostics);
    }

    // 3. Workspace initialization.
    const beadsDir = process.env.BEADS_DIR ?? join(repoRoot, ".beads");
    if (existsSync(beadsDir)) {
      checks.push({
        name: "workspace_initialized",
        status: "pass",
        detail: `Beads workspace found at ${beadsDir}.`,
        remediation: undefined,
      });
    } else {
      checks.push({
        name: "workspace_initialized",
        status: "fail",
        detail: `No Beads workspace at ${beadsDir}.`,
        remediation: "Run: bd init --non-interactive --init-if-missing --skip-agents --skip-hooks --stealth",
      });
      diagnostics.push({
        code: "WORKSPACE_UNINITIALIZED",
        severity: "blocking",
        message: "Beads workspace not initialized.",
        remediation: "Run: bd init --non-interactive --init-if-missing --skip-agents --skip-hooks --stealth",
      });
    }

    // 4. Plan support (if plan path supplied).
    if (args.planPath) {
      try {
        parsePlan(args.planPath, { repoRoot });
        checks.push({
          name: "plan_support",
          status: "pass",
          detail: `Plan ${args.planPath} is a supported implementation-ready code plan.`,
          remediation: undefined,
        });
      } catch (e) {
        if (e instanceof PlanParseError) {
          checks.push({
            name: "plan_support",
            status: "fail",
            detail: `Plan ${args.planPath} is not supported: ${e.message}`,
            remediation: "Ensure the plan has artifact_contract: ce-unified-plan/v1, artifact_readiness: implementation-ready, execution: code.",
          });
          diagnostics.push({
            code: e.code === "PLAN_UNSUPPORTED" ? "PLAN_UNSUPPORTED" : "PLAN_MALFORMED",
            severity: "blocking",
            message: e.message,
          });
        }
      }

      // 5. Binding health (if binding exists).
      if (existsSync(beadsDir) && args.planPath) {
        try {
          const client = new BeadsClient({ beadsDir });
          // Parse the plan to get the canonical path.
          let planPath;
          try {
            const plan = parsePlan(args.planPath, { repoRoot });
            planPath = plan.path;
          } catch {
            // Can't check binding health if plan is malformed.
            planPath = undefined;
          }
          if (planPath) {
            const result = await reconcile(client, planPath, repoRoot);
            if (result.binding.epicId) {
              // Binding exists — check health.
              const blockingUnits = result.units.filter((u) => u.isBlocking);
              if (blockingUnits.length === 0 && !result.binding.hasDuplicateEpic && !result.binding.hasCorruptTasks) {
                checks.push({
                  name: "binding_health",
                  status: "pass",
                  detail: `Binding is healthy (${result.units.length} units, ${result.removedTasks.length} removed).`,
                  remediation: undefined,
                });
              } else {
                checks.push({
                  name: "binding_health",
                  status: "fail",
                  detail: `Binding has issues: ${blockingUnits.length} blocking units, duplicate epic: ${result.binding.hasDuplicateEpic}, corrupt tasks: ${result.binding.hasCorruptTasks}.`,
                  remediation: "Run `ce-beads status` for details, then repair manually.",
                });
                diagnostics.push({
                  code: "BINDING_DRIFT",
                  severity: "blocking",
                  message: "Binding has blocking issues.",
                  remediation: "Run `ce-beads status` for details.",
                });
              }
            } else {
              checks.push({
                name: "binding_health",
                status: "pass",
                detail: "No binding found for this plan.",
                remediation: undefined,
              });
            }
          }
        } catch {
          // Binding health check failed — not fatal for doctor.
          checks.push({
            name: "binding_health",
            status: "warn",
            detail: "Could not check binding health.",
            remediation: undefined,
          });
        }
      }
    }

    // Determine overall outcome.
    const hasFail = checks.some((c) => c.status === "fail");
    const hasWarn = checks.some((c) => c.status === "warn");
    const outcome = hasFail ? "environment_unready" : hasWarn ? "issues_found" : "healthy";

    return envelope("doctor", outcome === "healthy", outcome, { checks }, diagnostics);
  },
};
