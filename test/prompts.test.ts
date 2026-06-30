import { test } from "node:test";
import assert from "node:assert/strict";
import { systemPromptFragment, researchDelegationPrompt, designDelegationPrompt } from "../src/prompts.ts";

test("systemPromptFragment selects the tier-appropriate fragment", () => {
  const small = systemPromptFragment("small");
  const reasoning = systemPromptFragment("reasoning");
  assert.match(small, /tier: small/);
  assert.match(reasoning, /tier: reasoning/);
  // small tier states the hard rules; reasoning tier talks about parallel fan-out
  assert.match(small, /failing test/);
  assert.match(reasoning, /parallel/);
  assert.notEqual(small, reasoning);
});

test("reasoning fragment carries the load-bearing disciplines", () => {
  const r = systemPromptFragment("reasoning");
  assert.match(r, /FACTS ONLY/);
  assert.match(r, /DECISIONS/);
  assert.match(r, /synthesize their findings YOURSELF/i);
  assert.match(r, /Verify before claiming done/i);
  assert.match(r, /TDD/);
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
