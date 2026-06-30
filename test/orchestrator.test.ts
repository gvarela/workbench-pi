import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPlanDir, assembleResearchBody, setStatusAndReplaceBody, stripLeadingHeading } from "../src/orchestrator.ts";

test("stripLeadingHeading drops a redundant leading H2 from agent output", () => {
  assert.equal(stripLeadingHeading("\n## Locations for: x\n- a\n- b\n"), "- a\n- b");
  assert.equal(stripLeadingHeading("- a\n- b"), "- a\n- b");
  assert.equal(stripLeadingHeading(""), "");
});

test("assembleResearchBody does not stack two headings per section", () => {
  const body = assembleResearchBody("x", [{ heading: "Locations (wb-locator)", body: "## Locations for: x\n- `a.ts`" }]);
  // exactly one heading line mentioning Locations, immediately followed by the bullet
  assert.match(body, /## Locations \(wb-locator\)\n\n- `a\.ts`/);
  assert.doesNotMatch(body, /## Locations for: x/);
});

test("pickPlanDir returns the latest date-prefixed dir by default", () => {
  const dirs = ["2026-06-01-alpha", "2026-06-29-ENG-1-demo", "2026-06-15-beta"];
  assert.equal(pickPlanDir(dirs), "2026-06-29-ENG-1-demo");
  assert.equal(pickPlanDir([]), undefined);
});

test("pickPlanDir honors a substring arg", () => {
  const dirs = ["2026-06-01-alpha", "2026-06-29-ENG-1-demo"];
  assert.equal(pickPlanDir(dirs, "alpha"), "2026-06-01-alpha");
  assert.equal(pickPlanDir(dirs, "nomatch"), undefined);
});

test("assembleResearchBody composes sections and marks empty findings", () => {
  const body = assembleResearchBody("auth flow", [
    { heading: "Locations (wb-locator)", body: "- `src/auth.ts`" },
    { heading: "How it works (wb-analyzer)", body: "" },
  ]);
  assert.match(body, /# Research: auth flow/);
  assert.match(body, /## Locations \(wb-locator\)/);
  assert.match(body, /src\/auth\.ts/);
  assert.match(body, /## How it works \(wb-analyzer\)/);
  assert.match(body, /\(no findings\)/);
});

test("setStatusAndReplaceBody preserves frontmatter, flips status, swaps body", () => {
  const existing = `---\ntitle: Demo — Research\ntype: research\nstatus: draft\ncreated: 2026-06-29\n---\n\nold placeholder body\n`;
  const out = setStatusAndReplaceBody(existing, "in-progress", "NEW BODY");
  assert.match(out, /status: in-progress/);
  assert.doesNotMatch(out, /status: draft/);
  assert.match(out, /title: Demo — Research/); // other frontmatter kept
  assert.match(out, /NEW BODY/);
  assert.doesNotMatch(out, /old placeholder body/);
});

test("setStatusAndReplaceBody handles a file with no frontmatter", () => {
  const out = setStatusAndReplaceBody("just text", "complete", "BODY");
  assert.equal(out, "BODY");
});
