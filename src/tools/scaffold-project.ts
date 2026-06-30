/**
 * scaffold-project — pure, deterministic creation of the workbench plan tree.
 *
 * Mirrors the workbench `create_project` phase: one timestamped directory under
 * docs/plans/ holding the four artifacts (README + the facts/decisions/steps
 * trio), each with status frontmatter the rest of the pipeline advances.
 *
 * No model judgment is involved — this is exactly the kind of scaffolding the
 * small tier must NOT delegate to the model.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface PlanNameInput {
  date: string; // YYYY-MM-DD
  name: string;
  ticket?: string;
}

export interface ScaffoldInput extends PlanNameInput {
  cwd: string;
  gitBranch?: string;
  gitCommit?: string;
}

export interface ScaffoldResult {
  dir: string; // relative to cwd
  created: string[];
  skipped: string[];
}

/**
 * Parse `/wb-project` arguments. A leading TICKET-123 token is treated as the
 * ticket; everything else is the project name.
 */
export function parseProjectArgs(args: string): { ticket?: string; name: string } {
  const trimmed = args.trim();
  const m = trimmed.match(/^([A-Za-z]{2,}-\d+)\s+(.*)$/);
  if (m) return { ticket: m[1], name: m[2].trim() };
  return { name: trimmed };
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function planDirName({ date, name, ticket }: PlanNameInput): string {
  const prefix = ticket ? `${ticket.toUpperCase()}-` : "";
  return `${date}-${prefix}${slugify(name)}`;
}

function frontmatter(fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${body}\n---\n`;
}

function templates(input: ScaffoldInput): Record<string, string> {
  const ticket = input.ticket ? input.ticket.toUpperCase() : "none";
  const common = { title: input.name, created: input.date, ticket };

  return {
    "README.md":
      frontmatter({ ...common, status: "draft" }) +
      `\n# ${input.name}\n\n` +
      (input.gitBranch ? `Branch: \`${input.gitBranch}\`` : "") +
      (input.gitCommit ? ` @ \`${input.gitCommit}\`\n` : input.gitBranch ? "\n" : "") +
      `\nworkbench-pi project. Pipeline artifacts:\n\n` +
      `- [research.md](research.md) — FACTS (draft → in-progress → complete)\n` +
      `- [design.md](design.md) — DECISIONS (draft → ready → implementing → complete)\n` +
      `- [tasks.md](tasks.md) — STEPS (not-started → in-progress → complete)\n`,

    "research.md":
      frontmatter({ title: `${input.name} — Research`, type: "research", status: "draft", created: input.date, ticket }) +
      `\n# ${input.name} — Research\n\n` +
      `> FACTS ONLY. Document what IS, with \`file:line\` references. No opinions, no recommendations.\n\n` +
      `_Populate with \`/wb-research\`._\n`,

    "design.md":
      frontmatter({ title: `${input.name} — Design`, type: "design", status: "draft", created: input.date, ticket }) +
      `\n# ${input.name} — Design\n\n` +
      `> DECISIONS ONLY (WHAT / WHY). No implementation steps.\n\n` +
      `_Populate with \`/wb-design\`._\n`,

    "tasks.md":
      frontmatter({ title: `${input.name} — Tasks`, type: "tasks", status: "not-started", created: input.date, ticket }) +
      `\n# ${input.name} — Tasks\n\n` +
      `> STEPS ONLY. Beads tracks status; checkboxes here are documentation.\n\n` +
      `_Populate with \`/wb-execution\`._\n`,
  };
}

export function scaffoldProject(input: ScaffoldInput): ScaffoldResult {
  const dir = join("docs", "plans", planDirName(input));
  const base = join(input.cwd, dir);
  mkdirSync(base, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];
  for (const [file, content] of Object.entries(templates(input))) {
    const path = join(base, file);
    if (existsSync(path)) {
      skipped.push(file);
    } else {
      writeFileSync(path, content, "utf-8");
      created.push(file);
    }
  }
  return { dir, created, skipped };
}
