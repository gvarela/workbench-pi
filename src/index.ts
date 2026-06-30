/**
 * workbench-pi — a Pi port of the workbench research→design→execution→implement
 * workflow, tuned for small local models (qwen3.6:35b) with a tier switch up to
 * reasoning models.
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
import { systemPromptFragment } from "./prompts.js";
import { parseProjectArgs, scaffoldProject } from "./tools/scaffold-project.js";
import { groundPaths } from "./tools/verify-paths.js";
import { syncAgents, agentsTargetDir } from "./setup.js";
import { pickPlanDir, assembleResearchBody, setStatusAndReplaceBody, assembleDesignDraft } from "./orchestrator.js";
import { parseTaskPlan, assembleTasksBody } from "./execution.js";
import { planBeadsTree, createBeadsTree } from "./tools/beads.js";

/** Minimal view of the @tintinweb/pi-subagents manager exposed via globalThis. */
interface SubagentManager {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: { description: string }): string;
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

  const plansRootOf = (cwd: string) => join(cwd, "docs", "plans");
  const findPlanDir = (cwd: string): string | undefined => {
    const root = plansRootOf(cwd);
    return pickPlanDir(existsSync(root) ? readdirSync(root) : []);
  };
  const runAgent = async (mgr: SubagentManager, ctx: unknown, type: string, prompt: string, desc: string): Promise<string> => {
    const id = mgr.spawn(pi, ctx, type, prompt, { description: desc });
    await mgr.waitForAll();
    return mgr.getRecord(id)?.result ?? "";
  };

  pi.registerTool({
    name: "wb_ping",
    label: "Workbench Ping",
    description:
      "Health check for the workbench-pi extension. Returns the extension version and the active tier (small | reasoning). Use only when explicitly asked to verify workbench-pi is loaded.",
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
      const read = async (args: string[]) => {
        try {
          const r = await pi.exec("git", args, { cwd: ctx.cwd, signal, timeout: 10_000 });
          return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
        } catch {
          return [];
        }
      };
      const universe = [
        ...(await read(["ls-files"])),
        ...(await read(["ls-files", "--others", "--exclude-standard"])),
      ];
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
      const mgr = subagentManager();
      if (!mgr) {
        ctx.ui.notify("wb-research needs @tintinweb/pi-subagents installed and agents synced (run /wb-setup, then a fresh session).", "error");
        return;
      }
      const plansRoot = join(ctx.cwd, "docs", "plans");
      const planDir = pickPlanDir(existsSync(plansRoot) ? readdirSync(plansRoot) : []);
      if (!planDir) {
        ctx.ui.notify("No plan found under docs/plans/. Run /wb-project first.", "warning");
        return;
      }
      const researchPath = join(plansRoot, planDir, "research.md");

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
        const existing = existsSync(researchPath) ? readFileSync(researchPath, "utf-8") : "";
        writeFileSync(researchPath, setStatusAndReplaceBody(existing, "in-progress", body), "utf-8");
        setStatus(undefined);
        ctx.ui.notify(`research.md updated → docs/plans/${planDir}/research.md (review & refine).`, "info");
      } catch (e) {
        setStatus(undefined);
        ctx.ui.notify(`wb-research failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("wb-design", {
    description: "Draft design.md for a topic (small: gather context + decisions checklist; reasoning: model-led)",
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

      if (resolveTier(ctx.model?.id) === "reasoning") {
        pi.sendUserMessage(
          `Lead an interactive design discussion for "${topic}". Read docs/plans/${planDir}/research.md first. ` +
            `Then write WHAT/WHY decisions (no implementation steps) to docs/plans/${planDir}/design.md and set its frontmatter status to "ready".`,
        );
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

  // Inject the tier-appropriate workflow instructions.
  pi.on("before_agent_start", async (event, ctx) => {
    tier = resolveTier(ctx.model?.id);
    return { systemPrompt: `${event.systemPrompt}\n\n${systemPromptFragment(tier)}\n` };
  });
}
