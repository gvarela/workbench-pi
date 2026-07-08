import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBeadDetail,
  detectTestCommand,
  extractTestCommandFromFrontmatter,
  buildContextPack,
} from "../src/context-pack.ts";

test("parseBeadDetail reads bd show --json (object or single-element array)", () => {
  const obj = JSON.stringify({ id: "r-1", title: "Do X", description: "Delete spec/foo_spec.rb entirely.\nAcceptance: suite green." });
  assert.deepEqual(parseBeadDetail(obj), { id: "r-1", title: "Do X", description: "Delete spec/foo_spec.rb entirely.\nAcceptance: suite green." });
  const arr = JSON.stringify([{ id: "r-2", title: "Y", description: "d", notes: "n", design: "g" }]);
  assert.deepEqual(parseBeadDetail(arr), { id: "r-2", title: "Y", description: "d", notes: "n", design: "g" });
  assert.equal(parseBeadDetail("not json"), undefined);
  assert.equal(parseBeadDetail("[]"), undefined);
});

test("detectTestCommand: explicit wins; ruby+mise composes; node script; unknown → undefined", () => {
  assert.equal(detectTestCommand({ explicit: "make check", mise: true, gemfile: true, specDir: true }), "make check");
  assert.equal(detectTestCommand({ mise: true, gemfile: true, specDir: true }), "mise exec -- bundle exec rspec");
  assert.equal(detectTestCommand({ mise: false, gemfile: true, specDir: true }), "bundle exec rspec");
  assert.equal(detectTestCommand({ mise: true, gemfile: false, specDir: false, pkgTestScript: true }), "mise exec -- npm test");
  assert.equal(detectTestCommand({ mise: false, gemfile: false, specDir: false, pkgTestScript: true }), "npm test");
  assert.equal(detectTestCommand({ mise: true, gemfile: false, specDir: false }), undefined);
});

test("extractTestCommandFromFrontmatter reads test_command", () => {
  assert.equal(extractTestCommandFromFrontmatter("---\ntest_command: bin/rails test\nstatus: x\n---\n"), "bin/rails test");
  assert.equal(extractTestCommandFromFrontmatter('---\ntest_command: "bundle exec rspec"\n---'), "bundle exec rspec");
  assert.equal(extractTestCommandFromFrontmatter("---\nstatus: x\n---"), undefined);
});

test("buildContextPack composes task detail, runbook, instructions, and plan pointers", () => {
  const pack = buildContextPack({
    task: { id: "r-1", title: "Remove foo", description: "Delete a.rb; keep b.rb." },
    testCommand: "mise exec -- bundle exec rspec",
    agentsMd: { path: "AGENTS.md", content: "Use mise for all tool execution." },
    planDir: ".project_docs/2026-06-04-remove-segment",
  });
  assert.match(pack, /Remove foo/);
  assert.match(pack, /Delete a\.rb/);
  assert.match(pack, /mise exec -- bundle exec rspec/);
  assert.match(pack, /Use mise for all tool execution/);
  assert.match(pack, /\.project_docs\/2026-06-04-remove-segment/);
});

test("buildContextPack degrades gracefully: no runbook → discovery instruction; big AGENTS.md → path pointer", () => {
  const pack = buildContextPack({
    task: { id: "r-1", title: "T" },
    agentsMd: { path: "AGENTS.md" }, // no content → point at the file
  });
  assert.match(pack, /AGENTS\.md/);
  assert.match(pack, /read/i); // "read it first" style pointer
  assert.match(pack, /discover|find|check/i); // test command unknown → tell worker how to find it
  assert.doesNotMatch(pack, /undefined/);
});
