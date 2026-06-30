import { test } from "node:test";
import assert from "node:assert/strict";
import { systemPromptFragment } from "../src/prompts.ts";

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
