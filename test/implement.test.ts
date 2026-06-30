import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReadyIssues, parseVerdict } from "../src/implement.ts";

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
