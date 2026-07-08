/**
 * context-pack — deterministic context provisioning for implement workers.
 *
 * A less capable worker doesn't need more freedom; it needs the answers to the
 * questions it's bad at answering handed to it up front: what EXACTLY is this task
 * (full bead detail, not just the title), HOW do I run tests here (runbook), and
 * WHERE are the project rules (AGENTS.md is stripped from replace-mode subagents,
 * so the orchestrator must inject it). All pure; adapters read fs/bd in index.ts.
 */

export interface BeadDetail {
  id: string;
  title: string;
  description?: string;
  notes?: string;
  design?: string;
}

/** Parse `bd show <id> --json` output (a single object or a one-element array). */
export function parseBeadDetail(jsonStr: string): BeadDetail | undefined {
  let data: unknown;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    return undefined;
  }
  const o = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!o || typeof o !== "object" || typeof o.id !== "string" || typeof o.title !== "string") return undefined;
  const detail: BeadDetail = { id: o.id, title: o.title };
  for (const k of ["description", "notes", "design"] as const) {
    if (typeof o[k] === "string" && (o[k] as string).trim()) detail[k] = o[k] as string;
  }
  return detail;
}

export interface RunbookMarkers {
  /** Explicit command (e.g. tasks.md frontmatter `test_command:`) — always wins. */
  explicit?: string;
  /** mise.toml / .mise.toml / .tool-versions present → prefix tool runs with mise. */
  mise: boolean;
  gemfile: boolean;
  specDir: boolean;
  /** package.json has a scripts.test entry. */
  pkgTestScript?: boolean;
}

/** Deterministically resolve how to run this project's tests, if knowable. */
export function detectTestCommand(m: RunbookMarkers): string | undefined {
  if (m.explicit?.trim()) return m.explicit.trim();
  const prefix = m.mise ? "mise exec -- " : "";
  if (m.gemfile && m.specDir) return `${prefix}bundle exec rspec`;
  if (m.pkgTestScript) return `${prefix}npm test`;
  return undefined;
}

export function extractTestCommandFromFrontmatter(md: string): string | undefined {
  const m = md.match(/^test_command:\s*["'`]?(.+?)["'`]?\s*$/m);
  return m ? m[1] : undefined;
}

export interface ContextPackInput {
  task: BeadDetail;
  testCommand?: string;
  /** Project instructions file; include content when small, else workers read the path. */
  agentsMd?: { path: string; content?: string };
  planDir?: string;
}

const MAX_DESC = 3000;

/** Compose the context pack prepended to every worker/verifier prompt. */
export function buildContextPack(i: ContextPackInput): string {
  const parts: string[] = [`## Task ${i.task.id}: ${i.task.title}`];
  for (const [label, text] of [
    ["", i.task.description],
    ["Notes", i.task.notes],
    ["Design", i.task.design],
  ] as const) {
    if (text) parts.push(label ? `${label}: ${truncate(text)}` : truncate(text));
  }

  parts.push("", "## Project execution");
  parts.push(
    i.testCommand
      ? `Run tests with: \`${i.testCommand}\` (append a file path to run a single spec). Use this EXACT command — do not improvise another way.`
      : "Test command unknown — check AGENTS.md / README / CI config to discover it BEFORE running tests.",
    "Run TARGETED spec files for the code you touched — the full suite may take many minutes. If you must run a long command, set a GENEROUS bash timeout (e.g. 1800 seconds); a short timeout on a test suite guarantees a false failure.",
  );
  if (i.agentsMd) {
    parts.push(
      i.agentsMd.content
        ? `Project instructions (${i.agentsMd.path}):\n${truncate(i.agentsMd.content)}`
        : `Project instructions live in ${i.agentsMd.path} — read it FIRST; it governs tooling.`,
    );
  }
  if (i.planDir) {
    parts.push("", `## Plan context`, `Plan docs: ${i.planDir}/{research,design,tasks}.md — read design.md if you need the WHY.`);
  }
  return parts.join("\n");
}

function truncate(s: string): string {
  const t = s.trim();
  return t.length > MAX_DESC ? `${t.slice(0, MAX_DESC)}\n…(truncated)` : t;
}
