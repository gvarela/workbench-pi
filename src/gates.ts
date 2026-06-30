/**
 * gates — pure predicates for the discipline gates that arm during /wb-implement.
 *
 * Two disciplines, enforced as blocking decisions (with an escape hatch upstream):
 *  - no claim of "done/passing/fixed" without an observed verification run (claimGate)
 *  - no write to a SOURCE file without a failing test first — Red before Green (writeGate)
 *
 * State (was a verification run observed? did a test fail?) is tracked by the
 * tool_result hook in index.ts; here we keep only the pure decisions so they're
 * trivially testable.
 */

const VERIFY_RE =
  /\b(npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|node\s+--test|pytest|jest|vitest|mocha|go\s+test|cargo\s+test|make\s+test|tsc|typecheck|eslint|\blint\b|rspec|phpunit)\b/i;

const CLAIM_RE =
  /\b(it works|works now|all (the )?tests?\s+pass|tests?\s+(now\s+)?pass(ing|es)?|fixed|done|complete[d]?|all green|passing now|no (more )?errors)\b/i;

const TEST_PATH_RE = /(\.test\.|\.spec\.|_test\.|(^|\/)tests?\/|(^|\/)__tests__\/)/i;
const CODE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|cs|swift|kt|scala)$/i;

export function isVerificationCommand(cmd: string): boolean {
  return VERIFY_RE.test(cmd);
}

export function isClaimOfDone(text: string): boolean {
  return CLAIM_RE.test(text);
}

export function isTestFile(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

export function isSourceFile(path: string): boolean {
  return CODE_EXT_RE.test(path) && !isTestFile(path);
}

export interface GateDecision {
  block: boolean;
  reason?: string;
}

/** Block a "done" claim unless a verification command was observed this turn. */
export function claimGate(text: string, verifiedThisTurn: boolean): GateDecision {
  if (isClaimOfDone(text) && !verifiedThisTurn) {
    return {
      block: true,
      reason:
        "workbench-pi: don't claim success without evidence. Run the tests/build first (or /wb-override to bypass).",
    };
  }
  return { block: false };
}

/** Block a source-file write unless a failing test has been observed (Red→Green). */
export function writeGate(path: string, failingTestObserved: boolean): GateDecision {
  if (isSourceFile(path) && !failingTestObserved) {
    return {
      block: true,
      reason:
        "workbench-pi: write a failing test before production code (Red→Green). Add/run a failing test first (or /wb-override to bypass).",
    };
  }
  return { block: false };
}
