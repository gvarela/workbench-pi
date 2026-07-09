/**
 * backpressure — run-silent semantics ("success = ✓, failure = full output")
 * enforced deterministically on small-tier bash results, so the discipline can't
 * be lost to context truncation or a model that forgets the instruction.
 *
 * Measured motivation: a live implement session spent 64% of its 32k window on
 * bash tool results. The decision table needs two signals the tool_result hook
 * already has — the exit state (isError) and the command's INTENT:
 *
 *   verification command (tests/build/lint), succeeded → collapse to ✓ + tail
 *     (its payload is the verdict; the summary line prints last)
 *   verification command, failed                       → keep detail, capped
 *     (the RED step must see WHY the test failed)
 *   information command (grep/cat/ls/…), any exit      → output IS the answer:
 *     keep, but cap huge results head+tail
 *
 * Capable tier is never touched. Pure; the tool_result hook in index.ts wires it.
 */

import { isVerificationCommand } from "./gates.ts";
import type { Tier } from "./tier.ts";

/** Results at or under this size always pass through untouched. */
const KEEP_MAX = 4_000;
/** Green verification output above this collapses to ✓ + tail. */
const VERIFY_KEEP_MAX = 400;
/** Tail lines kept on a collapsed green verification (summary counts print last). */
const VERIFY_TAIL_LINES = 10;
/** Head/tail budgets when capping. Failures get a deeper tail — errors print last. */
const HEAD = 1_500;
const FAIL_TAIL = 3_500;
const INFO_TAIL = 1_500;

const TIP =
  "workbench-pi: output elided to save context — run TARGETED commands (a single spec file, grep for the line you need, `tail -40`) when you need more detail.";

/**
 * Returns the replacement text for a bash tool result, or undefined to leave the
 * result untouched.
 */
export function bashBackpressure(tier: Tier, command: string, isError: boolean, text: string): string | undefined {
  if (tier !== "small") return undefined;

  if (!isError && isVerificationCommand(command)) {
    if (text.length <= VERIFY_KEEP_MAX) return undefined;
    const tail = text.trimEnd().split("\n").slice(-VERIFY_TAIL_LINES).join("\n");
    return `✓ verification passed (exit 0): \`${firstLine(command)}\`\nOutput collapsed; last ${VERIFY_TAIL_LINES} lines:\n${tail}\n\n${TIP}`;
  }

  if (text.length <= KEEP_MAX) return undefined;
  const tailBudget = isError ? FAIL_TAIL : INFO_TAIL;
  const elided = text.length - HEAD - tailBudget;
  return `${text.slice(0, HEAD)}\n…[${elided} chars elided]…\n${text.slice(-tailBudget)}\n\n${TIP}`;
}

function firstLine(command: string): string {
  const line = command.split("\n")[0].trim();
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}
