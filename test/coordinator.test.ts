import { test } from "node:test";
import assert from "node:assert/strict";
import { startImplementRun, HARD_CAP, type CoordinatorDeps, type WorkerResult } from "../src/coordinator.ts";

/**
 * Fake deps: `ready()` yields per-query snapshots (last repeats); `spawnAwait`
 * yields per-spawn results in order (impl/verify interleaved). bd writes are
 * recorded so tests assert bead-state hygiene (in_progress/open/close/sync).
 */
function fakeDeps(readySnapshots: string[][], workers: (WorkerResult | undefined)[]) {
  const bdCalls: string[][] = [];
  const notices: string[] = [];
  const spawns: string[] = [];
  let readyIdx = 0;
  let workerIdx = 0;
  const deps: CoordinatorDeps = {
    bd: async (args) => {
      bdCalls.push(args);
      return { code: 0, stdout: "" };
    },
    ready: async () => {
      const snap = readySnapshots[Math.min(readyIdx++, readySnapshots.length - 1)] ?? [];
      return snap.map((id) => ({ id, title: `task ${id}` }));
    },
    refreshScope: async () => {},
    spawnAwait: async (type, _prompt, _desc) => {
      spawns.push(type);
      return workers[workerIdx++];
    },
    notify: (m) => notices.push(m),
    setStatus: () => {},
    buildImplPrompt: (task, feedback) => `impl:${task.id}${feedback ? ":fb" : ""}`,
    buildVerifyPrompt: (task) => `verify:${task.id}`,
  };
  return { deps, bdCalls, notices, spawns };
}

const ok = (text: string): WorkerResult => ({ status: "completed", result: text });
const PASS = ok("## Verdict\nPASS — good");
const FAIL = ok("## Verdict\nFAIL — broken");

test("happy path: two tasks close in order, sync at end", async () => {
  const { deps, bdCalls } = fakeDeps([["a", "b"], ["b"], []], [ok("did a"), PASS, ok("did b"), PASS]);
  const run = startImplementRun(deps, "lbl");
  const done = await run.finished;
  assert.deepEqual(done, ["✓ a", "✓ b"]);
  assert.ok(bdCalls.some((c) => c[0] === "close" && c[1] === "a"));
  assert.ok(bdCalls.some((c) => c[0] === "close" && c[1] === "b"));
  assert.deepEqual(bdCalls.at(-1), ["sync"]);
});

test("verify FAIL → one retry with feedback → PASS closes", async () => {
  const { deps } = fakeDeps([["a"], []], [ok("v1"), FAIL, ok("v2"), PASS]);
  const done = await startImplementRun(deps, "l").finished;
  assert.deepEqual(done, ["✓ a"]);
});

test("verify FAIL twice → task fails, bead reopened, run continues to next", async () => {
  const { deps, bdCalls } = fakeDeps([["a", "b"], ["b"], []], [ok("v1"), FAIL, ok("v2"), FAIL, ok("b1"), PASS]);
  const done = await startImplementRun(deps, "l").finished;
  assert.deepEqual(done, ["✗ a (FAIL)", "✓ b"]);
  assert.ok(bdCalls.some((c) => c[0] === "update" && c[1] === "a" && c.includes("open")));
});

test("worker status stopped → run halts, bead reopened, sync still runs", async () => {
  const { deps, bdCalls } = fakeDeps([["a", "b"]], [{ status: "stopped", result: "" }]);
  const done = await startImplementRun(deps, "l").finished;
  assert.deepEqual(done, []);
  assert.ok(bdCalls.some((c) => c[0] === "update" && c[1] === "a" && c.includes("open")));
  assert.deepEqual(bdCalls.at(-1), ["sync"]);
});

test("worker infra failure (error/aborted) is labeled and never sent to a verifier", async () => {
  const { deps, spawns } = fakeDeps([["a"], []], [{ status: "error", result: "" }, { status: "aborted", result: "" }]);
  const done = await startImplementRun(deps, "l").finished;
  assert.deepEqual(done, ["✗ a (worker aborted)"]);
  assert.ok(spawns.every((s) => s === "wb-implementer")); // no verifier on infra failure
});

test("steered (turn-limit wrap-up) counts as completed and gets verified", async () => {
  const { deps } = fakeDeps([["a"], []], [{ status: "steered", result: "partial work" }, PASS]);
  const done = await startImplementRun(deps, "l").finished;
  assert.deepEqual(done, ["✓ a"]);
});

test("spawn failure (undefined) halts the run with the bead reopened", async () => {
  const { deps, bdCalls } = fakeDeps([["a"]], [undefined]);
  const done = await startImplementRun(deps, "l").finished;
  assert.deepEqual(done, []);
  assert.ok(bdCalls.some((c) => c[0] === "update" && c[1] === "a" && c.includes("open")));
});

test("dry → scope refresh finds late-added task → continues", async () => {
  const { deps } = fakeDeps([["a"], [], ["c"], [], []], [ok("a1"), PASS, ok("c1"), PASS]);
  const done = await startImplementRun(deps, "l").finished;
  assert.deepEqual(done, ["✓ a", "✓ c"]);
});

test("stop() halts between tasks", async () => {
  const { deps } = fakeDeps([["a", "b"], ["b"]], [ok("a1"), PASS, ok("b1"), PASS]);
  const run = startImplementRun(deps, "l");
  run.stop();
  const done = await run.finished;
  assert.ok(done.length <= 1);
});

test("HARD_CAP bounds the run", async () => {
  const many = Array.from({ length: HARD_CAP + 50 }, (_, i) => `t${i}`);
  const workers = many.flatMap((t) => [ok(`w${t}`), PASS]);
  const { deps } = fakeDeps([many], workers);
  const done = await startImplementRun(deps, "l").finished;
  assert.equal(done.length, HARD_CAP);
});

test("a thrown dep error fails the task, not the process; run finishes with sync", async () => {
  const { deps, bdCalls } = fakeDeps([["a"], []], []);
  deps.spawnAwait = async () => {
    throw new Error("boom");
  };
  const done = await startImplementRun(deps, "l").finished;
  assert.equal(done.length, 0);
  assert.ok(bdCalls.some((c) => c[0] === "update" && c[1] === "a" && c.includes("open")));
  assert.deepEqual(bdCalls.at(-1), ["sync"]);
});

test("view() exposes label, progress, and current task/phase", async () => {
  let release: (v: WorkerResult) => void = () => {};
  const gate = new Promise<WorkerResult>((r) => (release = r));
  const { deps } = fakeDeps([["a"], []], []);
  deps.spawnAwait = () => gate;
  const run = startImplementRun(deps, "mylabel");
  await new Promise((r) => setTimeout(r, 10));
  const v = run.view();
  assert.equal(v.label, "mylabel");
  assert.equal(v.current?.taskId, "a");
  assert.equal(v.current?.phase, "impl");
  release({ status: "stopped", result: "" });
  await run.finished;
});
