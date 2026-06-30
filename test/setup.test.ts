import { test } from "node:test";
import assert from "node:assert/strict";
import { planAgentSync } from "../src/setup.ts";

const source = [
  { name: "wb-locator.md", content: "A" },
  { name: "wb-analyzer.md", content: "B" },
];

test("planAgentSync writes everything when target is empty", () => {
  const r = planAgentSync(source, new Map());
  assert.deepEqual(r.toWrite.sort(), ["wb-analyzer.md", "wb-locator.md"]);
  assert.equal(r.unchanged.length, 0);
});

test("planAgentSync skips byte-identical files", () => {
  const r = planAgentSync(source, new Map([["wb-locator.md", "A"], ["wb-analyzer.md", "B"]]));
  assert.equal(r.toWrite.length, 0);
  assert.deepEqual(r.unchanged.sort(), ["wb-analyzer.md", "wb-locator.md"]);
});

test("planAgentSync rewrites changed files only", () => {
  const r = planAgentSync(source, new Map([["wb-locator.md", "A"], ["wb-analyzer.md", "STALE"]]));
  assert.deepEqual(r.toWrite, ["wb-analyzer.md"]);
  assert.deepEqual(r.unchanged, ["wb-locator.md"]);
});
