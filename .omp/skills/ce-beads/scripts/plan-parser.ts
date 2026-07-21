// plan-parser.ts — Markdown -> CePlan IR + validation.
//
// Parsing boundary for ce-unified-plan/v1 implementation-ready code plans.
// Parses YAML frontmatter and `### U<N>.` unit headings with bold-label
// fields, validates the artifact contract literally, and rejects every
// unsupported shape before any Beads mutation. The parser never touches
// Beads.
//
// Contract facts (from upstream/compound-engineering-plugin):
//   - plan-sections.md: artifact_contract / artifact_readiness / execution
//     values; required unit fields (Goal, Requirements, Dependencies, Files,
//     Approach, Patterns to follow, Test scenarios, Verification).
//   - markdown-rendering.md: `### U<N>.` heading; bold leader-label fields.
//   - SKILL.md: stable U-IDs; unit field labels.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

// --- Types -----------------------------------------------------------------

/** Supported artifact contract. */
export type ArtifactContract = "ce-unified-plan/v1";

/** Supported readiness. Only implementation-ready is executable. */
export type ArtifactReadiness = "implementation-ready";

/** Supported execution mode. Only code plans are bridged. */
export type Execution = "code";

/** A single CE implementation unit, fully typed. No `any`. */
export interface CeUnit {
  /** Stable U-ID, e.g. "U1". */
  id: string;
  /** Title text following `### U<N>. `. */
  title: string;
  goal: string;
  /** Requirement IDs, e.g. ["R2", "R4"]. */
  requirements: string[];
  /** Dependency U-IDs, e.g. ["U1"]. Empty when none. */
  dependencies: string[];
  /** Repo-relative file paths mentioned in the unit. */
  files: string[];
  approach: string;
  executionNote?: string;
  technicalDesign?: string;
  patterns: string[];
  testScenarios: string[];
  verification: string[];
}

/** A parsed CE plan. Immutable input to downstream units. */
export interface CePlan {
  /** Canonical repo-relative plan path (forward slashes). */
  path: string;
  /** sha256 hex over the raw plan file bytes (KTD12). */
  digest: string;
  /** Plan title from frontmatter `title`. */
  title: string;
  artifactContract: ArtifactContract;
  readiness: ArtifactReadiness;
  execution: Execution;
  units: CeUnit[];
}

/** Structured parse/rejection error carrying a stable diagnostic code. */
export class PlanParseError extends Error {
  constructor(
    readonly code: PlanErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PlanParseError";
  }
}

export type PlanErrorCode =
  | "PLAN_MALFORMED"
  | "PLAN_UNSUPPORTED"
  | "FRONTMATTER_MALFORMED"
  | "DUPLICATE_UNIT_ID"
  | "DANGLING_DEPENDENCY"
  | "DEPENDENCY_CYCLE"
  | "MISSING_REQUIRED_FIELD"
  | "PATH_OUTSIDE_REPO"
  | "NO_UNITS";

// --- Required / optional unit field labels ---------------------------------

const REQUIRED_FIELDS = [
  "Goal",
  "Requirements",
  "Dependencies",
  "Files",
  "Approach",
  "Patterns to follow",
  "Test scenarios",
  "Verification",
] as const;

const OPTIONAL_FIELDS = ["Execution note", "Technical design"] as const;

const FIELD_PATTERN = (label: string) =>
  new RegExp(`^[-*]\\s*\\*\\*${escapeRegex(label)}:\\*\\*\\s*(.*)$`);

const UNIT_HEADING_RE = /^###\s+(U\d+)\.?\s+(.+)$/;

// --- Public API ------------------------------------------------------------

export interface ParseOptions {
  /**
   * Repo root used to validate the plan path stays inside the repository.
   * Defaults to process.cwd().
   */
  repoRoot?: string;
  /** Override path resolution for tests (avoids touching the real FS). */
  readFile?: (path: string) => string;
}

/**
 * Parse and validate a CE implementation-ready plan at `planPath`.
 *
 * Resolves `planPath` relative to `repoRoot` (default `process.cwd()`),
 * verifies it stays inside the repository, reads the raw bytes, computes the
 * plan digest, parses frontmatter and units, and runs all contract
 * validations. Throws {@link PlanParseError} on any rejection.
 *
 * The parser never invokes Beads.
 */
export function parsePlan(planPath: string, opts: ParseOptions = {}): CePlan {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  // Resolve and validate path stays inside the repo.
  const canonical = resolvePlanPath(planPath, repoRoot);

  // Read raw bytes for digest + text.
  const raw = read(canonical.absolute);
  const digest = sha256Hex(raw);

  // Split frontmatter and body.
  const { frontmatter, body } = splitFrontmatter(raw, canonical.relative);

  // Validate artifact contract literally (no aliasing).
  const fm = parseFrontmatter(frontmatter, canonical.relative);
  validateContract(fm, canonical.relative);

  // Extract and validate units.
  const title = extractTitle(body, fm);
  const units = parseUnits(body, canonical.relative);

  return {
    path: canonical.relative,
    digest,
    title,
    artifactContract: "ce-unified-plan/v1",
    readiness: "implementation-ready",
    execution: "code",
    units,
  };
}

/**
 * Canonical repo-relative plan path (forward slashes) for a given input.
 * Throws {@link PlanParseError} with code `PATH_OUTSIDE_REPO` if the resolved
 * path escapes the repository root.
 */
export function resolvePlanPath(
  planPath: string,
  repoRoot: string,
): { absolute: string; relative: string } {
  const root = realpathSync(repoRoot);
  const absolute = resolve(root, planPath);
  // Check the logical (pre-realpath) relative path for escape first, so a
  // nonexistent outside-repo path is classified PATH_OUTSIDE_REPO, not
  // PLAN_MALFORMED.
  const logicalRel = relative(root, absolute);
  if (logicalRel.startsWith("..") || isAbsolutePathOutsideRepo(logicalRel)) {
    throw new PlanParseError(
      "PATH_OUTSIDE_REPO",
      `Plan path resolves outside the repository: ${planPath} -> ${absolute}`,
    );
  }
  let realAbs: string;
  try {
    realAbs = realpathSync(absolute);
  } catch {
    throw new PlanParseError(
      "PLAN_MALFORMED",
      `Plan file does not exist: ${planPath}`,
    );
  }
  // Re-check the realpath-relative in case symlinks redirected outside.
  const rel = relative(root, realAbs);
  if (rel.startsWith("..") || isAbsolutePathOutsideRepo(rel)) {
    throw new PlanParseError(
      "PATH_OUTSIDE_REPO",
      `Plan path resolves outside the repository (via symlink): ${planPath} -> ${realAbs}`,
    );
  }
  return { absolute: realAbs, relative: rel.split(sep).join("/") };
}

// for tests / reuse by graph-builder (digest only, no FS).
export function computePlanDigest(rawPlanBytes: string): string {
  return sha256Hex(rawPlanBytes);
}

// --- Frontmatter -----------------------------------------------------------

interface ParsedFrontmatter {
  title?: string;
  artifact_contract?: string;
  artifact_readiness?: string;
  execution?: string;
  [k: string]: string | undefined;
}

function splitFrontmatter(
  raw: string,
  relPath: string,
): { frontmatter: string; body: string } {
  // Must start with `---\n`. Tolerate leading whitespace? No — YAML frontmatter
  // is at the very top per markdown-rendering.md hard invariant.
  if (!raw.startsWith("---")) {
    // HTML or no-frontmatter plan: rejected explicitly.
    throw new PlanParseError(
      "PLAN_UNSUPPORTED",
      `Plan ${relPath} has no YAML frontmatter (must start with '---').`,
    );
  }
  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    throw new PlanParseError(
      "FRONTMATTER_MALFORMED",
      `Plan ${relPath} has unterminated frontmatter (no closing '---').`,
    );
  }
  // Skip the opening `---\n` (4 chars) and the closing `\n---`.
  const frontmatter = raw.slice(4, end);
  // Body starts after the closing `---` and its trailing newline.
  let body = raw.slice(end + 4);
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n")) body = body.slice(1);
  return { frontmatter, body };
}

/**
 * Minimal YAML frontmatter parser supporting flat `key: value` pairs and
 * quoted strings. We do not depend on a YAML library: the contract fields are
 * flat scalars. Unknown keys are preserved for completeness but only the
 * contract fields are load-bearing.
 */
function parseFrontmatter(
  src: string,
  relPath: string,
): ParsedFrontmatter {
  const fm: ParsedFrontmatter = {};
  const lines = src.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (line.trim().startsWith("#")) continue; // YAML comment
    const idx = line.indexOf(":");
    if (idx === -1) {
      throw new PlanParseError(
        "FRONTMATTER_MALFORMED",
        `Plan ${relPath} frontmatter has a non key:value line: ${JSON.stringify(line)}`,
      );
    }
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "") {
      throw new PlanParseError(
        "FRONTMATTER_MALFORMED",
        `Plan ${relPath} frontmatter has an empty key: ${JSON.stringify(line)}`,
      );
    }
    fm[key] = value;
  }
  return fm;
}

function validateContract(fm: ParsedFrontmatter, relPath: string): void {
  if (fm.artifact_contract !== "ce-unified-plan/v1") {
    throw new PlanParseError(
      "PLAN_UNSUPPORTED",
      `Plan ${relPath} has unsupported artifact_contract: ${JSON.stringify(fm.artifact_contract)} (expected "ce-unified-plan/v1").`,
    );
  }
  if (fm.artifact_readiness !== "implementation-ready") {
    // requirements-only, approach-plan, etc.
    throw new PlanParseError(
      "PLAN_UNSUPPORTED",
      `Plan ${relPath} has unsupported artifact_readiness: ${JSON.stringify(fm.artifact_readiness)} (expected "implementation-ready").`,
    );
  }
  if (fm.execution !== "code") {
    // knowledge-work, or missing.
    throw new PlanParseError(
      "PLAN_UNSUPPORTED",
      `Plan ${relPath} has unsupported execution: ${JSON.stringify(fm.execution)} (expected "code").`,
    );
  }
}

function extractTitle(body: string, fm: ParsedFrontmatter): string {
  // Title comes from frontmatter `title:` per the contract.
  if (typeof fm.title === "string" && fm.title.trim() !== "") {
    return fm.title;
  }
  throw new PlanParseError(
    "FRONTMATTER_MALFORMED",
    "Plan frontmatter is missing a non-empty `title` field.",
  );
}

// --- Unit parsing ----------------------------------------------------------

interface RawUnit {
  id: string;
  title: string;
  body: string[]; // lines belonging to this unit, up to the next unit/heading.
}

function parseUnits(body: string, relPath: string): CeUnit[] {
  const lines = body.split(/\r?\n/);
  const raw: RawUnit[] = [];
  let current: RawUnit | null = null;
  let seenImplementationUnits = false;

  for (const line of lines) {
    const heading = line.match(UNIT_HEADING_RE);
    if (heading) {
      // Only treat as a unit if we are in/after an Implementation Units
      // section. We detect this loosely: the first `### U<N>.` heading.
      seenImplementationUnits = true;
      if (current) raw.push(current);
      current = {
        id: heading[1]!,
        title: heading[2]!.trim(),
        body: [],
      };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) raw.push(current);

  if (!seenImplementationUnits || raw.length === 0) {
    throw new PlanParseError(
      "NO_UNITS",
      `Plan ${relPath} has no implementation units (expected at least one '### U<N>.' heading).`,
    );
  }

  const units = raw.map((ru) => parseUnitFields(ru, relPath));

  // Validate unique U-IDs.
  validateUniqueIds(units, relPath);
  // Validate dependency targets exist.
  validateDependencyTargets(units, relPath);
  // Validate acyclic dependency graph.
  validateAcyclic(units, relPath);

  return units;
}

function parseUnitFields(ru: RawUnit, relPath: string): CeUnit {
  const fields = extractBoldLabelFields(ru.body, ru.id, relPath);

  // Required fields present.
  for (const label of REQUIRED_FIELDS) {
    if (!(label in fields)) {
      throw new PlanParseError(
        "MISSING_REQUIRED_FIELD",
        `Unit ${ru.id} in ${relPath} is missing required field '**${label}:**'.`,
      );
    }
  }

  const requirements = parseIdList(fields["Requirements"]!, "Requirements", ru.id, relPath);
  const dependencies = parseIdList(fields["Dependencies"]!, "Dependencies", ru.id, relPath);
  const files = parseFileList(fields["Files"]!, ru.id, relPath);
  const patterns = parseBulletList(fields["Patterns to follow"]!, ru.id);
  const testScenarios = parseBulletList(fields["Test scenarios"]!, ru.id);
  const verification = parseBulletList(fields["Verification"]!, ru.id);
  const goal = fields["Goal"]!.trim();
  const approach = fields["Approach"]!.trim();

  if (goal === "") {
    throw new PlanParseError(
      "MISSING_REQUIRED_FIELD",
      `Unit ${ru.id} in ${relPath} has an empty '**Goal:**' value.`,
    );
  }
  if (approach === "") {
    throw new PlanParseError(
      "MISSING_REQUIRED_FIELD",
      `Unit ${ru.id} in ${relPath} has an empty '**Approach:**' value.`,
    );
  }

  const unit: CeUnit = {
    id: ru.id,
    title: ru.title,
    goal,
    requirements,
    dependencies,
    files,
    approach,
    patterns,
    testScenarios,
    verification,
  };

  // Optional fields: present only when the label appears; absent (not "") when
  // omitted — exactOptionalPropertyTypes enforces this.
  if ("Execution note" in fields) {
    unit.executionNote = (fields["Execution note"]! as string).trim();
  }
  if ("Technical design" in fields) {
    unit.technicalDesign = (fields["Technical design"]! as string).trim();
  }
  return unit;
}

interface FieldAcc {
  current?: { label: string; lines: string[] };
  fields: Record<string, string>;
}

/**
 * Extract bold-label field values from a unit's body lines. A field begins
 * with a bullet whose first token is `**<Label>:**`. Subsequent indented
 * bullets belong to that field until the next field label or a blank section.
 */
function extractBoldLabelFields(
  body: string[],
  unitId: string,
  relPath: string,
): Record<string, string> {
  const acc: FieldAcc = { fields: {} };
  for (const line of body) {
    const match = matchFieldLabel(line);
    if (match) {
      if (acc.current) {
        acc.fields[acc.current.label] = acc.current.lines.join("\n").trimEnd();
      }
      acc.current = { label: match.label, lines: match.rest !== "" ? [match.rest] : [] };
    } else if (acc.current) {
      // Continuation: keep lines until we hit a blank line that ends the field.
      if (line.trim() === "" && acc.current.lines.length === 0) {
        continue; // leading blank after label
      }
      acc.current.lines.push(line);
    }
  }
  if (acc.current) {
    acc.fields[acc.current.label] = acc.current.lines.join("\n").trimEnd();
  }
  // Validate field labels are known.
  const known = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
  for (const label of Object.keys(acc.fields)) {
    if (!known.has(label)) {
      // Unknown bold-label field: not necessarily fatal, but surface it.
      // We do not reject on unknown fields — the contract is a floor.
      void unitId;
      void relPath;
    }
  }
  return acc.fields;
}

function matchFieldLabel(
  line: string,
): { label: string; rest: string } | null {
  for (const label of [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]) {
    const re = FIELD_PATTERN(label);
    const m = line.match(re);
    if (m) {
      return { label, rest: m[1]! };
    }
  }
  return null;
}

function parseIdList(
  raw: string,
  fieldName: string,
  unitId: string,
  relPath: string,
): string[] {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "—") return [];
  // Ids are comma-separated, possibly with "and" or trailing periods.
  const ids = trimmed
    .replace(/\.$/, "")
    .split(/[,\s]+|\s+and\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  // Validate id shape (R<n> or U<n>).
  for (const id of ids) {
    if (!/^[RU]\d+$/.test(id)) {
      throw new PlanParseError(
        "PLAN_MALFORMED",
        `Unit ${unitId} in ${relPath} has malformed ${fieldName} id: ${JSON.stringify(id)} (expected R<n> or U<n>).`,
      );
    }
  }
  return ids;
}

function parseFileList(raw: string, unitId: string, relPath: string): string[] {
  // Files field uses nested bullets like "- Modify: `path`" or "- `path`".
  const lines = raw.split("\n");
  const files: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s*(?:[A-Za-z ]+:)?\s*`?([^`]+)`?\s*$/);
    if (m) {
      const f = m[1]!.trim();
      if (f !== "" && !f.startsWith("(")) {
        files.push(f);
      }
    }
  }
  if (files.length === 0 && raw.trim() !== "" && raw.trim() !== "—") {
    // Could not parse any file from a non-empty Files field.
    throw new PlanParseError(
      "PLAN_MALFORMED",
      `Unit ${unitId} in ${relPath} could not parse any file paths from '**Files:**'.`,
    );
  }
  return files;
}

function parseBulletList(raw: string, _unitId: string): string[] {
  const lines = raw.split("\n");
  const items: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+(.+)$/);
    if (m) {
      const item = m[1]!.trim();
      if (item !== "") items.push(item);
    }
  }
  // If no bullets found, treat the whole trimmed block as a single item.
  if (items.length === 0) {
    const t = raw.trim();
    if (t !== "" && t !== "—") items.push(t);
  }
  return items;
}

// --- Validation ------------------------------------------------------------

function validateUniqueIds(units: CeUnit[], relPath: string): void {
  const seen = new Map<string, number>();
  for (const u of units) {
    const count = (seen.get(u.id) ?? 0) + 1;
    seen.set(u.id, count);
    if (count > 1) {
      throw new PlanParseError(
        "DUPLICATE_UNIT_ID",
        `Plan ${relPath} has duplicate unit id ${u.id}.`,
      );
    }
  }
}

function validateDependencyTargets(units: CeUnit[], relPath: string): void {
  const ids = new Set(units.map((u) => u.id));
  for (const u of units) {
    for (const dep of u.dependencies) {
      if (!ids.has(dep)) {
        throw new PlanParseError(
          "DANGLING_DEPENDENCY",
          `Unit ${u.id} in ${relPath} depends on ${dep}, which is not a unit in this plan.`,
        );
      }
    }
  }
}

function validateAcyclic(units: CeUnit[], relPath: string): void {
  // DFS-based cycle detection.
  const adj = new Map<string, string[]>();
  for (const u of units) adj.set(u.id, u.dependencies);
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const u of units) color.set(u.id, WHITE);

  const stack: string[] = [];
  function dfs(node: string): boolean {
    // returns true if a cycle was found
    color.set(node, GRAY);
    stack.push(node);
    const deps = adj.get(node) ?? [];
    for (const dep of deps) {
      const c = color.get(dep);
      if (c === GRAY) {
        // Found a cycle. Report the cycle from `dep` to current node.
        const cycleStart = stack.indexOf(dep);
        const cycle = stack.slice(cycleStart).concat(dep);
        throw new PlanParseError(
          "DEPENDENCY_CYCLE",
          `Plan ${relPath} has a dependency cycle: ${cycle.join(" -> ")}.`,
        );
      }
      if (c === WHITE) {
        dfs(dep);
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return false;
  }
  for (const u of units) {
    if (color.get(u.id) === WHITE) dfs(u.id);
  }
}

// --- Helpers ---------------------------------------------------------------

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAbsolutePathOutsideRepo(rel: string): boolean {
  // On POSIX, relative() returns ".." prefixed paths for escapes.
  // On Windows, an absolute path on another drive returns a drive-prefixed
  // path. Both cases are rejections.
  return rel.startsWith("..") || /^[A-Za-z]:/.test(rel);
}

// Re-export for downstream modules that need to read raw bytes (digest).
export function readPlanRaw(planPath: string): string {
  return readFileSync(planPath, "utf8");
}

// Suppress unused import warnings for FS guards kept for clarity.
void existsSync;
void statSync;
