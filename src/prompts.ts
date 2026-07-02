/**
 * Tier-aware prompting.
 *
 * small   — terse, imperative; names the deterministic commands and the hard
 *           rules. The model is a slot-filler; the extension owns control flow.
 * capable — restores the workbench's model-led framing and full disciplines for a
 *           capable model. The model leads; the extension scaffolds.
 *
 * The capable-tier commands that delegate to the model (research, design) build
 * their instruction text from the pure builders below so they're unit-testable.
 */

import type { Tier } from "./tier.ts";

const SMALL = `## workbench-pi (tier: small)
You run a strict, scaffolded engineering workflow. The extension owns control flow — follow it; do not improvise.

Pipeline (each writes ONE artifact, consumed by the next):
- /wb-project — scaffold docs/plans/<date-ticket-name>/ (README, research, design, tasks)
- /wb-research  → research.md (FACTS ONLY: what IS, with file:line refs; no opinions)
- /wb-design    → design.md (DECISIONS ONLY: what/why; no implementation steps)
- /wb-execution → tasks.md + beads issues (STEPS ONLY)
- /wb-implement — coordinated TDD workers, one task at a time
- /wb-validate  — verify against the plan

Hard rules (the discipline gates enforce these during /wb-implement; follow them always):
- Never claim "done/fixed/passing" without running a verification command and showing its output.
- No production code before a failing test exists (Red→Green→Refactor).
- Never reference a file path you have not confirmed exists. Ground paths with the workbench path tool.
- Stay in scope: implement only what the current task/plan specifies.

Editing files (edit fails when oldText doesn't match byte-for-byte):
- Before edit, grep -n a short unique anchor phrase, then re-read that exact region with read (offset/limit). NEVER reconstruct file content from memory or from your own prior summary.
- Keep oldText to a single line when possible.
- On the first mismatch, STOP retrying blindly — shrink the anchor and re-read before trying again.
- For pure line-based changes (e.g. toggling a checkbox), prefer sed with explicit line numbers over edit's exact match.

Keep outputs short and structured. Fill the templates; don't editorialize.`;

const CAPABLE = `## workbench-pi (tier: capable)
You run the workbench research → design → execution → implement workflow on a capable model. You lead; the extension scaffolds.

Maintain STRICT separation of artifacts (this is the core discipline):
- research.md = FACTS ONLY — what IS, every claim carrying a verified file:line reference. No opinions, no recommendations, no "should".
- design.md   = DECISIONS — WHAT and WHY. No implementation steps.
- tasks.md    = STEPS — phased, ordered, testable. Beads tracks status; checkboxes are documentation.

Disciplines:
- Fan out read-only research subagents in parallel (the Agent tool), then synthesize their findings YOURSELF into a coherent document — no placeholders, no "TODO", no delegated synthesis.
- Ground every path before you cite it; never invent file paths or line numbers (wb_verify_paths checks them).
- Beads (bd) is the persistent status truth: the markdown is the plan, beads is the status. Keep them in sync.
- Verify before claiming done — run the tests/build and show the output. "Should work" is not acceptable.
- TDD for implementation: a failing test before production code. No scope creep — implement only what the task specifies.
- Don't rush past incomplete context: research before designing, design before planning, plan before implementing.

Commands: /wb-project, /wb-research, /wb-design, /wb-execution, /wb-implement, /wb-validate.`;

export function systemPromptFragment(tier: Tier): string {
  return tier === "capable" ? CAPABLE : SMALL;
}

/**
 * Corrective tip appended at the point of an edit failure — reinforcement exactly
 * when it's needed, instead of repeating the rule every turn. Qwen-specific: only
 * the small tier struggles with reconstructing-from-memory edits; capable models
 * don't need it. Returns undefined unless (tier=small AND tool=edit AND it failed).
 */
export function editFailureTip(tier: Tier, toolName: string, isError: boolean): string | undefined {
  if (tier !== "small" || toolName !== "edit" || !isError) return undefined;
  return (
    "workbench-pi: edit failed. Do NOT retry from memory — grep -n a short unique anchor, " +
    "re-read that exact region with read (offset/limit), then edit with oldText copied verbatim " +
    "(one line if possible). For line-based changes, use sed with explicit line numbers instead."
  );
}

/** Capable-tier /wb-research: instruct the model to research and synthesize research.md itself. */
export function researchDelegationPrompt(topic: string, planDir: string): string {
  return (
    `Research the codebase for "${topic}" and write docs/plans/${planDir}/research.md.\n` +
    `- Fan out read-only subagents in parallel (the Agent tool) to find WHERE things live and HOW they work.\n` +
    `- Synthesize their findings YOURSELF into research.md: FACTS ONLY, every claim carrying a file:line reference you verified. No opinions, no recommendations, no placeholders.\n` +
    `- Preserve the file's frontmatter and set its status to "complete" when done.`
  );
}

/** Capable-tier /wb-design: model-led design discussion → design.md. */
export function designDelegationPrompt(topic: string, planDir: string): string {
  return (
    `Lead an interactive design discussion for "${topic}". Read docs/plans/${planDir}/research.md first.\n` +
    `Then write WHAT/WHY decisions (no implementation steps) to docs/plans/${planDir}/design.md and set its frontmatter status to "ready".`
  );
}
