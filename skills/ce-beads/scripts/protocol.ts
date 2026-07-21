// protocol.ts — the single normative source for the ce-beads machine protocol.
//
// Implements the Appendix's normative protocol (KTD15) verbatim:
//   - versioned JSON envelope (schema_version, action, ok, outcome, data, diagnostics)
//   - per-action outcome enums
//   - diagnostic registry (codes, severities)
//   - exit-code taxonomy (0 success; 2-9 reserved for failures)
//   - approval-token computation (KTD16: SHA-256 over canonical payload)
//
// Action handlers consume this module and must not define private envelope
// variants. Ordinary drift is exit 0 with a semantic outcome; exit codes are
// reserved for failures.

import { createHash } from "node:crypto";

// --- Protocol version ------------------------------------------------------

export const PROTOCOL_VERSION = "ce-beads-protocol/1" as const;

// --- Actions ---------------------------------------------------------------

export type Action = "doctor" | "bind" | "status" | "sync";

// --- Outcomes (per-action closed enums) -------------------------------------

export type DoctorOutcome = "healthy" | "issues_found" | "environment_unready";
export type BindOutcome = "bound" | "already_bound" | "binding_drift" | "preview" | "refused";
export type StatusOutcome = "unchanged" | "drift" | "blocked";
export type SyncOutcome = "preview" | "applied" | "partial" | "blocked" | "refused";

export type Outcome = DoctorOutcome | BindOutcome | StatusOutcome | SyncOutcome;

// --- Exit codes (KTD15 taxonomy) -------------------------------------------

export const ExitCode = {
  SUCCESS: 0,
  USAGE: 2,
  UNSUPPORTED_PLAN: 3,
  PRECONDITION: 4,
  CONFLICT: 5,
  PARTIAL: 6,
  BD_FAILURE: 7,
  READBACK_FAILURE: 8,
  LOCK_BUSY: 9,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

// --- Diagnostics -----------------------------------------------------------

export type DiagnosticSeverity = "info" | "warning" | "error" | "blocking";

export type DiagnosticCode =
  | "PLAN_UNSUPPORTED"
  | "PLAN_MALFORMED"
  | "BD_MISSING"
  | "BD_VERSION_MISMATCH"
  | "WORKSPACE_UNINITIALIZED"
  | "BINDING_DRIFT"
  | "DUPLICATE_BINDING"
  | "CORRUPT_BINDING"
  | "EXTERNALLY_MODIFIED"
  | "MISSING_IN_BEADS"
  | "DEPENDENCY_BASELINE_CORRUPT"
  | "TOKEN_MISMATCH"
  | "LOCK_BUSY"
  | "BD_FAILURE"
  | "READBACK_FAILURE"
  | "PARTIAL_APPLY";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  remediation?: string;
}

// --- Envelope (stdout under --json; human output on stderr) ----------------

export interface ProtocolEnvelope<TData = unknown> {
  schema_version: typeof PROTOCOL_VERSION;
  action: Action;
  ok: boolean;
  outcome: Outcome;
  data: TData;
  diagnostics: Diagnostic[];
}

// --- Mutation entry schema (KTD15) -----------------------------------------

export type MutationKind =
  | "create"
  | "update"
  | "dep_add"
  | "label_add"
  | "label_remove"
  | "epic_commit_marker";

export type MutationState = "pending" | "applied" | "conflict" | "indeterminate";

export interface MutationEntry {
  id: string;
  kind: MutationKind;
  target: string;
  summary: string;
  state: MutationState;
  beadsId?: string;
  remediation?: string;
}

// --- Approval token (KTD16) ------------------------------------------------

export interface ApprovalPayload {
  protocol_version: typeof PROTOCOL_VERSION;
  action: Action;
  plan_path: string;
  plan_digest: string;
  beads_state_fingerprint: string;
  ordered_mutation_set: MutationEntry[];
}

/**
 * Compute the deterministic approval token: SHA-256 hex over the canonical
 * serialization of the approval payload (KTD16). The payload contains the
 * action, canonical plan identity, plan digest, normalized relevant Beads
 * state fingerprint, and the ordered mutation set.
 *
 * Preview emits the token; `--apply <token>` recomputes under the lock and
 * requires exact match before the first mutation.
 */
export function computeApprovalToken(payload: ApprovalPayload): string {
  const canonical = canonicalApprovalPayload(payload);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Canonical serialization of the approval payload. Keys are sorted; the
 * mutation set is ordered as given. This is the stable input to the token
 * hash — changing any field (including mutation order) changes the token.
 */
export function canonicalApprovalPayload(payload: ApprovalPayload): string {
  const normalized: ApprovalPayload = {
    protocol_version: payload.protocol_version,
    action: payload.action,
    plan_path: payload.plan_path,
    plan_digest: payload.plan_digest,
    beads_state_fingerprint: payload.beads_state_fingerprint,
    ordered_mutation_set: payload.ordered_mutation_set.map((m) => ({
      id: m.id,
      kind: m.kind,
      target: m.target,
      summary: m.summary,
      state: m.state,
      ...(m.beadsId !== undefined ? { beadsId: m.beadsId } : {}),
      ...(m.remediation !== undefined ? { remediation: m.remediation } : {}),
    })),
  };
  return stableJson(normalized);
}

// --- Envelope construction -------------------------------------------------

export function envelope<TData>(
  action: Action,
  ok: boolean,
  outcome: Outcome,
  data: TData,
  diagnostics: Diagnostic[] = [],
): ProtocolEnvelope<TData> {
  return {
    schema_version: PROTOCOL_VERSION,
    action,
    ok,
    outcome,
    data,
    diagnostics,
  };
}

// --- Exit code mapping -----------------------------------------------------

/**
 * Map an outcome + diagnostics to the exit code. Ordinary drift is exit 0
 * with a semantic outcome. Exit codes 2-9 are reserved for failures.
 */
export function exitCodeFor(
  action: Action,
  outcome: Outcome,
  diagnostics: Diagnostic[],
): ExitCodeValue {
  // If any blocking diagnostic, it's a conflict (exit 5) unless it's
  // environment-related (exit 4) or a plan issue (exit 3).
  const hasBlocking = diagnostics.some((d) => d.severity === "blocking");
  const hasError = diagnostics.some((d) => d.severity === "error");

  // Environment issues.
  if (diagnostics.some((d) => d.code === "BD_MISSING")) return ExitCode.PRECONDITION;
  if (diagnostics.some((d) => d.code === "WORKSPACE_UNINITIALIZED")) return ExitCode.PRECONDITION;

  // Plan issues.
  if (diagnostics.some((d) => d.code === "PLAN_UNSUPPORTED")) return ExitCode.UNSUPPORTED_PLAN;
  if (diagnostics.some((d) => d.code === "PLAN_MALFORMED")) return ExitCode.UNSUPPORTED_PLAN;

  // Lock busy.
  if (diagnostics.some((d) => d.code === "LOCK_BUSY")) return ExitCode.LOCK_BUSY;

  // Token mismatch.
  if (diagnostics.some((d) => d.code === "TOKEN_MISMATCH")) return ExitCode.CONFLICT;

  // Preview is success (exit 0) — it's not a failure, even if it carries an
  // info-level PARTIAL_APPLY diagnostic telling the user to re-run with --apply.
  if (outcome === "preview") return ExitCode.SUCCESS;

  // Partial / indeterminate.
  if (outcome === "partial") return ExitCode.PARTIAL;
  if (diagnostics.some((d) => d.code === "PARTIAL_APPLY")) return ExitCode.PARTIAL;

  // Binding drift / refused -> conflict.
  if (outcome === "binding_drift" || outcome === "refused" || outcome === "blocked") {
    return ExitCode.CONFLICT;
  }

  // Read-back failure.
  if (diagnostics.some((d) => d.code === "READBACK_FAILURE")) return ExitCode.READBACK_FAILURE;

  // bd failure.
  if (diagnostics.some((d) => d.code === "BD_FAILURE")) return ExitCode.BD_FAILURE;

  // Ordinary drift / issues_found / healthy / unchanged / bound / already_bound / applied.
  if (hasBlocking || hasError) return ExitCode.CONFLICT;
  void action;
  return ExitCode.SUCCESS;
}

// --- Stable JSON -----------------------------------------------------------

function stableJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
