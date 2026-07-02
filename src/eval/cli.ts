/**
 * eval/cli — score a generated workbench artifact with the deterministic scorers.
 * Free, no model. Universe of real paths comes from `git ls-files` at the repo root
 * of the artifact, so path-grounding is checked against ground truth.
 *
 *   node src/eval/cli.ts <artifact.md>        # human + per-dimension scorecard
 *   EVAL_MIN=0.8 node src/eval/cli.ts <file>  # exit non-zero if overall < 0.8 (gate)
 */

import { readFileSync } from "node:fs";
import { dirname, basename } from "node:path";
import { scorecard, extractCitedPaths } from "./scorers.ts";
import { repoUniverse } from "./repo.ts";

const REQUIRED: Record<string, string[]> = {
  "research.md": ["Locations", "How it works", "patterns"],
  "design.md": ["Decisions"],
  "tasks.md": ["Phase"],
};

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: eval <artifact.md>");
    process.exit(2);
  }
  const md = readFileSync(file, "utf-8");
  const universe = repoUniverse(dirname(file), extractCitedPaths(md));
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
