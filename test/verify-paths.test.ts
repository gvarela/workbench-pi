import { test } from "node:test";
import assert from "node:assert/strict";
import { groundPaths, normalizePath } from "../src/tools/verify-paths.ts";

const universe = [
  "src/index.ts",
  "src/tools/scaffold-project.ts",
  "src/tools/verify-paths.ts",
  "test/tier.test.ts",
  "docs/PLAN.md",
];

test("normalizePath strips ./ and trailing slash", () => {
  assert.equal(normalizePath("./src/index.ts"), "src/index.ts");
  assert.equal(normalizePath("src/tools/"), "src/tools");
  assert.equal(normalizePath("src/index.ts"), "src/index.ts");
});

test("groundPaths marks exact matches real", () => {
  const r = groundPaths(["src/index.ts", "docs/PLAN.md"], universe);
  assert.deepEqual(r.real, ["src/index.ts", "docs/PLAN.md"]);
  assert.equal(r.missing.length, 0);
});

test("groundPaths treats directory prefixes as real", () => {
  const r = groundPaths(["src/tools", "./src/"], universe);
  assert.deepEqual(r.real.sort(), ["src", "src/tools"]);
  assert.equal(r.missing.length, 0);
});

test("groundPaths flags hallucinated paths and suggests by basename", () => {
  const r = groundPaths(["src/tools/scaffold_project.ts", "src/nope.ts"], universe);
  assert.equal(r.real.length, 0);
  const byPath = Object.fromEntries(r.missing.map((m) => [m.path, m.suggestions]));
  // same basename stem → suggests the real kebab-case file
  assert.ok(byPath["src/tools/scaffold_project.ts"].includes("src/tools/scaffold-project.ts"));
  // no plausible match → empty suggestions, still reported missing
  assert.ok("src/nope.ts" in byPath);
});
