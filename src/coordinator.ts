/**
 * coordinator — the autonomous /wb-implement loop as a testable, dependency-injected
 * unit. Replaces the event-bus id-matching state machine: the loop is a plain
 * detached async chain that awaits each worker's completion directly, so there is
 * no payload guessing, no status-string races, and errors can't strand the run.
 *
 * Principles (see docs/PLAN.md): autonomous (loop-until-dry, bounded by HARD_CAP),
 * observable (non-blocking; view() feeds /wb-status; setStatus streams phases),
 * steerable (stop() halts between tasks; a worker stopped via /agents halts the run).
 *
 * Worker terminal statuses are handled explicitly:
 *   completed/steered → proceed (steered = turn-limit wrap-up; verifier judges it)
 *   stopped           → user intervened → halt the whole run
 *   error/aborted     → infra failure → labeled task failure, never sent to verify
 * Bead hygiene is guaranteed: a claimed task is closed on PASS or reopened on any
 * other exit (fail/halt/throw), and `bd sync` always runs at the end.
 */

import { selectNextReady, parseVerdict, type ReadyIssue } from "./implement.ts";

export interface WorkerResult {
  status: string;
  result: string;
}

export interface CoordinatorDeps {
  /** beads writes (update/close/sync); must never reject in normal operation. */
  bd(args: string[]): Promise<{ code: number; stdout: string }>;
  /** Scope-filtered ready leaf tasks (scoping owned by the caller). */
  ready(): Promise<ReadyIssue[]>;
  /** Recompute the scope — called once when the run looks dry (picks up late-added tasks). */
  refreshScope(): Promise<void>;
  /** Spawn a background worker and resolve with its terminal result; undefined = could not spawn. */
  spawnAwait(type: "wb-implementer" | "wb-verifier", prompt: string, desc: string): Promise<WorkerResult | undefined>;
  notify(msg: string, level: string): void;
  setStatus(s?: string): void;
  buildImplPrompt(task: ReadyIssue, feedback?: string): string | Promise<string>;
  buildVerifyPrompt(task: ReadyIssue, work: string): string | Promise<string>;
}

export const HARD_CAP = 100; // runaway backstop on tasks attempted per run

export interface RunView {
  label: string;
  done: string[];
  current?: { taskId: string; phase: "impl" | "verify"; attempt: number };
  stopping: boolean;
}

export interface RunHandle {
  stop(): void;
  view(): RunView;
  finished: Promise<string[]>;
}

type Outcome = { kind: "pass" } | { kind: "fail"; reason: string } | { kind: "halt"; reason: string };

export function startImplementRun(deps: CoordinatorDeps, label: string): RunHandle {
  let stopping = false;
  const done: string[] = [];
  const attempted = new Set<string>();
  let current: RunView["current"];

  const runTask = async (task: ReadyIssue): Promise<Outcome> => {
    let feedback: string | undefined;
    let lastReason = "UNKNOWN";
    for (let attempt = 1; attempt <= 2; attempt++) {
      current = { taskId: task.id, phase: "impl", attempt };
      deps.setStatus(`impl ${task.id}${attempt > 1 ? " (retry)" : ""}…`);
      const impl = await deps.spawnAwait("wb-implementer", await deps.buildImplPrompt(task, feedback), `impl ${task.id}`);
      if (!impl) return { kind: "halt", reason: "could not spawn worker" };
      if (impl.status === "stopped") return { kind: "halt", reason: `worker for ${task.id} stopped by user` };
      if (impl.status !== "completed" && impl.status !== "steered") {
        lastReason = `worker ${impl.status}`;
        feedback = undefined; // infra failure — nothing useful to feed back
        continue;
      }

      current = { taskId: task.id, phase: "verify", attempt };
      deps.setStatus(`verify ${task.id}…`);
      const ver = await deps.spawnAwait("wb-verifier", await deps.buildVerifyPrompt(task, impl.result), `verify ${task.id}`);
      if (!ver) return { kind: "halt", reason: "could not spawn verifier" };
      if (ver.status === "stopped") return { kind: "halt", reason: `verifier for ${task.id} stopped by user` };
      if (ver.status !== "completed" && ver.status !== "steered") {
        lastReason = `verifier ${ver.status}`;
        continue;
      }

      if (parseVerdict(ver.result) === "PASS") return { kind: "pass" };
      lastReason = parseVerdict(ver.result);
      feedback = ver.result; // the verifier's report is the retry feedback
    }
    return { kind: "fail", reason: lastReason };
  };

  const finished = (async () => {
    let halt: string | undefined;
    try {
      while (!stopping && attempted.size < HARD_CAP) {
        let next = selectNextReady(await deps.ready(), attempted);
        if (!next) {
          await deps.refreshScope(); // dry-check refresh: pick up tasks added mid-run
          next = selectNextReady(await deps.ready(), attempted);
          if (!next) break; // genuinely dry
        }
        attempted.add(next.id);
        await deps.bd(["update", next.id, "--status", "in_progress"]);

        let outcome: Outcome;
        try {
          outcome = await runTask(next);
        } catch (e) {
          outcome = { kind: "halt", reason: e instanceof Error ? e.message : String(e) };
        }

        if (outcome.kind === "pass") {
          await deps.bd(["close", next.id]);
          done.push(`✓ ${next.id}`);
        } else {
          await deps.bd(["update", next.id, "--status", "open"]); // never strand a claimed bead
          if (outcome.kind === "fail") done.push(`✗ ${next.id} (${outcome.reason})`);
        }
        current = undefined;
        if (outcome.kind === "halt") {
          halt = outcome.reason;
          break;
        }
      }
    } catch (e) {
      halt = e instanceof Error ? e.message : String(e);
    } finally {
      try {
        await deps.bd(["sync"]);
      } catch {
        /* sync is best-effort */
      }
      deps.setStatus(undefined);
      current = undefined;
      const summary = done.length ? done.join("  ") : "no tasks completed";
      const suffix = halt ? ` — halted: ${halt}` : stopping ? " — stopped by user" : "";
      const bad = halt !== undefined || done.some((d) => d.startsWith("✗"));
      deps.notify(`wb-implement [${label}] (${done.length}): ${summary}${suffix}`, bad ? "warning" : "info");
    }
    return done;
  })();

  return {
    stop: () => {
      stopping = true;
    },
    view: () => ({ label, done: [...done], current, stopping }),
    finished,
  };
}
