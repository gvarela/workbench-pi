import { test } from "node:test";
import assert from "node:assert/strict";
import {
  systemPromptFragment,
  researchDelegationPrompt,
  designDelegationPrompt,
  editFailureTip,
  compactionPreserveInstructions,
} from "../src/prompts.ts";

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

test("SMALL editing discipline covers the qwen whitespace/write/sed footguns", () => {
  const small = systemPromptFragment("small");
  assert.match(small, /tab|whitespace|indentation/i); // whitespace is the #1 edit killer
  assert.match(small, /space/i); // don't swap spaces for tabs
  assert.match(small, /never use write|write is for new/i); // never write to fix an existing file
  assert.match(small, /one sed call|single sed/i); // atomic multi-edit, original line numbers
  // capable tier stays free of this hand-holding
  assert.doesNotMatch(systemPromptFragment("capable"), /never use write/i);
  // the point-of-failure tip steers to sed / flags whitespace
  assert.match(editFailureTip("small", "edit", true) ?? "", /sed/);
  assert.match(editFailureTip("small", "edit", true) ?? "", /whitespace|tab/i);
});

test("SMALL fragment states the output-backpressure rule; capable stays clean", () => {
  const small = systemPromptFragment("small");
  assert.match(small, /elided|collaps/i); // the model is told output shrinks
  assert.match(small, /targeted/i); // and steered to targeted commands
  assert.doesNotMatch(systemPromptFragment("capable"), /elided|collaps/i);
});

test("compaction preserve-instructions pin the TDD state; capable uses pi defaults", () => {
  const small = compactionPreserveInstructions("small");
  assert.ok(small !== undefined);
  assert.match(small, /task/i); // what am I working on
  assert.match(small, /test command/i); // how do I verify here
  assert.match(small, /failing test/i); // TDD state (RED/GREEN)
  assert.match(small, /file path/i); // what have I touched
  assert.match(small, /never invent|unknown/i); // no hallucinated state
  assert.equal(compactionPreserveInstructions("capable"), undefined);
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
