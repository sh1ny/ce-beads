// worker-report.ts — strict schema and legacy pane-output parser for worker results.
// Completion is signaled by the atomic existence of the result file (R3).

/** Schema version for structured reports emitted by ce-beads workers. */
export const WORKER_REPORT_SCHEMA_VERSION = "ce-beads-worker-report/1" as const;

/** Relative path of the atomically published worker result. */
export const WORKER_RESULT_FILE = ".ce-beads-worker/result.json" as const;

/** Relative path of the temporary worker result written before publication. */
export const WORKER_RESULT_TEMP = ".ce-beads-worker/.result.tmp" as const;

/** Relative path of the worker system prompt inside its worktree. */
export const WORKER_SYSTEM_PROMPT_FILE = ".ce-beads-worker/system-prompt.md" as const;

/** Terminal outcomes a worker may report. */
export type WorkerStatus = "complete" | "blocked" | "failed";

/** Structured result returned by a ce-beads worker. */
export interface WorkerReport {
  schema_version: typeof WORKER_REPORT_SCHEMA_VERSION;
  u_id: string;
  status: WorkerStatus;
  changed_files: string[];
  verification_evidence: {
    commands: string[];
    results: string;
  };
  /** Empty string when status is not "blocked". */
  blockers: string;
  notes?: string;
}

/** Result of strict structural validation of an unknown worker report. */
export type WorkerReportValidation =
  | { ok: true; report: WorkerReport }
  | { ok: false; error: string };

const WORKER_STATUS_VALUES: readonly WorkerStatus[] = ["complete", "blocked", "failed"];
const REPORT_KEYS = new Set(["schema_version", "u_id", "status", "changed_files", "verification_evidence", "blockers", "notes"]);
const EVIDENCE_KEYS = new Set(["commands", "results"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Strict structural validation (no schema library): checks the exact object
 * shape, schema version, required keys, value types, status enum, and the
 * status-dependent blockers invariant. Unknown keys are rejected.
 */
export function validateWorkerReport(raw: unknown): WorkerReportValidation {
  if (!isRecord(raw)) return { ok: false, error: "Worker report must be an object." };
  if (!hasOnlyKeys(raw, REPORT_KEYS)) return { ok: false, error: "Worker report contains unknown keys." };

  if (raw.schema_version !== WORKER_REPORT_SCHEMA_VERSION) {
    return { ok: false, error: `schema_version must be ${WORKER_REPORT_SCHEMA_VERSION}.` };
  }
  if (typeof raw.u_id !== "string") return { ok: false, error: "u_id must be a string." };

  const status = raw.status;
  if (typeof status !== "string" || !WORKER_STATUS_VALUES.includes(status as WorkerStatus)) {
    return { ok: false, error: "status must be complete, blocked, or failed." };
  }
  const workerStatus = status as WorkerStatus;

  if (!isStringArray(raw.changed_files)) {
    return { ok: false, error: "changed_files must be an array of strings." };
  }
  if (!isRecord(raw.verification_evidence)) {
    return { ok: false, error: "verification_evidence must be an object." };
  }
  if (!hasOnlyKeys(raw.verification_evidence, EVIDENCE_KEYS)) {
    return { ok: false, error: "verification_evidence contains unknown keys." };
  }
  if (!isStringArray(raw.verification_evidence.commands)) {
    return { ok: false, error: "verification_evidence.commands must be an array of strings." };
  }
  if (typeof raw.verification_evidence.results !== "string") {
    return { ok: false, error: "verification_evidence.results must be a string." };
  }

  if (typeof raw.blockers !== "string") return { ok: false, error: "blockers must be a string." };
  if (workerStatus === "blocked" && raw.blockers.length === 0) {
    return { ok: false, error: "blockers must be non-empty when status is blocked." };
  }
  if (workerStatus !== "blocked" && raw.blockers.length !== 0) {
    return { ok: false, error: "blockers must be empty when status is not blocked." };
  }
  const notes = raw.notes;
  const hasNotes = Object.prototype.hasOwnProperty.call(raw, "notes");
  if (hasNotes && typeof notes !== "string") {
    return { ok: false, error: "notes must be a string when present." };
  }

  const report: WorkerReport = {
    schema_version: WORKER_REPORT_SCHEMA_VERSION,
    u_id: raw.u_id,
    status: workerStatus,
    changed_files: raw.changed_files,
    verification_evidence: {
      commands: raw.verification_evidence.commands,
      results: raw.verification_evidence.results,
    },
    blockers: raw.blockers,
    ...(hasNotes ? { notes: notes as string } : {}),
  };

  return { ok: true, report };
}

/**
 * Parse the JSON payload following a `CE_BEADS_RESULT:` sentinel line.
 * Returns null when no sentinel or no valid JSON payload is present.
 *
 * The parser intentionally returns unknown; callers must apply
 * `validateWorkerReport` before treating the payload as a report.
 */
export function parseReportFromPaneOutput(text: string): unknown | null {
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !/^CE_BEADS_RESULT:[^\r\n]+$/.test(line)) continue;

    const payload = lines.slice(index + 1).join("\n").trim();
    if (payload.length === 0) continue;

    try {
      return JSON.parse(payload) as unknown;
    } catch {
      // A later sentinel may be the first complete result in pane output.
    }
  }

  return null;
}
