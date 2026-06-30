import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTier, tierFromModelId, resolveTier } from "../src/tier.ts";

test("normalizeTier maps aliases and rejects junk", () => {
  assert.equal(normalizeTier("small"), "small");
  assert.equal(normalizeTier("LOCAL"), "small");
  assert.equal(normalizeTier(" qwen "), "small");
  assert.equal(normalizeTier("reasoning"), "reasoning");
  assert.equal(normalizeTier("frontier"), "reasoning");
  assert.equal(normalizeTier("large"), "reasoning");
  assert.equal(normalizeTier(undefined), undefined);
  assert.equal(normalizeTier("banana"), undefined);
});

test("tierFromModelId detects reasoning families, defaults small", () => {
  assert.equal(tierFromModelId("anthropic/claude-opus-4-8"), "reasoning");
  assert.equal(tierFromModelId("anthropic/claude-sonnet-4-6"), "reasoning");
  assert.equal(tierFromModelId("openai/gpt-5"), "reasoning");
  assert.equal(tierFromModelId("ollama/qwen3.6:35b-mlx"), "small");
  assert.equal(tierFromModelId(undefined), "small");
  assert.equal(tierFromModelId("some-random-7b"), "small");
});

test("resolveTier: env overrides model heuristic", () => {
  const prev = process.env.WORKBENCH_TIER;
  try {
    process.env.WORKBENCH_TIER = "reasoning";
    assert.equal(resolveTier("ollama/qwen3.6:35b-mlx"), "reasoning");
    process.env.WORKBENCH_TIER = "small";
    assert.equal(resolveTier("anthropic/claude-opus-4-8"), "small");
    delete process.env.WORKBENCH_TIER;
    assert.equal(resolveTier("anthropic/claude-opus-4-8"), "reasoning");
    assert.equal(resolveTier("ollama/qwen3.6:35b-mlx"), "small");
  } finally {
    if (prev === undefined) delete process.env.WORKBENCH_TIER;
    else process.env.WORKBENCH_TIER = prev;
  }
});
