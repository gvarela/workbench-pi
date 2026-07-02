import { test } from "node:test";
import assert from "node:assert/strict";
import { systemPromptFragment, researchDelegationPrompt, designDelegationPrompt, editFailureTip } from "../src/prompts.ts";

test("SMALL fragment carries qwen-specific editing discipline; capable does not", () => {
  const small = systemPromptFragment("small");
  assert.match(small, /re-read/i);
  assert.match(small, /anchor/i);
  assert.match(small, /never reconstruct/i);
  assert.match(small, /\bsed\b/);
  // qwen-specific: the capable model doesn't need this hand-holding
  assert.doesNotMatch(systemPromptFragment("capable"), /never reconstruct/i);
});

test("editFailureTip fires only for a small-tier edit failure", () => {
  assert.match(editFailureTip("small", "edit", true) ?? "", /re-read/i);
  assert.equal(editFailureTip("capable", "edit", true), undefined); // not for capable models
  assert.equal(editFailureTip("small", "bash", true), undefined); // only edit
  assert.equal(editFailureTip("small", "edit", false), undefined); // only on failure
});

test("systemPromptFragment selects the tier-appropriate fragment", () => {
  const small = systemPromptFragment("small");
  const capable = systemPromptFragment("capable");
  assert.match(small, /tier: small/);
  assert.match(capable, /tier: capable/);
  // small tier states the hard rules; capable tier talks about parallel fan-out
  assert.match(small, /failing test/);
  assert.match(capable, /parallel/);
  assert.notEqual(small, capable);
});

test("capable fragment carries the load-bearing disciplines", () => {
  const c = systemPromptFragment("capable");
  assert.match(c, /FACTS ONLY/);
  assert.match(c, /DECISIONS/);
  assert.match(c, /synthesize their findings YOURSELF/i);
  assert.match(c, /Verify before claiming done/i);
  assert.match(c, /TDD/);
});

test("delegation prompts target the right artifact and disciplines", () => {
  const research = researchDelegationPrompt("auth flow", "2026-06-30-auth");
  assert.match(research, /docs\/plans\/2026-06-30-auth\/research\.md/);
  assert.match(research, /FACTS ONLY/);
  assert.match(research, /file:line/);
  assert.match(research, /Agent tool/);

  const design = designDelegationPrompt("auth flow", "2026-06-30-auth");
  assert.match(design, /docs\/plans\/2026-06-30-auth\/design\.md/);
  assert.match(design, /WHAT\/WHY/);
  assert.match(design, /research\.md/);
});
