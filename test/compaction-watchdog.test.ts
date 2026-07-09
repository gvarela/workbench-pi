import { test } from "node:test";
import assert from "node:assert/strict";
import { watchdogAction, WATCHDOG_THRESHOLD, WATCHDOG_WARN } from "../src/compaction-watchdog.ts";

const WINDOW = 32768;

test("small tier compacts proactively at the threshold, well before the window fills", () => {
  assert.equal(watchdogAction("small", Math.ceil(WINDOW * WATCHDOG_THRESHOLD), WINDOW, false), "compact");
  assert.equal(watchdogAction("small", 28000, WINDOW, false), "compact"); // 85%
});

test("small tier escalates to a warning when compactions are not landing", () => {
  // ≥95%: a previous proactive compact should have brought us down — it didn't.
  assert.equal(watchdogAction("small", Math.ceil(WINDOW * WATCHDOG_WARN), WINDOW, false), "warn");
  assert.equal(watchdogAction("small", WINDOW + 5000, WINDOW, false), "warn"); // over the window (the live 50k case)
});

test("no action below the threshold", () => {
  assert.equal(watchdogAction("small", 16000, WINDOW, false), undefined); // ~49%
  assert.equal(watchdogAction("small", 0, WINDOW, false), undefined);
});

test("capable tier never triggers — pi's own machinery is trusted", () => {
  assert.equal(watchdogAction("capable", 28000, WINDOW, false), undefined);
  assert.equal(watchdogAction("capable", WINDOW + 5000, WINDOW, false), undefined);
});

test("no compact while a watchdog compact is already in flight, but the warn still fires", () => {
  assert.equal(watchdogAction("small", 28000, WINDOW, true), undefined);
  // even mid-compact, ≥95% is worth telling the human about
  assert.equal(watchdogAction("small", WINDOW + 5000, WINDOW, true), "warn");
});

test("no action on unknown usage — never compact blind", () => {
  assert.equal(watchdogAction("small", null, WINDOW, false), undefined);
  assert.equal(watchdogAction("small", 28000, 0, false), undefined);
});
