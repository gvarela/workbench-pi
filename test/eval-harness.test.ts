import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFixture, checkExpectations } from "../src/eval/fixtures.ts";
import { judgePrompt, parseJudgeVerdict, judgeDimensions } from "../src/eval/judge.ts";
import { compareVariants, mean, stdev } from "../src/eval/compare.ts";
import type { Scorecard } from "../src/eval/scorers.ts";

const card = (overall: number, grounding: number): Scorecard => ({
  pathGrounding: { cited: 1, grounded: 1, score: grounding },
  factsOnly: { violations: 0, score: 1 },
  templateConformance: { present: 1, required: 1, score: 1 },
  placeholders: { leftover: 0, score: 1 },
  overall,
});

test("parseFixture applies defaults and rejects missing required fields", () => {
  const f = parseFixture({ name: "x", repo: "u", command: "wb-research", artifact: "a/*.md" });
  assert.equal(f.args, "");
  assert.deepEqual(f.setup, []);
  assert.equal(f.bundle, false);
  assert.throws(() => parseFixture({ name: "x" }), /required string "repo"|required string "command"/);
});

test("checkExpectations enforces thresholds and citation constraints", () => {
  const ok = checkExpectations(card(0.9, 0.9), ["lib/faraday/middleware.rb"], {
    minOverall: 0.85,
    minGrounding: 0.85,
    mustCite: ["lib/faraday/middleware.rb"],
    mustNotCite: ["lib/nope.rb"],
  });
  assert.deepEqual(ok, { pass: true, failures: [] });

  const bad = checkExpectations(card(0.7, 0.5), ["lib/nope.rb"], {
    minOverall: 0.85,
    minGrounding: 0.85,
    mustCite: ["lib/faraday/middleware.rb"],
    mustNotCite: ["lib/nope.rb"],
  });
  assert.equal(bad.pass, false);
  assert.equal(bad.failures.length, 4); // overall, grounding, missing-cite, forbidden-cite
});

test("judgePrompt names the right dimensions and demands strict JSON", () => {
  assert.deepEqual(judgeDimensions("research"), ["accuracy", "completeness", "usefulness"]);
  const p = judgePrompt("research", "some content");
  assert.match(p, /accuracy/);
  assert.match(p, /ONLY a JSON object/);
});

test("parseJudgeVerdict extracts JSON from prose and averages, clamps, or fails", () => {
  const v = parseJudgeVerdict('Sure!\n```json\n{"dimensions":{"accuracy":0.8,"usefulness":1.2},"notes":"ok"}\n```');
  assert.ok(v);
  assert.equal(v!.dimensions.usefulness, 1); // clamped to 1
  assert.equal(v!.average, 0.9); // (0.8 + 1.0)/2
  assert.equal(v!.notes, "ok");
  assert.equal(parseJudgeVerdict("no json here"), null);
});

test("compareVariants flags significance only when delta clears noise", () => {
  assert.equal(mean([1, 3]), 2);
  assert.ok(stdev([2, 2, 2]) === 0);
  const clear = compareVariants([0.5, 0.5], [0.9, 0.9]); // delta .4, noise 0
  assert.equal(clear.winner, "B");
  assert.equal(clear.significant, true);
  const noisy = compareVariants([0.5, 0.9], [0.6, 0.9]); // small delta, big spread
  assert.equal(noisy.winner, "tie");
});
