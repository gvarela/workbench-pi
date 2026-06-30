import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTier, tierFromModelId, resolveTier } from "../src/tier.ts";

test("normalizeTier maps aliases and rejects junk", () => {
  assert.equal(normalizeTier("small"), "small");
  assert.equal(normalizeTier("LOCAL"), "small");
  assert.equal(normalizeTier(" qwen "), "small");
  assert.equal(normalizeTier("capable"), "capable");
  // back-compat aliases for the capable tier
  assert.equal(normalizeTier("reasoning"), "capable");
  assert.equal(normalizeTier("frontier"), "capable");
  assert.equal(normalizeTier("large"), "capable");
  assert.equal(normalizeTier(undefined), undefined);
  assert.equal(normalizeTier("banana"), undefined);
});

test("tierFromModelId detects known capable families, defaults small", () => {
  assert.equal(tierFromModelId("anthropic/claude-opus-4-8"), "capable");
  assert.equal(tierFromModelId("anthropic/claude-sonnet-4-6"), "capable");
  assert.equal(tierFromModelId("openai/gpt-5"), "capable");
  assert.equal(tierFromModelId("ollama/qwen3.6:35b-mlx"), "small");
  // capable-but-unknown families default to small — opt in via WORKBENCH_TIER
  assert.equal(tierFromModelId("zai/glm-5.2"), "small");
  assert.equal(tierFromModelId(undefined), "small");
});

test("resolveTier: env overrides model heuristic", () => {
  const prev = process.env.WORKBENCH_TIER;
  try {
    process.env.WORKBENCH_TIER = "capable";
    assert.equal(resolveTier("ollama/qwen3.6:35b-mlx"), "capable");
    process.env.WORKBENCH_TIER = "reasoning"; // alias still works
    assert.equal(resolveTier("ollama/qwen3.6:35b-mlx"), "capable");
    process.env.WORKBENCH_TIER = "small";
    assert.equal(resolveTier("anthropic/claude-opus-4-8"), "small");
    delete process.env.WORKBENCH_TIER;
    assert.equal(resolveTier("anthropic/claude-opus-4-8"), "capable");
    assert.equal(resolveTier("ollama/qwen3.6:35b-mlx"), "small");
  } finally {
    if (prev === undefined) delete process.env.WORKBENCH_TIER;
    else process.env.WORKBENCH_TIER = prev;
  }
});
