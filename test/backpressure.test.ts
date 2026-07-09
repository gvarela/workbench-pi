import { test } from "node:test";
import assert from "node:assert/strict";
import { bashBackpressure } from "../src/backpressure.ts";

const LONG = (line: string, n: number) => Array.from({ length: n }, (_, i) => `${line} ${i}`).join("\n");

// A green test run: hundreds of progress lines, summary at the end.
const GREEN_RSPEC = `${LONG("....", 300)}\nFinished in 4.2 seconds\n120 examples, 0 failures`;
// A red test run: the failure detail is what the model must see.
const RED_RSPEC = `${LONG("....", 300)}\nFailures:\n  1) Widget renders\n     expected true, got false\n2 examples, 1 failure`;
// A long info-command result: the output IS the answer.
const LONG_GREP = LONG("src/app/models/widget.rb:42: def price", 200);

test("green verification runs collapse to a ✓ line plus the tail summary", () => {
  const out = bashBackpressure("small", "bundle exec rspec spec/widget_spec.rb", false, GREEN_RSPEC);
  assert.ok(out !== undefined);
  assert.match(out, /✓/);
  assert.match(out, /120 examples, 0 failures/); // summary survives (it's in the tail)
  assert.doesNotMatch(out, /\.\.\.\. 5\b/); // the progress-dots body is gone
  assert.ok(out.length < GREEN_RSPEC.length / 5, "collapse must be drastic");
});

test("failed runs keep diagnostic detail — RED step must see why the test failed", () => {
  const out = bashBackpressure("small", "bundle exec rspec spec/widget_spec.rb", true, RED_RSPEC);
  // Long output is capped but NEVER collapsed to a ✓ line
  if (out !== undefined) {
    assert.doesNotMatch(out, /✓/);
    assert.match(out, /expected true, got false/); // failure detail is in the tail
  }
});

test("info-command output is the answer: capped when huge, never collapsed", () => {
  const out = bashBackpressure("small", "grep -rn 'def price' src/", false, LONG_GREP);
  assert.ok(out !== undefined, "long grep output must be capped");
  assert.doesNotMatch(out, /✓ /);
  assert.match(out, /widget\.rb:42: def price 0/); // head kept
  assert.match(out, /widget\.rb:42: def price 199/); // tail kept
  assert.match(out, /elided/); // with an explicit marker
  assert.ok(out.length < LONG_GREP.length);
});

test("short output always passes through untouched", () => {
  assert.equal(bashBackpressure("small", "ls src/", false, "index.ts\nprompts.ts"), undefined);
  assert.equal(bashBackpressure("small", "npm test", true, "1 test failed: expected 2 got 3"), undefined);
  // short green verification too — already cheap, and the model quotes it verbatim
  assert.equal(bashBackpressure("small", "npm test", false, "4 passed (12ms)"), undefined);
});

test("capable tier is never touched — let it rip", () => {
  assert.equal(bashBackpressure("capable", "bundle exec rspec", false, GREEN_RSPEC), undefined);
  assert.equal(bashBackpressure("capable", "grep -rn x src/", false, LONG_GREP), undefined);
  assert.equal(bashBackpressure("capable", "npm test", true, RED_RSPEC), undefined);
});

test("elided output carries the targeted-commands tip (point-of-failure reinforcement)", () => {
  const collapsed = bashBackpressure("small", "npm test", false, GREEN_RSPEC);
  const capped = bashBackpressure("small", "cat config/routes.rb", false, LONG_GREP);
  assert.match(collapsed ?? "", /targeted/i);
  assert.match(capped ?? "", /targeted/i);
});
