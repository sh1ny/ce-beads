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

/**
 * One row from a plan-level Verification Contract table (R8).
 *
 * `unit_id` is the U-ID the row applies to (a row may apply to multiple
 * U-IDs and is fanned out into one entry per U-ID); `command` is the
 * shell command the coordinator runs pre- and post-merge for that unit;
 * `expected` is the optional free-form "Proves" / "Expected" text from
 * the table (never executed).
 */
export interface VerificationEntry {
  unit_id: string;
  command: string;
  expected?: string;
}

/** A parsed requirement definition (R-ID -> text). */
export interface RequirementDefinition {
  id: string;
  text: string;
}

/** A parsed key technical decision, identified by KTD-ID. */
export interface KtdDefinition {
  id: string;
  text: string;
}

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
  /**
   * Key technical decisions (KTDs) excerpted for this unit, selected by
   * matching R-IDs that appear in the decision text against the unit's
   * `requirements`. Empty when no KTD references apply.
   */
  ktd_excerpts: { id: string; text: string }[];
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
  /**
   * Parsed Verification Contract table (R8). Each row is fanned out so
   * one entry exists per U-ID the row applies to. Empty when the plan has
   * no Verification Contract table, in which case pre-merge verification
   * is a no-op pass for every unit.
   */
  verification_commands: VerificationEntry[];
  /**
   * Parsed requirement definitions (R-ID -> text) from the Product
   * Contract's `### Requirements` section. Empty when missing.
   */
  requirement_defs: RequirementDefinition[];
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
  // Parse plan-level sections once (R8).
  const ktds = parseKtdDefinitions(body);
  const requirementDefs = parseRequirementDefinitions(body);
  const verificationCommands = parseVerificationContract(body);

  // Extract and validate units. KTDs are threaded into parseUnits so each
  // unit's `ktd_excerpts` is selected from the plan-level KTD list using its
  // own `requirements`.
  const title = extractTitle(body, fm);
  const units = parseUnits(body, ktds, canonical.relative);

  return {
    path: canonical.relative,
    digest,
    title,
    artifactContract: "ce-unified-plan/v1",
    readiness: "implementation-ready",
    execution: "code",
    units,
    verification_commands: verificationCommands,
    requirement_defs: requirementDefs,
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

function parseUnits(
  body: string,
  ktds: KtdDefinition[],
  relPath: string,
): CeUnit[] {
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

  const units = raw.map((ru) => parseUnitFields(ru, ktds, relPath));

  // Validate unique U-IDs.
  validateUniqueIds(units, relPath);
  // Validate dependency targets exist.
  validateDependencyTargets(units, relPath);
  // Validate acyclic dependency graph.
  validateAcyclic(units, relPath);

  return units;
}

function parseUnitFields(
  ru: RawUnit,
  ktds: KtdDefinition[],
  relPath: string,
): CeUnit {
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
    ktd_excerpts: selectKtdExcerptsForUnit(
      {
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
        ktd_excerpts: [],
      },
      ktds,
    ),
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

// --- Plan-level extraction (R8) ------------------------------------------

/**
 * Index a markdown body by H2 (`## `) and H3 (`### `) headings so callers can
 * look up a section's lines without scanning the document each time. Empty
 * when the heading is missing. Section H2 lines are returned verbatim so
 * callers can detect the end of one section and the start of the next.
 */
interface MarkdownSection {
  /** Heading line as it appears in the body (e.g. "## Product Contract"). */
  heading: string;
  /** Heading level: 2 for H2, 3 for H3. */
  level: 2 | 3;
  /** Lines AFTER the heading, up to (not including) the next H2/H3. */
  body: string[];
}

function splitMarkdownSections(body: string): MarkdownSection[] {
  const lines = body.split(/\r?\n/);
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | null = null;
  for (const line of lines) {
    const h2 = line.match(/^##\s+(?!#)(.+?)\s*$/);
    const h3 = line.match(/^###\s+(?!#)(.+?)\s*$/);
    if (h2) {
      if (current) sections.push(current);
      current = { heading: line, level: 2, body: [] };
      continue;
    }
    if (h3) {
      if (current) sections.push(current);
      current = { heading: line, level: 3, body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) sections.push(current);
  return sections;
}

function findH2(sections: MarkdownSection[], headingRe: RegExp): MarkdownSection | null {
  for (const s of sections) {
    if (s.level === 2 && headingRe.test(s.heading)) return s;
  }
  return null;
}

/**
 * Find an H3 section inside an H2 parent. `parentHeadingRe` is required
 * (callers always constrain scope) so the function cannot accidentally
 * match a duplicate H3 in a different top-level section.
 */
function findSection(
  sections: MarkdownSection[],
  headingRe: RegExp,
  parentHeadingRe: RegExp,
): MarkdownSection | null {
  let insideParent = false;
  for (const s of sections) {
    if (s.level === 2) {
      insideParent = parentHeadingRe.test(s.heading);
      continue;
    }
    if (s.level === 3 && insideParent && headingRe.test(s.heading)) {
      return s;
    }
  }
  return null;
}

/**
 * Parse a block of `- <ID>. text...` bullets where `<ID>` matches
 * `R\d+`, `KTD\d+`, or `U\d+`. Continuation lines that are not
 * themselves bullets belong to the previous bullet until the next bullet
 * or a blank line. Sub-category bold paragraphs (e.g.
 * `**Parsing and validation**`) are silently ignored because they do not
 * match the bullet regex.
 */
function parseIdBulletBlock(body: string[]): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  let current: { id: string; text: string[] } | null = null;
  const flush = (): void => {
    if (current === null) return;
    const text = current.text.join("\n").replace(/\s+/g, " ").trim();
    if (current.id !== "" && text !== "") {
      out.push({ id: current.id, text });
    }
    current = null;
  };
  for (const raw of body) {
    const line = raw.trim();
    if (line === "") {
      // Blank line ends the current bullet but keeps the accumulator so we
      // can pick up the next bullet after category headers like
      // "**Parsing and validation**".
      flush();
      continue;
    }
    const m = line.match(/^[-*]\s+(.+)$/);
    if (m) {
      const inner = m[1] ?? "";
      const idm = inner.match(/^((?:KTD|R|U)\d+)\.\s*(.*)$/);
      flush();
      if (idm && idm[1]) {
        current = { id: idm[1], text: idm[2] ? [idm[2]] : [] };
      }
      continue;
    }
    if (current) {
      current.text.push(line);
    }
  }
  flush();
  return out;
}

/**
 * Extract R-ID -> text definitions from `## Product Contract` ->
 * `### Requirements`. Empty when either is missing. Tolerates sub-category
 * bold paragraphs (e.g. `**Parsing and validation**`) interleaved between
 * bullets.
 */
function parseRequirementDefinitions(body: string): RequirementDefinition[] {
  const sections = splitMarkdownSections(body);
  const requirements = findSection(
    sections,
    /^###\s+Requirements\s*$/i,
    /^##\s+Product Contract\s*$/i,
  );
  if (!requirements) return [];
  return parseIdBulletBlock(requirements.body);
}

/**
 * Extract KTD-ID -> text from `## Planning Contract` ->
 * `### Key Technical Decisions`. Empty when either is missing.
 */
function parseKtdDefinitions(body: string): KtdDefinition[] {
  const sections = splitMarkdownSections(body);
  const ktds = findSection(
    sections,
    /^###\s+Key Technical Decisions\s*$/i,
    /^##\s+Planning Contract\s*$/i,
  );
  if (!ktds) return [];
  return parseIdBulletBlock(ktds.body);
}

/**
 * Select the KTDs relevant to a unit by intersecting each KTD's referenced
 * R-IDs (e.g. `KTD10's text mentions "R10"`) against the unit's
 * `requirements`. If a unit has no requirements, no KTDs are selected.
 */
function selectKtdExcerptsForUnit(
  unit: CeUnit,
  ktds: KtdDefinition[],
): { id: string; text: string }[] {
  if (ktds.length === 0 || unit.requirements.length === 0) return [];
  const want = new Set(unit.requirements);
  const result: { id: string; text: string }[] = [];
  for (const k of ktds) {
    // Splitting on word boundaries avoids matching "R1" inside "R10" or
    // random "R" characters; KTDs reference R-IDs with plain ASCII digits.
    const refs = new Set(k.text.match(/\bR\d+\b/g) ?? []);
    let hits = 0;
    for (const id of want) {
      if (refs.has(id)) hits++;
    }
    if (hits > 0) result.push({ id: k.id, text: k.text });
  }
  return result;
}

/**
 * Parse a markdown table. Returns the header (lower-cased, trimmed) and the
 * rows (each as trimmed cells). Returns `null` when no table is found.
 * Tolerates the optional leading `|` and trailing `|` common in GFM.
 */
function parseMarkdownTable(
  body: string[],
): { header: string[]; rows: string[][] } | null {
  let i = 0;
  // Skip blank lines above the table.
  while (i < body.length && body[i]?.trim() === "") i++;
  if (i >= body.length) return null;
  const headerLine = body[i];
  const sepLine = body[i + 1];
  if (
    headerLine === undefined ||
    sepLine === undefined ||
    !/^\s*\|.*\|\s*$/.test(headerLine) ||
    !/^\s*\|?\s*:?-{3,}/.test(sepLine)
  ) {
    return null;
  }
  const splitRow = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  const header = splitRow(headerLine).map((h) => h.toLowerCase());
  const rows: string[][] = [];
  let j = i + 2;
  while (j < body.length) {
    const line = body[j];
    if (line === undefined) break;
    if (!/^\s*\|.*\|\s*$/.test(line)) break;
    rows.push(splitRow(line));
    j++;
  }
  return { header, rows };
}

/**
 * Parse the plan-level `## Verification Contract` table (R8) into typed
 * entries. Rows are fanned out by comma-separated U-IDs. Empty when the
 * section is missing or contains no table.
 */
function parseVerificationContract(body: string): VerificationEntry[] {
  const sections = splitMarkdownSections(body);
  const vc = findH2(sections, /^##\s+Verification Contract\s*$/i);
  if (!vc) return [];
  const table = parseMarkdownTable(vc.body);
  if (!table) return [];
  const { header, rows } = table;
  const uIdIdx = header.findIndex((h) => /^(u-?id|unit|units|for|applies(\s*to)?)$/i.test(h));
  const cmdIdx = header.findIndex((h) =>
    /^(command|procedure|test|test\s+command|command\s*\/\s*procedure)$/i.test(h),
  );
  const expIdx = header.findIndex((h) =>
    /^(proves|expected|expected\s+output|should\s+produce|gate)$/i.test(h),
  );
  if (uIdIdx === -1 || cmdIdx === -1) return [];
  const out: VerificationEntry[] = [];
  for (const row of rows) {
    const uRaw = row[uIdIdx] ?? "";
    const cmd = row[cmdIdx] ?? "";
    if (uRaw.trim() === "" || cmd.trim() === "") continue;
    const expected = expIdx === -1 ? undefined : (row[expIdx] ?? "").trim();
    const uIds = uRaw
      .split(/[,\s]+|\s+and\s+/i)
      .map((s) => s.trim())
      .filter((s) => /^U\d+$/.test(s));
    if (uIds.length === 0) continue;
    const baseExpected = expected !== undefined && expected !== "" ? expected : undefined;
    for (const uId of uIds) {
      if (baseExpected === undefined) {
        out.push({ unit_id: uId, command: cmd.trim() });
      } else {
        out.push({ unit_id: uId, command: cmd.trim(), expected: baseExpected });
      }
    }
  }
  return out;
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
