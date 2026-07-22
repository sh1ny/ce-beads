// worker-prompt.ts — the ce-beads-unit agent body and the initial user prompt
// rendered for the pane.
//
// The agent body is read at runtime from agents/ce-beads-unit.md (single source
// of truth), stripping the YAML frontmatter. This avoids drift between the TS
// constant and the agent file.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerPacket } from "./worker-packet.ts";

/**
 * Read the worker agent body from agents/ce-beads-unit.md, stripping the YAML
 * frontmatter. The agent file is the single source of truth — the TS code
 * never duplicates the prompt text.
 */
export function getWorkerAgentBody(): string {
  // Resolve relative to this module's location, not process.cwd(), so it
  // works when ce-beads is installed as a plugin in a consumer repo
  // (ce-beads-thread-Sya34, P1).
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const agentPath = join(moduleDir, "..", "..", "..", "agents", "ce-beads-unit.md");
  const raw = readFileSync(agentPath, "utf8");
  // Strip YAML frontmatter (--- ... ---) if present.
  const stripped = raw.replace(/^---[\s\S]*?---\s*\n/, "");
  return stripped.trim();
}

/**
 * Render the initial user prompt delivered to the pane. Tells the worker
 * the packet is the unit-of-work and reminds it of the atomic write-to-
 * result-file completion protocol.
 */
export function renderWorkerPrompt(packet: WorkerPacket): string {
  const resultFile = packet.result_file ?? ".ce-beads-worker/result.json";
  return (
    "Implement this bounded ce-beads unit. Your instructions are in your system " +
    "prompt. The packet:\n\n" +
    JSON.stringify(packet, null, 2) +
    "\n\nReminder: write the report to " +
    resultFile +
    " atomically (write-temp-then-rename). The coordinator polls for the file's existence."
  );
}
