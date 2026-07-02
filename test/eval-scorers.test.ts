import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractCitedPaths,
  scorePathGrounding,
  scoreFactsOnly,
  scoreTemplateConformance,
  scorePlaceholders,
  scorecard,
} from "../src/eval/scorers.ts";

test("extractCitedPaths grabs backticked paths, strips :line, ignores non-paths", () => {
  const md = "See `src/index.ts:10` and `src/tier.ts`. Run `npm test`. Read `README.md`. Also `foo`.";
  assert.deepEqual(extractCitedPaths(md).sort(), ["README.md", "src/index.ts", "src/tier.ts"]);
});

test("extractCitedPaths strips line ranges (ascii and en/em dash) and dedupes", () => {
  const md = "`src/tier.ts:18`, `src/tier.ts:20–30`, `src/tier.ts:32-37`, `a.ts:1—5`";
  assert.deepEqual(extractCitedPaths(md).sort(), ["a.ts", "src/tier.ts"]);
});

test("scorePathGrounding scores cited-paths-that-exist over total cited", () => {
  const universe = ["src/index.ts", "src/tier.ts", "README.md"];
  const good = scorePathGrounding("`src/index.ts` and `src/tier.ts`", universe);
  assert.equal(good.cited, 2);
  assert.equal(good.grounded, 2);
  assert.equal(good.score, 1);

  const mixed = scorePathGrounding("`src/index.ts` and `src/nope.ts`", universe);
  assert.equal(mixed.cited, 2);
  assert.equal(mixed.grounded, 1);
  assert.equal(mixed.score, 0.5);

  assert.equal(scorePathGrounding("no paths here", universe).score, 1); // N/A → 1
});

test("scoreFactsOnly penalizes opinion/recommendation language", () => {
  assert.equal(scoreFactsOnly("The function returns x (`a.ts`).").violations, 0);
  assert.equal(scoreFactsOnly("The function returns x (`a.ts`).").score, 1);
  const op = scoreFactsOnly("We should refactor this. It's better to use Y.");
  assert.ok(op.violations >= 2);
  assert.ok(op.score < 1);
});

test("scoreTemplateConformance measures required headings present", () => {
  const md = "## Locations (wb-locator)\n- a\n## How it works (wb-analyzer)\n- b";
  assert.equal(scoreTemplateConformance(md, ["Locations", "How it works"]).score, 1);
  assert.equal(scoreTemplateConformance(md, ["Locations", "Missing"]).score, 0.5);
});

test("scorePlaceholders penalizes leftover scaffolding", () => {
  assert.equal(scorePlaceholders("real content").score, 1);
  const ph = scorePlaceholders("_(no findings)_\n_Populate with `/wb-research`._");
  assert.ok(ph.leftover >= 2);
  assert.ok(ph.score < 1);
});

test("scorecard aggregates the dimensions into an overall score", () => {
  const md = "## Locations (wb-locator)\n- `src/index.ts` returns the thing.";
  const card = scorecard(md, { universe: ["src/index.ts"], requiredHeadings: ["Locations"] });
  assert.equal(card.pathGrounding.score, 1);
  assert.equal(card.templateConformance.score, 1);
  assert.equal(card.factsOnly.score, 1);
  assert.equal(card.placeholders.score, 1);
  assert.equal(card.overall, 1);
});
