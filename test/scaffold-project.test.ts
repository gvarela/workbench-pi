import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planDirName, scaffoldProject, parseProjectArgs } from "../src/tools/scaffold-project.ts";

test("parseProjectArgs splits a leading ticket from the name", () => {
  assert.deepEqual(parseProjectArgs("ENG-123 Add login"), { ticket: "ENG-123", name: "Add login" });
  assert.deepEqual(parseProjectArgs("Add login"), { name: "Add login" });
  assert.deepEqual(parseProjectArgs("  Spaced out  "), { name: "Spaced out" });
  // a bare number or non-ticket leading token is part of the name
  assert.deepEqual(parseProjectArgs("123 widgets"), { name: "123 widgets" });
});

test("planDirName slugifies the name", () => {
  assert.equal(planDirName({ date: "2026-06-29", name: "My Cool Feature" }), "2026-06-29-my-cool-feature");
  assert.equal(planDirName({ date: "2026-06-29", name: "  Spaces__and--dashes  " }), "2026-06-29-spaces-and-dashes");
  assert.equal(planDirName({ date: "2026-06-29", name: "Weird!@#Chars$%^" }), "2026-06-29-weird-chars");
});

test("planDirName injects an uppercased ticket prefix", () => {
  assert.equal(planDirName({ date: "2026-06-29", ticket: "eng-123", name: "Add auth" }), "2026-06-29-ENG-123-add-auth");
});

test("scaffoldProject creates the four artifacts with correct status frontmatter", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wbpi-"));
  const res = scaffoldProject({ cwd, date: "2026-06-29", ticket: "ENG-1", name: "Demo" });

  assert.equal(res.dir, "docs/plans/2026-06-29-ENG-1-demo");
  assert.deepEqual(res.created.sort(), ["README.md", "design.md", "research.md", "tasks.md"]);
  assert.equal(res.skipped.length, 0);

  const base = join(cwd, res.dir);
  assert.ok(existsSync(join(base, "research.md")));
  assert.match(readFileSync(join(base, "research.md"), "utf-8"), /status: draft/);
  assert.match(readFileSync(join(base, "design.md"), "utf-8"), /status: draft/);
  assert.match(readFileSync(join(base, "tasks.md"), "utf-8"), /status: not-started/);
  // ticket + date propagate into frontmatter
  assert.match(readFileSync(join(base, "README.md"), "utf-8"), /ticket: ENG-1/);
  assert.match(readFileSync(join(base, "README.md"), "utf-8"), /created: 2026-06-29/);
});

test("scaffoldProject is idempotent and never clobbers existing files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wbpi-"));
  const first = scaffoldProject({ cwd, date: "2026-06-29", name: "Demo" });
  const research = join(cwd, first.dir, "research.md");

  writeFileSync(research, "EDITED BY USER", "utf-8");
  const second = scaffoldProject({ cwd, date: "2026-06-29", name: "Demo" });

  assert.equal(second.created.length, 0);
  assert.deepEqual(second.skipped.sort(), ["README.md", "design.md", "research.md", "tasks.md"]);
  assert.equal(readFileSync(research, "utf-8"), "EDITED BY USER");
});
