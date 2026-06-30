import { test } from "node:test";
import assert from "node:assert/strict";
import { isVerificationCommand, isClaimOfDone, isSourceFile, claimGate, writeGate } from "../src/gates.ts";

test("isVerificationCommand recognizes test/build/lint runners", () => {
  assert.ok(isVerificationCommand("npm test"));
  assert.ok(isVerificationCommand("node --test 'test/**/*.test.ts'"));
  assert.ok(isVerificationCommand("pytest -x"));
  assert.ok(isVerificationCommand("npx tsc --noEmit"));
  assert.ok(!isVerificationCommand("ls -la"));
  assert.ok(!isVerificationCommand("git status"));
});

test("isClaimOfDone flags success assertions", () => {
  assert.ok(isClaimOfDone("All tests pass now."));
  assert.ok(isClaimOfDone("I fixed the bug."));
  assert.ok(isClaimOfDone("This is done."));
  assert.ok(!isClaimOfDone("Let me check the code first."));
  assert.ok(!isClaimOfDone("Running the tests."));
});

test("isSourceFile is true for code, false for tests and docs", () => {
  assert.ok(isSourceFile("src/index.ts"));
  assert.ok(isSourceFile("lib/foo.py"));
  assert.ok(!isSourceFile("test/foo.test.ts"));
  assert.ok(!isSourceFile("src/__tests__/foo.spec.js"));
  assert.ok(!isSourceFile("README.md"));
});

test("claimGate blocks unverified done-claims, allows after verification", () => {
  assert.equal(claimGate("all tests pass", false).block, true);
  assert.equal(claimGate("all tests pass", true).block, false);
  assert.equal(claimGate("let me look at this", false).block, false);
});

test("writeGate blocks source writes with no failing test, allows tests and post-red writes", () => {
  assert.equal(writeGate("src/index.ts", false).block, true);
  assert.equal(writeGate("src/index.ts", true).block, false);
  assert.equal(writeGate("test/index.test.ts", false).block, false); // writing a test is always allowed
  assert.equal(writeGate("README.md", false).block, false);
});
