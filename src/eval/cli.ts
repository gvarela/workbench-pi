/**
 * eval/cli — score a generated workbench artifact with the deterministic scorers.
 * Free, no model. Universe of real paths comes from `git ls-files` at the repo root
 * of the artifact, so path-grounding is checked against ground truth.
 *
 *   node src/eval/cli.ts <artifact.md>        # human + per-dimension scorecard
 *   EVAL_MIN=0.8 node src/eval/cli.ts <file>  # exit non-zero if overall < 0.8 (gate)
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, basename, join } from "node:path";
import { scorecard, extractCitedPaths } from "./scorers.ts";

const REQUIRED: Record<string, string[]> = {
  "research.md": ["Locations", "How it works", "patterns"],
  "design.md": ["Decisions"],
  "tasks.md": ["Phase"],
};

function repoRoot(dir: string): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
  } catch {
    return undefined;
  }
}

function git(root: string, args: string[]): string[] {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Universe of "real" paths: tracked + untracked-visible files, PLUS any cited path
 * that actually exists on disk (covers legitimately gitignored-but-real files, so
 * grounding measures hallucination, not gitignore status).
 */
function buildUniverse(dir: string, md: string): string[] {
  const root = repoRoot(dir);
  if (!root) return [];
  const set = new Set([...git(root, ["ls-files"]), ...git(root, ["ls-files", "--others", "--exclude-standard"])]);
  for (const p of extractCitedPaths(md)) {
    if (existsSync(join(root, p))) set.add(p);
  }
  return [...set];
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: eval <artifact.md>");
    process.exit(2);
  }
  const md = readFileSync(file, "utf-8");
  const universe = buildUniverse(dirname(file), md);
  const card = scorecard(md, { universe, requiredHeadings: REQUIRED[basename(file)] ?? [] });

  const pct = (n: number) => `${Math.round(n * 100)}%`;
  console.log(`Scorecard: ${file}`);
  console.log(`  path-grounding   ${pct(card.pathGrounding.score)}  (${card.pathGrounding.grounded}/${card.pathGrounding.cited} cited paths real)`);
  console.log(`  facts-only       ${pct(card.factsOnly.score)}  (${card.factsOnly.violations} opinion markers)`);
  console.log(`  template         ${pct(card.templateConformance.score)}  (${card.templateConformance.present}/${card.templateConformance.required} headings)`);
  console.log(`  placeholders     ${pct(card.placeholders.score)}  (${card.placeholders.leftover} leftover)`);
  console.log(`  OVERALL          ${pct(card.overall)}`);

  const min = Number.parseFloat(process.env.EVAL_MIN ?? "0");
  if (card.overall < min) {
    console.error(`FAIL: overall ${pct(card.overall)} < EVAL_MIN ${pct(min)}`);
    process.exit(1);
  }
}

main();
