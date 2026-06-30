import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTaskPlan, assembleTasksBody } from "../src/execution.ts";

test("parseTaskPlan extracts phases and tasks, ignoring prose and bullet style", () => {
  const md = [
    "Here is the plan:",
    "### Phase: Setup",
    "- Create config",
    "* Add deps",
    "### Phase: Build",
    "- [ ] Implement core",
    "trailing note",
  ].join("\n");
  assert.deepEqual(parseTaskPlan(md), [
    { name: "Setup", tasks: ["Create config", "Add deps"] },
    { name: "Build", tasks: ["Implement core"] },
  ]);
});

test("parseTaskPlan returns [] when there are no phases", () => {
  assert.deepEqual(parseTaskPlan("no structure here"), []);
});

test("assembleTasksBody embeds epic, phase and task bead ids matching the tree ref scheme", () => {
  const body = assembleTasksBody(
    "Epic X",
    [{ name: "Setup", tasks: ["a", "b"] }],
    { epic: "E-1", "phase-1": "P-1", "phase-1-task-1": "T-1", "phase-1-task-2": "T-2" },
  );
  assert.match(body, /# Tasks: Epic X/);
  assert.match(body, /Epic: `E-1`/);
  assert.match(body, /## Phase 1: Setup \(`P-1`\)/);
  assert.match(body, /- \[ \] a \(`T-1`\)/);
  assert.match(body, /- \[ \] b \(`T-2`\)/);
});

test("assembleTasksBody tolerates missing ids gracefully", () => {
  const body = assembleTasksBody("E", [{ name: "P", tasks: ["x"] }], {});
  assert.match(body, /- \[ \] x/);
  assert.doesNotMatch(body, /undefined/);
});
