/**
 * Tier-aware system-prompt fragments injected via before_agent_start.
 *
 * small     — terse, imperative, names the deterministic commands and the hard
 *             rules the model must not violate. The model is a slot-filler.
 * reasoning — restores the workbench's model-led framing.
 *
 * Kept small here; Phase 6 expands the reasoning fragment with the full rich
 * workbench guidance.
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

Hard rules (enforced by gates):
- Never claim "done/fixed/passing" without running a verification command and showing its output.
- No production code before a failing test exists (Red→Green→Refactor).
- Never reference a file path you have not confirmed exists. Ground paths with the workbench path tool.
- Stay in scope: implement only what the current task/plan specifies.
Keep outputs short and structured. Fill the templates; don't editorialize.`;

const REASONING = `## workbench-pi (tier: reasoning)
You run the workbench research→design→execution→implement workflow.

Maintain strict separation: research.md = FACTS (file:line refs, no opinions), design.md = DECISIONS (what/why), tasks.md = STEPS. Fan out read-only research subagents in parallel and synthesize their findings yourself. Use beads as the persistent status truth. Verify before claiming done; follow TDD; avoid scope creep. Commands: /wb-project, /wb-research, /wb-design, /wb-execution, /wb-implement, /wb-validate.`;

export function systemPromptFragment(tier: Tier): string {
  return tier === "reasoning" ? REASONING : SMALL;
}
