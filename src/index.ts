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
import { parseReadyIssues, parseVerdict, selectNextReady, decideNext } from "./implement.js";

/** Minimal view of the @tintinweb/pi-subagents manager exposed via globalThis. */
interface SpawnOpts {
  description: string;
  onToolActivity?: (a: { type: string; toolName?: string }) => void;
  signal?: AbortSignal;
  isBackground?: boolean;
}
interface SubagentManager {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: SpawnOpts): string;
  waitForAll(): Promise<void>;
  getRecord(id: string): { result?: string; error?: string; status: string } | undefined;
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
    await mgr.waitForAll();
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

  // ---- Autonomous /wb-implement coordinator (event-driven, non-blocking) ----
  // Principles: autonomous (loop-until-dry), observable (session stays live so /agents
  // works + live status), steerable (/wb-stop, /agents stop). Workers run in the
  // background; the chain is driven by subagents:completed/failed events, not a
  // blocking loop that would freeze the session.
  type WbCtx = {
    cwd: string;
    ui: { notify: (m: string, level?: string) => void; setStatus?: (id: string, s?: string) => void };
  };
  let sessionCtx: WbCtx | undefined; // durable ctx for background spawns/notify (captured at session_start)
  interface ImplActive { taskId: string; title: string; phase: "impl" | "verify"; agentId: string; retried: boolean; work: string }
  interface ImplRun { root: string; label: string; closure: Set<string>; parents: Set<string>; attempted: Set<string>; results: string[]; stopping: boolean; active?: ImplActive }
  let implRun: ImplRun | undefined;

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

  const implPrompt = (t: { id: string; title: string }, feedback?: string) =>
    `Task ${t.id}: ${t.title}\nImplement this and ONLY this, TDD, in the current repo.` +
    (feedback ? `\n\nA previous attempt FAILED verification:\n${feedback}\nFix it.` : "");
  const verifyPrompt = (t: { id: string; title: string }, work: string) =>
    `Task ${t.id}: ${t.title}\nVerify the work just done: run the tests and check scope. Worker report:\n${work}`;

  const spawnWorker = (ctx: WbCtx, type: string, prompt: string, desc: string): string | undefined => {
    const mgr = subagentManager();
    if (!mgr) return undefined;
    return mgr.spawn(pi, ctx, type, prompt, {
      description: desc,
      isBackground: true, // non-blocking — session stays live and inspectable
      onToolActivity: (a) => { if (a.type === "start" && a.toolName) ctx.ui.setStatus?.("wb-run", `${desc}: ${a.toolName}…`); },
    });
  };

  const finishRun = (reason: string) => {
    const run = implRun;
    const ctx = sessionCtx;
    implRun = undefined;
    if (!ctx) return;
    void bd(ctx.cwd, ["sync"]);
    ctx.ui.setStatus?.("wb-run", undefined);
    const bad = run?.results.some((r) => r.startsWith("✗"));
    ctx.ui.notify(`wb-implement finished (${reason})${run ? ` [${run.label}]` : ""}: ${run?.results.join("  ") || "no tasks"}`, bad ? "warning" : "info");
  };

  const advanceRun = async () => {
    const run = implRun;
    const ctx = sessionCtx;
    if (!run || !ctx) return;
    if (run.stopping) return finishRun("stopped by user");
    const next = selectNextReady(await readyLeaves(ctx.cwd, run.closure, run.parents), run.attempted);
    if (!next) return finishRun("done");
    run.attempted.add(next.id);
    await bd(ctx.cwd, ["update", next.id, "--status", "in_progress"]);
    const agentId = spawnWorker(ctx, "wb-implementer", implPrompt(next), `impl ${next.id}`);
    if (!agentId) return finishRun("no subagent manager");
    run.active = { taskId: next.id, title: next.title, phase: "impl", agentId, retried: false, work: "" };
    ctx.ui.notify(`wb-implement: ${next.id} (${run.results.length} done)`, "info");
  };

  // Drive the impl→verify→close/retry/fail→next chain on each worker completion.
  const onWorkerEvent = async (payload: unknown) => {
    const run = implRun;
    const ctx = sessionCtx;
    if (!run?.active || !ctx) return;
    const p = (payload ?? {}) as { id?: string; result?: string; status?: string };
    if (p.id !== run.active.agentId) return; // not the worker we're awaiting
    const active = run.active;
    run.active = undefined;
    if (p.status === "stopped") return finishRun(`worker stopped at ${active.taskId}`); // user intervened via /agents
    const result = p.result ?? "";
    if (active.phase === "impl") {
      const agentId = spawnWorker(ctx, "wb-verifier", verifyPrompt(active, result), `verify ${active.taskId}`);
      if (agentId) { run.active = { ...active, phase: "verify", agentId, work: result }; return; }
      await bd(ctx.cwd, ["update", active.taskId, "--status", "open"]); run.results.push(`✗ ${active.taskId}`);
    } else {
      const decision = decideNext("verify", parseVerdict(result), active.retried);
      if (decision === "close") { await bd(ctx.cwd, ["close", active.taskId]); run.results.push(`✓ ${active.taskId}`); }
      else if (decision === "retry") {
        const agentId = spawnWorker(ctx, "wb-implementer", implPrompt(active, result), `impl ${active.taskId} (retry)`);
        if (agentId) { run.active = { ...active, phase: "impl", agentId, retried: true, work: "" }; return; }
        await bd(ctx.cwd, ["update", active.taskId, "--status", "open"]); run.results.push(`✗ ${active.taskId}`);
      } else { await bd(ctx.cwd, ["update", active.taskId, "--status", "open"]); run.results.push(`✗ ${active.taskId}`); }
    }
    await advanceRun();
  };
  (pi as { events?: { on?: (e: string, h: (p: unknown) => void) => void } }).events?.on?.("subagents:completed", onWorkerEvent);
  (pi as { events?: { on?: (e: string, h: (p: unknown) => void) => void } }).events?.on?.("subagents:failed", onWorkerEvent);

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
      try {
        setStatus("locating…");
        const locId = mgr.spawn(pi, ctx, "wb-locator",
          `Topic: ${topic}\nFind the files and directories in this repo relevant to this topic.`,
          { description: `locate: ${topic}` });
        await mgr.waitForAll();
        const locator = mgr.getRecord(locId)?.result ?? "";

        setStatus("analyzing…");
        const anId = mgr.spawn(pi, ctx, "wb-analyzer",
          `Topic: ${topic}\nAnalyze how the following code works, with file:line refs. Relevant locations:\n${locator}`,
          { description: `analyze: ${topic}` });
        const paId = mgr.spawn(pi, ctx, "wb-pattern",
          `Concept: ${topic}\nFind existing patterns/conventions for this, with cited examples. Relevant locations:\n${locator}`,
          { description: `patterns: ${topic}` });
        await mgr.waitForAll();
        const analyzer = mgr.getRecord(anId)?.result ?? "";
        const pattern = mgr.getRecord(paId)?.result ?? "";

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
      const bd = async (a: string[]) => pi.exec("bd", a, { cwd: ctx.cwd, timeout: 10_000 }).catch(() => ({ code: 1, stdout: "", stderr: "bd not found", killed: false }));
      if ((await bd(["version"])).code !== 0) {
        ctx.ui.notify("beads CLI (bd) not found. Install bd to use /wb-execution.", "error");
        return;
      }
      if ((await bd(["where"])).code !== 0) {
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
        await bd(["sync"]);
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
      sessionCtx = ctx as unknown as WbCtx; // background events use this
      if (implRun) {
        const a = implRun.active;
        ctx.ui.notify(`wb-implement already running [${implRun.label}] — ${implRun.results.length} done${a ? `, now ${a.phase} ${a.taskId}` : ""}. /wb-status, /wb-stop, or /agents.`, "warning");
        return;
      }
      if (!subagentManager()) { ctx.ui.notify("wb-implement needs @tintinweb/pi-subagents + /wb-setup.", "error"); return; }
      if ((await bd(ctx.cwd, ["version"])).code !== 0) { ctx.ui.notify("beads CLI (bd) not found.", "error"); return; }
      if ((await bd(ctx.cwd, ["where"])).code !== 0) { ctx.ui.notify("beads not initialized here. Run `bd init` first.", "warning"); return; }

      // Resolve the target root — arg = epic id | tasks.md path | substring (default: sole plan).
      const arg = (args ?? "").trim();
      let root: string | undefined;
      let label = arg || "current plan";
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
        label = dirname(matches[0]);
        root = extractEpicId(readFileSync(join(ctx.cwd, matches[0]), "utf-8"));
        if (!root) {
          ctx.ui.notify(`No beads epic in ${matches[0]} (looked for \`beads_epic:\` frontmatter or \`Epic: …\` body). Run /wb-execution or pass the epic id.`, "warning");
          return;
        }
      }

      ctx.ui.setStatus?.("wb-run", "scoping…");
      const { closure, parents } = await computeScope(ctx.cwd, root);
      ctx.ui.setStatus?.("wb-run", undefined);
      const first = selectNextReady(await readyLeaves(ctx.cwd, closure, parents), new Set());
      if (!first) {
        ctx.ui.notify(`No ready leaf tasks for ${label} (${root}; ${closure.size} in scope). All done/blocked, only umbrellas left, or run /wb-execution.`, "info");
        return;
      }

      implRun = { root, label, closure, parents, attempted: new Set([first.id]), results: [], stopping: false };
      await bd(ctx.cwd, ["update", first.id, "--status", "in_progress"]);
      const agentId = spawnWorker(sessionCtx, "wb-implementer", implPrompt(first), `impl ${first.id}`);
      if (!agentId) { implRun = undefined; ctx.ui.notify("wb-implement: failed to spawn worker.", "error"); return; }
      implRun.active = { taskId: first.id, title: first.title, phase: "impl", agentId, retried: false, work: "" };
      ctx.ui.notify(`wb-implement started [${label}] — autonomous, working ${first.id}. Observe: /agents or /wb-status. Halt: /wb-stop.`, "info");
    },
  });

  pi.registerCommand("wb-stop", {
    description: "Halt the running /wb-implement loop after the current task (hard-stop a worker via /agents)",
    handler: async (_args, ctx) => {
      if (!implRun) {
        ctx.ui.notify("No wb-implement run in progress.", "info");
        return;
      }
      implRun.stopping = true;
      ctx.ui.notify(`Stopping wb-implement after ${implRun.active?.taskId ?? "the current task"}. Hard-stop the worker now via /agents.`, "info");
    },
  });

  pi.registerCommand("wb-status", {
    description: "Show the running /wb-implement loop's progress",
    handler: async (_args, ctx) => {
      if (!implRun) {
        ctx.ui.notify("No wb-implement run in progress.", "info");
        return;
      }
      const a = implRun.active;
      ctx.ui.notify(
        `wb-implement [${implRun.label}]: ${implRun.results.length} done (${implRun.results.join(" ") || "—"})` +
          `${a ? `; now ${a.phase} ${a.taskId}${a.retried ? " (retry)" : ""}` : ""}${implRun.stopping ? "; stopping…" : ""}`,
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
    sessionCtx = ctx as unknown as WbCtx; // durable ctx for background /wb-implement events
  });

  // Inject the tier-appropriate workflow instructions.
  pi.on("before_agent_start", async (event, ctx) => {
    tier = resolveTier(ctx.model?.id);
    sessionCtx ??= ctx as unknown as WbCtx;
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
