import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSilentId, planBeadsTree } from "../src/tools/beads.ts";

test("parseSilentId extracts the id from --silent output, ignoring noise", () => {
  assert.equal(parseSilentId("bd-a3f8e9\n"), "bd-a3f8e9");
  assert.equal(parseSilentId("warning: something\nMain-sf0z\n"), "Main-sf0z");
  // prefixes can contain hyphens → ids with multiple hyphens must still parse
  assert.equal(parseSilentId("workbench-pi-3nq\n"), "workbench-pi-3nq");
  assert.equal(parseSilentId("no id here"), undefined);
  assert.equal(parseSilentId(""), undefined);
});

test("planBeadsTree builds epic → phase-milestones → tasks with correct parents", () => {
  const plan = planBeadsTree("Demo epic", [
    { name: "Setup", tasks: ["scaffold", "config"] },
    { name: "Build", tasks: ["impl"] },
  ]);

  // creates are dependency-safe: epic, then each milestone before its tasks
  assert.equal(plan.creates.length, 6);
  assert.deepEqual(plan.creates[0], { ref: "epic", title: "Demo epic", type: "epic" });

  const byRef = Object.fromEntries(plan.creates.map((c) => [c.ref, c]));
  assert.equal(byRef["phase-1"].parent, "epic");
  assert.match(byRef["phase-1"].title, /Setup/);
  assert.equal(byRef["phase-1-task-1"].parent, "phase-1");
  assert.equal(byRef["phase-1-task-1"].title, "scaffold");
  assert.equal(byRef["phase-2-task-1"].parent, "phase-2");
});

test("planBeadsTree blocks each milestone by its tasks and orders phases", () => {
  const plan = planBeadsTree("E", [
    { name: "A", tasks: ["a1", "a2"] },
    { name: "B", tasks: ["b1"] },
  ]);
  const has = (blocked: string, blocker: string) =>
    plan.deps.some((d) => d.blocked === blocked && d.blocker === blocker);

  assert.ok(has("phase-1", "phase-1-task-1"));
  assert.ok(has("phase-1", "phase-1-task-2"));
  assert.ok(has("phase-2", "phase-2-task-1"));
  assert.ok(has("phase-2", "phase-1")); // phase 2 depends on phase 1
});
