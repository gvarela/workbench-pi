import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReadyIssues, parseVerdict, selectNextReady, decideNext } from "../src/implement.ts";

test("decideNext drives the impl→verify→close/retry/fail chain", () => {
  assert.equal(decideNext("impl", "UNKNOWN", false), "verify");
  assert.equal(decideNext("verify", "PASS", false), "close");
  assert.equal(decideNext("verify", "FAIL", false), "retry");
  assert.equal(decideNext("verify", "FAIL", true), "fail");
  assert.equal(decideNext("verify", "UNKNOWN", false), "retry"); // not-PASS → retry
  assert.equal(decideNext("verify", "UNKNOWN", true), "fail");
});

test("selectNextReady returns the first not-yet-attempted task, or undefined when dry", () => {
  const issues = [{ id: "a-1", title: "x" }, { id: "a-2", title: "y" }];
  assert.deepEqual(selectNextReady(issues, new Set()), { id: "a-1", title: "x" });
  assert.deepEqual(selectNextReady(issues, new Set(["a-1"])), { id: "a-2", title: "y" });
  assert.equal(selectNextReady(issues, new Set(["a-1", "a-2"])), undefined); // all attempted → dry
  assert.equal(selectNextReady([], new Set()), undefined);
});

test("parseReadyIssues handles a JSON array and {issues:[]}, picking id+title", () => {
  assert.deepEqual(parseReadyIssues('[{"id":"a-1","title":"Do X"},{"id":"a-2","summary":"Do Y"}]'), [
    { id: "a-1", title: "Do X" },
    { id: "a-2", title: "Do Y" },
  ]);
  assert.deepEqual(parseReadyIssues('{"issues":[{"id":"b-1","title":"Z"}]}'), [{ id: "b-1", title: "Z" }]);
  assert.deepEqual(parseReadyIssues("not json"), []);
  assert.deepEqual(parseReadyIssues("[]"), []);
});

test("parseVerdict reads the verdict section, FAIL wins over an earlier PASS mention", () => {
  assert.equal(parseVerdict("## Verdict\nPASS — all good"), "PASS");
  assert.equal(parseVerdict("## Verdict\nFAIL — test x failed"), "FAIL");
  assert.equal(parseVerdict("tests PASS individually\n## Verdict\nFAIL — scope creep"), "FAIL");
  assert.equal(parseVerdict("no verdict here"), "UNKNOWN");
});
