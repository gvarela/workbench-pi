/**
 * setup — install the bundled workbench subagents where pi-subagents can find them.
 *
 * @tintinweb/pi-subagents only discovers agents from <cwd>/.pi/agents/ and
 * $PI_CODING_AGENT_DIR/agents/ (default ~/.pi/agent/agents/) — it never scans
 * package directories. So a git-installed workbench-pi must sync its bundled
 * agents/*.md into the global agents dir before the orchestrator can spawn them.
 * `/wb-setup` does that idempotently.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

export interface AgentFile {
  name: string;
  content: string;
}

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function agentsTargetDir(): string {
  return join(getAgentDir(), "agents");
}

/** Pure: decide which agent files need (re)writing vs are already current. */
export function planAgentSync(
  source: AgentFile[],
  existing: Map<string, string>,
): { toWrite: string[]; unchanged: string[] } {
  const toWrite: string[] = [];
  const unchanged: string[] = [];
  for (const f of source) {
    if (existing.get(f.name) === f.content) unchanged.push(f.name);
    else toWrite.push(f.name);
  }
  return { toWrite, unchanged };
}

function readMarkdownDir(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    out.set(name, readFileSync(join(dir, name), "utf-8"));
  }
  return out;
}

/** Thin fs wrapper around planAgentSync. Returns the same plan it executed. */
export function syncAgents(sourceDir: string, targetDir = agentsTargetDir()): { toWrite: string[]; unchanged: string[] } {
  const sourceMap = readMarkdownDir(sourceDir);
  const source: AgentFile[] = [...sourceMap].map(([name, content]) => ({ name, content }));
  const existing = readMarkdownDir(targetDir);
  const plan = planAgentSync(source, existing);

  if (plan.toWrite.length > 0) mkdirSync(targetDir, { recursive: true });
  for (const name of plan.toWrite) {
    writeFileSync(join(targetDir, name), sourceMap.get(name)!, "utf-8");
  }
  return plan;
}
