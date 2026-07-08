/**
 * workbench-pi — a Pi port of the workbench research→design→execution→implement
 * workflow, tuned for small local models (qwen3.6:35b) with a tier switch up to
 * capable models.
 *
 * Phase 0: skeleton. Registers a help command, a ping tool, and a tier-aware
 * system-prompt banner so we can verify the extension loads and wires into Pi.
 * Subsequent phases add: project scaffolding, path grounding, narrow subagents,
 * the small-tier orchestrator, beads tooling, and discipline gates.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveTier, type Tier } from "./tier.js";
import { systemPromptFragment, researchDelegationPrompt, designDelegationPrompt, editFailureTip } from "./prompts.js";
import { parseProjectArgs, scaffoldProject } from "./tools/scaffold-project.js";
import { groundPaths, extractCitedPaths } from "./tools/verify-paths.js";
import { syncAgents, agentsTargetDir } from "./setup.js";
import { pickPlanDir, assembleResearchBody, setStatusAndReplaceBody, assembleDesignDraft, annotateUngrounded, discoverTasksPaths, matchTasksPaths } from "./orchestrator.js";
import { parseTaskPlan, assembleTasksBody, extractEpicId } from "./execution.js";
import { planBeadsTree, createBeadsTree, isBeadId, parseIds } from "./tools/beads.js";
import { claimGate, writeGate, isVerificationCommand } from "./gates.js";
import { parseReadyIssues, parseVerdict, type ReadyIssue } from "./implement.js";
import { startImplementRun, type RunHandle } from "./coordinator.js";
import { parseBeadDetail, detectTestCommand, extractTestCommandFromFrontmatter, buildContextPack } from "./context-pack.js";

/** Minimal view of the @tintinweb/pi-subagents manager exposed via globalThis. */
interface SpawnOpts {
  description: string;
  onToolActivity?: (a: { type: string; toolName?: string }) => void;
  signal?: AbortSignal;
  isBackground?: boolean;
}
interface AgentRecordView {
  result?: string;
  error?: string;
  status: string;
  /** Resolves when the agent reaches a terminal state (result/status then final). */
  promise?: Promise<unknown>;
}
interface SubagentManager {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: SpawnOpts): string;
  getRecord(id: string): AgentRecordView | undefined;
}
function subagentManager(): SubagentManager | undefined {
  return (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as SubagentManager | undefined;
}

const VERSION = "0.0.1";
const AGENTS_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");

function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function workbenchPi(pi: ExtensionAPI) {
  let tier: Tier = resolveTier();

  // Discipline-gate state. Gates arm only while implementMode is on (entered by
  // /wb-implement) and can be bypassed for the session with /wb-override.
  let implementMode = false;
  let gatesOverridden = false;
  let verifiedThisTurn = false; // a verification command ran this turn
  let failingTestObserved = false; // a test run failed (Red) — clears when tests pass (Green)
  const gatesArmed = () => implementMode && !gatesOverridden;

  const plansRootOf = (cwd: string) => join(cwd, "docs", "plans");
  const findPlanDir = (cwd: string, selector?: string): string | undefined => {
    const root = plansRootOf(cwd);
    return pickPlanDir(existsSync(root) ? readdirSync(root) : [], selector);
  };
  const runAgent = async (mgr: SubagentManager, ctx: unknown, type: string, prompt: string, desc: string): Promise<string> => {
    // Surface the worker's live tool in the status line — otherwise a spawned subagent
    // runs invisibly (the status line would sit frozen on the task label).
    const setS = (ctx as { ui?: { setStatus?: (id: string, s?: string) => void } })?.ui?.setStatus;
    const id = mgr.spawn(pi, ctx, type, prompt, {
      description: desc,
      signal: (ctx as { signal?: AbortSignal }).signal, // Esc/abort stops the worker too
      onToolActivity: (a) => {
        if (a.type === "start" && a.toolName) setS?.("wb-agent", `${desc}: ${a.toolName}…`);
      },
    });
    // Await THIS record's promise, not waitForAll() — waitForAll also waits on any
    // background /wb-implement workers, which would hang this command mid-run.
    try {
      await mgr.getRecord(id)?.promise;
    } catch {
      /* terminal status/result still reflect the failure */
    }
    setS?.("wb-agent", undefined);
    return mgr.getRecord(id)?.result ?? "";
  };
  // Real repo paths: tracked + untracked-visible. Used for path grounding/validation.
  const gitUniverse = async (cwd: string, signal?: AbortSignal): Promise<string[]> => {
    const read = async (args: string[]) => {
      try {
        const r = await pi.exec("git", args, { cwd, signal, timeout: 10_000 });
        return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
      } catch {
        return [];
      }
    };
    return [...(await read(["ls-files"])), ...(await read(["ls-files", "--others", "--exclude-standard"]))];
  };

  // ---- Autonomous /wb-implement run (promise-based coordinator; see coordinator.ts) ----
  // The loop itself lives in src/coordinator.ts (tested with fakes). This block is
  // the thin adapter layer: bd/scoping, background spawn-and-await, and deterministic
  // context provisioning for workers.
  const bd = (cwd: string, a: string[]) =>
    pi.exec("bd", a, { cwd, timeout: 15_000 }).catch(() => ({ code: 1, stdout: "", stderr: "bd not found", killed: false }));

  const readyLeaves = async (cwd: string, closure: Set<string>, parents: Set<string>) =>
    parseReadyIssues((await bd(cwd, ["ready", "--limit", "1000", "--json"])).stdout).filter((t) => closure.has(t.id) && !parents.has(t.id));

  // Descendant closure of `root` across dependency + parent-child edges; `parents` =
  // umbrella nodes (open children) to skip in favor of concrete leaf work.
  const computeScope = async (cwd: string, root: string) => {
    const closure = new Set<string>([root]);
    const parents = new Set<string>();
    const depDesc = parseIds((await bd(cwd, ["dep", "tree", root, "--direction", "down", "--json"])).stdout);
    depDesc.forEach((d) => closure.add(d));
    const queue = [root, ...depDesc];
    while (queue.length) {
      const id = queue.shift() as string;
      const kids = parseIds((await bd(cwd, ["list", "--parent", id, "--json"])).stdout);
      if (kids.length) parents.add(id);
      for (const k of kids) if (!closure.has(k)) { closure.add(k); queue.push(k); }
    }
    return { closure, parents };
  };

  // One run at a time; state lives on the handle, ctx is snapshotted at start —
  // no module-level session ctx that a /new session or second invocation could clobber.
  let activeRun: RunHandle | undefined;
  let activeRunAbort: AbortController | undefined;

  /** Spawn a background worker and await ITS record's terminal state. */
  const spawnAwaitWorker = async (
    ctx: unknown,
    type: string,
    prompt: string,
    desc: string,
    signal: AbortSignal,
    setS: (s?: string) => void,
  ): Promise<{ status: string; result: string } | undefined> => {
    const mgr = subagentManager();
    if (!mgr) return undefined;
    let id: string;
    try {
      id = mgr.spawn(pi, ctx, type, prompt, {
        description: desc,
        isBackground: true, // non-blocking — the session stays live (/agents works mid-run)
        signal,
        onToolActivity: (a) => {
          if (a.type === "start" && a.toolName) setS(`${desc}: ${a.toolName}…`);
        },
      });
    } catch {
      return undefined; // e.g. assertValidSpawnCwd — caller halts the run cleanly
    }
    try {
      await mgr.getRecord(id)?.promise;
    } catch {
      /* terminal status reflects the failure */
    }
    const rec = mgr.getRecord(id);
    return { status: rec?.status ?? "error", result: rec?.result ?? "" };
  };

  // Deterministic context provisioning: replace-mode subagents never see AGENTS.md
  // (pi-subagents suppresses context files), so the orchestrator hands every worker
  // the project rules, the runbook (how to run tests HERE), and the full task detail.
  const buildRunContext = (cwd: string, tasksMdRel?: string) => {
    const readIf = (p: string) => (existsSync(join(cwd, p)) ? readFileSync(join(cwd, p), "utf-8") : undefined);
    let pkgTestScript = false;
    try {
      const pkg = JSON.parse(readIf("package.json") ?? "{}") as { scripts?: { test?: unknown } };
      pkgTestScript = typeof pkg.scripts?.test === "string";
    } catch {
      /* unparseable package.json → no test script */
    }
    const fm = tasksMdRel ? readIf(tasksMdRel) : undefined;
    const testCommand = detectTestCommand({
      explicit: fm ? extractTestCommandFromFrontmatter(fm) : undefined,
      mise: ["mise.toml", ".mise.toml", ".tool-versions"].some((f) => existsSync(join(cwd, f))),
      gemfile: existsSync(join(cwd, "Gemfile")),
      specDir: existsSync(join(cwd, "spec")),
      pkgTestScript,
    });
    let agentsMd: { path: string; content?: string } | undefined;
    for (const f of ["AGENTS.md", "CLAUDE.md"]) {
      const content = readIf(f);
      if (content !== undefined) {
        agentsMd = content.length <= 4000 ? { path: f, content } : { path: f };
        break;
      }
    }
    return { testCommand, agentsMd, planDir: tasksMdRel ? dirname(tasksMdRel) : undefined };
  };

  pi.registerTool({
    name: "wb_ping",
    label: "Workbench Ping",
    description:
      "Health check for the workbench-pi extension. Returns the extension version and the active tier (small | capable). Use only when explicitly asked to verify workbench-pi is loaded.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: `workbench-pi v${VERSION} active (tier: ${tier})` }],
        details: { version: VERSION, tier },
      };
    },
  });

  pi.registerTool({
    name: "wb_verify_paths",
    label: "Verify Paths",
    description:
      "Check that file paths actually exist in this repo before you reference, read, or edit them. " +
      "Returns which paths are real and, for the rest, the closest real candidates. " +
      "Use this whenever you are about to cite a path you have not directly observed — it prevents hallucinated paths.",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { description: "Proposed repo-relative paths to verify" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const universe = await gitUniverse(ctx.cwd, signal);
      const { real, missing } = groundPaths(params.paths, universe);
      const lines: string[] = [];
      if (real.length) lines.push(`REAL (${real.length}): ${real.join(", ")}`);
      if (missing.length) {
        lines.push(`MISSING (${missing.length}):`);
        for (const m of missing) {
          lines.push(`  - ${m.path}${m.suggestions.length ? ` — did you mean: ${m.suggestions.join(", ")}` : " — no close match"}`);
        }
      }
      return {
        content: [{ type: "text", text: lines.join("\n") || "No paths provided." }],
        details: { real, missing },
      };
    },
  });

  pi.registerCommand("wb-setup", {
    description: "Install the workbench subagents into ~/.pi/agent/agents so they're available to spawn",
    handler: async (_args, ctx) => {
      const target = agentsTargetDir();
      try {
        const plan = syncAgents(AGENTS_SRC, target);
        const wrote = plan.toWrite.length;
        const msg =
          wrote > 0
            ? `Synced ${wrote} agent(s) to ${target}: ${plan.toWrite.join(", ")}. Start a new Pi session to load them (requires @tintinweb/pi-subagents).`
            : `Workbench agents already current in ${target} (${plan.unchanged.length}).`;
        ctx.ui.notify(msg, "info");
      } catch (e) {
        ctx.ui.notify(`wb-setup failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("wb-research", {
    description: "Research the codebase for a topic into research.md (small tier: orchestrated subagents)",
    handler: async (args, ctx) => {
      const topic = (args ?? "").trim();
      if (!topic) {
        ctx.ui.notify("Usage: /wb-research <topic>", "warning");
        return;
      }
      const planDir = findPlanDir(ctx.cwd);
      if (!planDir) {
        ctx.ui.notify("No plan found under docs/plans/. Run /wb-project first.", "warning");
        return;
      }
      // Capable tier: the model researches and synthesizes research.md itself.
      if (resolveTier(ctx.model?.id) === "capable") {
        pi.sendUserMessage(researchDelegationPrompt(topic, planDir));
        return;
      }
      // Small tier: extension-owned orchestration + deterministic assembly.
      const mgr = subagentManager();
      if (!mgr) {
        ctx.ui.notify("wb-research (small tier) needs @tintinweb/pi-subagents + /wb-setup.", "error");
        return;
      }
      const researchPath = join(plansRootOf(ctx.cwd), planDir, "research.md");

      const setStatus = (s: string | undefined) => ctx.ui.setStatus?.("wb-research", s);
      // Await each spawned record's own promise (never waitForAll — that would also
      // wait on any background /wb-implement workers and hang this command mid-run).
      const awaitRecord = async (id: string) => {
        try {
          await mgr.getRecord(id)?.promise;
        } catch {
          /* terminal status/result reflect the failure */
        }
        return mgr.getRecord(id)?.result ?? "";
      };
      try {
        setStatus("locating…");
        const locId = mgr.spawn(pi, ctx, "wb-locator",
          `Topic: ${topic}\nFind the files and directories in this repo relevant to this topic.`,
          { description: `locate: ${topic}` });
        const locator = await awaitRecord(locId);

        setStatus("analyzing…");
        const anId = mgr.spawn(pi, ctx, "wb-analyzer",
          `Topic: ${topic}\nAnalyze how the following code works, with file:line refs. Relevant locations:\n${locator}`,
          { description: `analyze: ${topic}` });
        const paId = mgr.spawn(pi, ctx, "wb-pattern",
          `Concept: ${topic}\nFind existing patterns/conventions for this, with cited examples. Relevant locations:\n${locator}`,
          { description: `patterns: ${topic}` });
        const [analyzer, pattern] = await Promise.all([awaitRecord(anId), awaitRecord(paId)]);

        const body = assembleResearchBody(topic, [
          { heading: "Locations (wb-locator)", body: locator },
          { heading: "How it works (wb-analyzer)", body: analyzer },
          { heading: "Existing patterns (wb-pattern)", body: pattern },
        ]);

        // In-pipeline validation: ground cited paths and flag hallucinations (qwen's #1 failure).
        setStatus("validating citations…");
        const { real, missing } = groundPaths(extractCitedPaths(body), await gitUniverse(ctx.cwd));
        const validated = annotateUngrounded(body, missing.map((m) => m.path));

        const existing = existsSync(researchPath) ? readFileSync(researchPath, "utf-8") : "";
        writeFileSync(researchPath, setStatusAndReplaceBody(existing, "in-progress", validated), "utf-8");
        setStatus(undefined);
        const cited = real.length + missing.length;
        const note = cited ? ` ${real.length}/${cited} citations grounded${missing.length ? `, ${missing.length} flagged unverified` : ""}.` : "";
        ctx.ui.notify(`research.md → docs/plans/${planDir}/research.md.${note} Review & refine.`, missing.length ? "warning" : "info");
      } catch (e) {
        setStatus(undefined);
        ctx.ui.notify(`wb-research failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("wb-design", {
    description: "Draft design.md for a topic (small: gather context + decisions checklist; capable: model-led)",
    handler: async (args, ctx) => {
      const topic = (args ?? "").trim();
      if (!topic) {
        ctx.ui.notify("Usage: /wb-design <topic>", "warning");
        return;
      }
      const planDir = findPlanDir(ctx.cwd);
      if (!planDir) {
        ctx.ui.notify("No plan found under docs/plans/. Run /wb-project first.", "warning");
        return;
      }
      const designPath = join(plansRootOf(ctx.cwd), planDir, "design.md");

      if (resolveTier(ctx.model?.id) === "capable") {
        pi.sendUserMessage(designDelegationPrompt(topic, planDir));
        return;
      }

      const mgr = subagentManager();
      if (!mgr) {
        ctx.ui.notify("wb-design (small tier) needs @tintinweb/pi-subagents + /wb-setup.", "error");
        return;
      }
      const setStatus = (s: string | undefined) => ctx.ui.setStatus?.("wb-design", s);
      try {
        setStatus("gathering context…");
        const pattern = await runAgent(mgr, ctx, "wb-pattern", `Concept: ${topic}\nFind existing patterns/conventions relevant to designing this.`, `design ctx: ${topic}`);
        const analyzer = await runAgent(mgr, ctx, "wb-analyzer", `Topic: ${topic}\nExplain how the most relevant existing code works (constraints a design must respect).`, `design ctx: ${topic}`);
        const body = assembleDesignDraft(topic, [
          { heading: "Existing patterns (wb-pattern)", body: pattern },
          { heading: "How relevant code works (wb-analyzer)", body: analyzer },
        ]);
        const existing = existsSync(designPath) ? readFileSync(designPath, "utf-8") : "";
        writeFileSync(designPath, setStatusAndReplaceBody(existing, "draft", body), "utf-8");
        setStatus(undefined);
        ctx.ui.notify(`design.md draft → docs/plans/${planDir}/design.md. Fill the Decisions, then /wb-execution.`, "info");
      } catch (e) {
        setStatus(undefined);
        ctx.ui.notify(`wb-design failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("wb-execution", {
    description: "Plan phased tasks from design.md and create the beads issue tree",
    handler: async (args, ctx) => {
      const mgr = subagentManager();
      if (!mgr) {
        ctx.ui.notify("wb-execution needs @tintinweb/pi-subagents + /wb-setup.", "error");
        return;
      }
      const planDir = findPlanDir(ctx.cwd);
      if (!planDir) {
        ctx.ui.notify("No plan found under docs/plans/. Run /wb-project first.", "warning");
        return;
      }
      if ((await bd(ctx.cwd, ["version"])).code !== 0) {
        ctx.ui.notify("beads CLI (bd) not found. Install bd to use /wb-execution.", "error");
        return;
      }
      if ((await bd(ctx.cwd, ["where"])).code !== 0) {
        ctx.ui.notify("beads not initialized here. Run `bd init` (or /beads:init) first.", "warning");
        return;
      }

      const setStatus = (s: string | undefined) => ctx.ui.setStatus?.("wb-execution", s);
      try {
        setStatus("planning tasks…");
        const planMd = await runAgent(mgr, ctx, "wb-planner",
          `Plan directory: docs/plans/${planDir}. Read its design.md and research.md, then produce the phased task plan.`,
          "plan tasks");
        const phases = parseTaskPlan(planMd);
        if (phases.length === 0) {
          setStatus(undefined);
          ctx.ui.notify("Planner produced no tasks — is design.md filled in?", "warning");
          return;
        }
        const epicTitle = (args ?? "").trim() || planDir;

        if (ctx.hasUI) {
          const summary = phases.map((p, i) => `Phase ${i + 1}: ${p.name} (${p.tasks.length} tasks)`).join("\n");
          const choice = await ctx.ui.select(`Create beads epic "${epicTitle}"?\n${summary}`, ["Create", "Cancel"]);
          if (choice !== "Create") {
            setStatus(undefined);
            ctx.ui.notify("wb-execution cancelled.", "info");
            return;
          }
        }

        setStatus("creating beads issues…");
        const plan = planBeadsTree(epicTitle, phases);
        const res = await createBeadsTree(pi, ctx.cwd, plan, ctx.signal);

        const tasksPath = join(plansRootOf(ctx.cwd), planDir, "tasks.md");
        const existing = existsSync(tasksPath) ? readFileSync(tasksPath, "utf-8") : "";
        writeFileSync(tasksPath, setStatusAndReplaceBody(existing, "in-progress", assembleTasksBody(epicTitle, phases, res.refToId)), "utf-8");
        await bd(ctx.cwd, ["sync"]);
        setStatus(undefined);

        const issueCount = Object.keys(res.refToId).length - 1;
        const errNote = res.errors.length ? ` — ${res.errors.length} error(s): ${res.errors[0]}` : "";
        ctx.ui.notify(`Epic ${res.epicId || "(none)"} + ${issueCount} issues; tasks.md written${errNote}.`, res.errors.length ? "warning" : "info");
      } catch (e) {
        setStatus(undefined);
        ctx.ui.notify(`wb-execution failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("wb-implement", {
    description: "Start an autonomous, observable, steerable implement loop over a target's subtree. Arg [target] = epic id | tasks.md path | substring.",
    handler: async (args, ctx) => {
      if (activeRun) {
        const v = activeRun.view();
        ctx.ui.notify(`wb-implement already running [${v.label}] — ${v.done.length} done${v.current ? `, now ${v.current.phase} ${v.current.taskId}` : ""}. /wb-status, /wb-stop, or /agents.`, "warning");
        return;
      }
      if (!subagentManager()) { ctx.ui.notify("wb-implement needs @tintinweb/pi-subagents + /wb-setup.", "error"); return; }
      if ((await bd(ctx.cwd, ["version"])).code !== 0) { ctx.ui.notify("beads CLI (bd) not found.", "error"); return; }
      if ((await bd(ctx.cwd, ["where"])).code !== 0) { ctx.ui.notify("beads not initialized here. Run `bd init` first.", "warning"); return; }

      // Resolve the target root — arg = epic id | tasks.md path | substring (default: sole plan).
      const arg = (args ?? "").trim();
      let root: string | undefined;
      let label = arg || "current plan";
      let tasksMdRel: string | undefined;
      if (arg && isBeadId(arg) && (await bd(ctx.cwd, ["show", arg, "--json"])).code === 0) {
        root = arg;
        label = `target ${arg}`;
      } else {
        const tasksPaths = discoverTasksPaths(await gitUniverse(ctx.cwd));
        const matches = matchTasksPaths(tasksPaths, arg);
        if (matches.length === 0) {
          ctx.ui.notify((arg ? `No plan matches "${arg}".` : "No plan found.") + (tasksPaths.length ? ` Found tasks.md at: ${tasksPaths.join(", ")}` : " Run /wb-project + /wb-execution."), "warning");
          return;
        }
        if (matches.length > 1) {
          ctx.ui.notify(`Multiple plans match${arg ? ` "${arg}"` : ""}: ${matches.join(", ")}. Re-run with a specific path, substring, or the epic id.`, "warning");
          return;
        }
        tasksMdRel = matches[0];
        label = dirname(tasksMdRel);
        root = extractEpicId(readFileSync(join(ctx.cwd, tasksMdRel), "utf-8"));
        if (!root) {
          ctx.ui.notify(`No beads epic in ${tasksMdRel} (looked for \`beads_epic:\` frontmatter or \`Epic: …\` body). Run /wb-execution or pass the epic id.`, "warning");
          return;
        }
      }
      const rootId = root;

      ctx.ui.setStatus?.("wb-run", "scoping…");
      let scope = await computeScope(ctx.cwd, rootId);
      const runCtx = buildRunContext(ctx.cwd, tasksMdRel);
      ctx.ui.setStatus?.("wb-run", undefined);
      if ((await readyLeaves(ctx.cwd, scope.closure, scope.parents)).length === 0) {
        ctx.ui.notify(`No ready leaf tasks for ${label} (${rootId}; ${scope.closure.size} in scope). All done/blocked, only umbrellas left, or run /wb-execution.`, "info");
        return;
      }

      // Snapshot everything the run needs at START — no module-level session ctx.
      const cwd = ctx.cwd;
      const startCtx = ctx;
      const setS = (s?: string) => startCtx.ui.setStatus?.("wb-run", s);
      const abort = new AbortController();
      // Full bead detail + runbook + project rules for every worker (context pack).
      const packFor = async (t: ReadyIssue) => {
        const detail = parseBeadDetail((await bd(cwd, ["show", t.id, "--json"])).stdout) ?? { id: t.id, title: t.title };
        return buildContextPack({ task: detail, testCommand: runCtx.testCommand, agentsMd: runCtx.agentsMd, planDir: runCtx.planDir });
      };

      const run = startImplementRun(
        {
          bd: (a) => bd(cwd, a),
          ready: () => readyLeaves(cwd, scope.closure, scope.parents),
          refreshScope: async () => {
            scope = await computeScope(cwd, rootId);
          },
          spawnAwait: (type, prompt, desc) => spawnAwaitWorker(startCtx, type, prompt, desc, abort.signal, setS),
          notify: (m, l) => startCtx.ui.notify(m, l as "info"),
          setStatus: setS,
          buildImplPrompt: async (t, feedback) =>
            `${await packFor(t)}\n\n## Instruction\nImplement this task and ONLY this task, strict TDD (failing test first).` +
            (feedback ? `\n\nA previous attempt FAILED verification:\n${feedback}\nFix those specific problems.` : ""),
          buildVerifyPrompt: async (t, work) =>
            `${await packFor(t)}\n\n## Instruction\nVerify the work just done for this task: run the tests` +
            `${runCtx.testCommand ? ` with \`${runCtx.testCommand}\`` : ""} and check scope. Worker report:\n${work}`,
        },
        label,
      );
      activeRun = run;
      activeRunAbort = abort;
      implementMode = true; // arm the parent-session discipline gates for the run's duration
      void run.finished.finally(() => {
        if (activeRun === run) {
          activeRun = undefined;
          activeRunAbort = undefined;
        }
        implementMode = false;
      });
      ctx.ui.notify(`wb-implement started [${label}]${runCtx.testCommand ? ` (tests: ${runCtx.testCommand})` : ""} — autonomous. Observe: /wb-status, /agents. Halt: /wb-stop.`, "info");
    },
  });

  pi.registerCommand("wb-stop", {
    description: "Halt the running /wb-implement loop after the current task; `/wb-stop now` also aborts the current worker",
    handler: async (args, ctx) => {
      if (!activeRun) {
        ctx.ui.notify("No wb-implement run in progress.", "info");
        return;
      }
      activeRun.stop();
      if ((args ?? "").trim() === "now") {
        activeRunAbort?.abort();
        ctx.ui.notify("Stopping wb-implement NOW — current worker aborted; its task will be reopened.", "info");
        return;
      }
      const v = activeRun.view();
      ctx.ui.notify(`Stopping wb-implement after ${v.current?.taskId ?? "the current task"}. Use \`/wb-stop now\` (or /agents) to abort the in-flight worker too.`, "info");
    },
  });

  pi.registerCommand("wb-status", {
    description: "Show the running /wb-implement loop's progress",
    handler: async (_args, ctx) => {
      if (!activeRun) {
        ctx.ui.notify("No wb-implement run in progress.", "info");
        return;
      }
      const v = activeRun.view();
      ctx.ui.notify(
        `wb-implement [${v.label}]: ${v.done.length} done (${v.done.join(" ") || "—"})` +
          `${v.current ? `; now ${v.current.phase} ${v.current.taskId}${v.current.attempt > 1 ? " (retry)" : ""}` : ""}${v.stopping ? "; stopping…" : ""}`,
        "info",
      );
    },
  });

  pi.registerCommand("wb-validate", {
    description: "Validate the implementation against the plan (runs tests + verifier, writes validation.md)",
    handler: async (_args, ctx) => {
      implementMode = false; // validation disarms the implement gates
      const mgr = subagentManager();
      if (!mgr) {
        ctx.ui.notify("wb-validate needs @tintinweb/pi-subagents + /wb-setup.", "error");
        return;
      }
      const planDir = findPlanDir(ctx.cwd);
      if (!planDir) {
        ctx.ui.notify("No plan found under docs/plans/. Run /wb-project first.", "warning");
        return;
      }
      const setStatus = (s: string | undefined) => ctx.ui.setStatus?.("wb-validate", s);
      try {
        setStatus("validating…");
        const report = await runAgent(mgr, ctx, "wb-verifier",
          `Validate this project against its plan in docs/plans/${planDir}/tasks.md. ` +
            `Run the full fast test suite, confirm the planned tasks are actually implemented, and report PASS/FAIL with evidence.`,
          "validate");
        const verdict = parseVerdict(report);
        const path = join(plansRootOf(ctx.cwd), planDir, "validation.md");
        writeFileSync(path, `# Validation: ${planDir}\n\nVerdict: ${verdict}\n\n${report}\n`, "utf-8");
        setStatus(undefined);
        ctx.ui.notify(`wb-validate: ${verdict} → docs/plans/${planDir}/validation.md`, verdict === "PASS" ? "info" : "warning");
      } catch (e) {
        setStatus(undefined);
        ctx.ui.notify(`wb-validate failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("wb-override", {
    description: "Toggle the workbench discipline gates off/on for this session (escape hatch)",
    handler: async (_args, ctx) => {
      gatesOverridden = !gatesOverridden;
      ctx.ui.notify(`workbench-pi gates ${gatesOverridden ? "BYPASSED" : "re-armed"} for this session.`, "info");
    },
  });

  pi.registerCommand("wb-help", {
    description: "Show workbench-pi commands and the active tier",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `workbench-pi v${VERSION} — tier: ${tier}. Pipeline: /wb-project, /wb-research, /wb-design, /wb-execution, /wb-implement, /wb-validate.`,
        "info",
      );
    },
  });

  async function gitMeta(cwd: string): Promise<{ branch?: string; commit?: string }> {
    const read = async (args: string[]) => {
      try {
        const r = await pi.exec("git", args, { timeout: 5 });
        return r.code === 0 ? r.stdout.trim() : undefined;
      } catch {
        return undefined;
      }
    };
    return {
      branch: await read(["rev-parse", "--abbrev-ref", "HEAD"]),
      commit: await read(["rev-parse", "--short", "HEAD"]),
    };
  }

  pi.registerCommand("wb-project", {
    description: "Scaffold a new workbench plan: /wb-project [TICKET-123] <name>",
    handler: async (args, ctx) => {
      const { ticket, name } = parseProjectArgs(args ?? "");
      if (!name) {
        ctx.ui.notify("Usage: /wb-project [TICKET-123] <project name>", "warning");
        return;
      }
      const { branch, commit } = await gitMeta(ctx.cwd);
      const res = scaffoldProject({ cwd: ctx.cwd, date: isoDate(), name, ticket, gitBranch: branch, gitCommit: commit });
      const summary =
        res.created.length > 0
          ? `Created ${res.dir}/ (${res.created.join(", ")}). Next: /wb-research`
          : `${res.dir}/ already exists (kept ${res.skipped.join(", ")}).`;
      ctx.ui.notify(summary, "info");
    },
  });

  // Keep the resolved tier current as the model is (re)selected.
  pi.on("session_start", async (_event, ctx) => {
    tier = resolveTier(ctx.model?.id);
  });

  // Don't leave an autonomous run driving beads after the session goes away.
  pi.on("session_shutdown", async () => {
    activeRun?.stop();
    activeRunAbort?.abort();
  });

  // Inject the tier-appropriate workflow instructions.
  pi.on("before_agent_start", async (event, ctx) => {
    tier = resolveTier(ctx.model?.id);
    return { systemPrompt: `${event.systemPrompt}\n\n${systemPromptFragment(tier)}\n` };
  });

  // --- Discipline gates (armed only during /wb-implement; /wb-override bypasses) ---
  pi.on("turn_start", async () => {
    verifiedThisTurn = false;
  });

  // Small-tier (qwen) reinforcement: on an edit failure, append a corrective tip at
  // the point of failure — qwen tends to reconstruct file content from memory instead
  // of re-reading. Not gated on implementMode (mis-edits happen any time); capable
  // models are excluded inside editFailureTip.
  pi.on("tool_result", async (event) => {
    const tip = editFailureTip(tier, event.toolName, event.isError);
    if (!tip) return;
    return { content: [...event.content, { type: "text", text: `\n\n${tip}` }] };
  });

  // Observe verification runs so the gates know test state.
  pi.on("tool_result", async (event) => {
    if (!implementMode || event.toolName !== "bash") return;
    const cmd = String((event.input as Record<string, unknown>)?.command ?? "");
    if (!isVerificationCommand(cmd)) return;
    verifiedThisTurn = !event.isError; // a passing verification enables done-claims
    failingTestObserved = event.isError === true; // a failing test (Red) enables source writes
  });

  // Block production-code writes before a failing test (Red→Green).
  pi.on("tool_call", async (event) => {
    if (!gatesArmed() || (event.toolName !== "write" && event.toolName !== "edit")) return;
    const input = event.input as Record<string, unknown>;
    const path = String(input?.path ?? input?.file_path ?? "");
    if (!path) return;
    const d = writeGate(path, failingTestObserved);
    if (d.block) return { block: true, reason: d.reason };
  });

  // Soft backstop: nudge when a done-claim appears without a passing verification.
  pi.on("message_end", async (event, ctx) => {
    if (!gatesArmed()) return;
    const text = (event.message?.content ?? [])
      .map((c: { type: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : ""))
      .join(" ");
    if (claimGate(text, verifiedThisTurn).block) {
      ctx?.ui?.notify?.("workbench-pi: success claimed without a passing verification run this turn. Run the tests (or /wb-override).", "warning");
    }
  });
}
