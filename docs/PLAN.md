# workbench-pi — Project Plan

> A Pi (pi.dev) port of the **workbench** (`github.com/gvarela/workbench`, local
> `../prompts`) research→design→execution→implement workflow, tuned to run on a
> small local model (**qwen3.6:35b-mlx** via Ollama) with a **tier switch** that
> scales the same workflow up to frontier reasoning models.

Status: **Phase 0 complete & verified.** This document is the durable source of
truth for intent, architecture, decisions, and the build sequence. Keep it
current as phases land.

---

## 1. Intent

Reproduce the workbench's disciplined, session-durable engineering workflow on
Pi, but adapted to the reality that the default model is a **capable
instruction-follower, not a long-chain reasoner**. The original leans on
frontier-model judgment (multi-doc synthesis, trade-off generation, dependency
ordering, tracking dozens of issue IDs in one agentic turn, treating `⛔ BARRIER`
markers as real stops). A 35B local model will not do those reliably.

**Core principle of the port:**

> **The extension owns control flow; the model only fills slots.** Where the
> workbench trusts the model to orchestrate, `workbench-pi` orchestrates in
> *code*. Where the workbench trusts the model to *judge a discipline*, we
> convert soft prompt-instructions into **hard, blocking code-gates**.

A `model_tier` switch keeps one workflow that degrades gracefully: `reasoning`
tier restores the rich, model-led behavior when a strong model is available.

---

## 2. Source material — the workbench (what we're porting)

End-to-end pipeline; each phase writes one artifact consumed by the next:

```
create_project → create_research → create_design → create_execution → implement_tasks → validate
   README/         research.md       design.md        tasks.md +         code +           validation
   placeholders     (FACTS only)     (WHAT/WHY only)  beads tree         bd close         report
```

Load-bearing ideas (the things that must survive the port):

1. **Separation of facts / decisions / steps** — research.md ≠ design.md ≠ tasks.md.
2. **Read-only research subagents fan out; the main agent synthesizes & writes.**
   (Prevents partial/conflicting file states.)
3. **Beads is the persistent truth layer** — "markdown = the plan, beads = the
   status." Survives context compaction; markdown checkboxes are documentation-only.
4. **Explicit barriers** stop the model rushing ahead of complete context.
5. **Verification before claiming done** — "should work" is forbidden.
6. **TDD (Red→Green→Refactor) + zero scope creep** during implementation.
7. **Handoff/resume** treats session memory as a first-class artifact.

---

## 3. Pi platform facts (verified against installed source @ v0.80.2)

Pi's design is "primitives, not features." Extensibility maps onto the workbench
cleanly:

| Workbench (Claude Code) | Pi equivalent | Notes |
|---|---|---|
| `skills/*/SKILL.md` | **Skills** (same Agent Skills standard) | Cross-compatible; `pi`-manifest `skills:` |
| `agents/*.md` subagents | `.pi/agents/*.md` via `@tintinweb/pi-subagents` | Rich frontmatter; **see constraint below** |
| `commands/*.md` slash cmds | `prompts/*.md` (text) **or** `pi.registerCommand()` (agentic) | Handlers can drive the session |
| `hooks/*.sh` + plugin.json | `pi.on(event)` | *Richer*: can block tool calls, rewrite results, inject system prompt |
| `CLAUDE.md` | `AGENTS.md`/`CLAUDE.md` (both read) + `SYSTEM.md`/`APPEND_SYSTEM.md` | — |
| beads integration | `pi-beads-extension` (installed) + `pi.exec("bd", …)` | Reuse |

**Extension anatomy (verified):** `package.json` with a `"pi"` manifest +
`export default function(pi: ExtensionAPI)`. Params via `@sinclair/typebox`.
Loaded via `jiti` (no build step). Imports mirror the proven `pi-beads-extension`:
`@mariozechner/pi-coding-agent` + `@sinclair/typebox`; peerDep
`@mariozechner/pi-coding-agent: *`.

**Key API surface used by this project:**
- `pi.registerTool({ name, label, description, parameters, execute })`
- `pi.registerCommand(name, { description, handler(args, ctx) })`
- `pi.on("before_agent_start") → { systemPrompt }` — tier-aware prompt injection
- `pi.on("tool_call") → { block, reason }` — discipline gates
- `pi.on("session_start" | "agent_end" | "session_before_compact")`
- `pi.exec(cmd, args, { timeout }) → { code, stdout, stderr }`
- `pi.sendUserMessage(text)` — expand a prompt template / trigger a turn
- subagents manager via `globalThis[Symbol.for("pi-subagents:manager")]`:
  `spawn(pi, ctx, type, prompt, options)`, `waitForAll()`, `getRecord(id)`

### ⚠️ Hard constraint: packages cannot inject subagents

`@tintinweb/pi-subagents` discovers agents **only** from `<cwd>/.pi/agents/*.md`
and `~/.pi/agent/agents/*.md`. It does **not** scan package directories, and
`manager.spawn(type, …)` requires the `type` to already be registered from one of
those dirs. Therefore a git-installed `workbench-pi` cannot register its research
agents on its own.

**Resolution:** ship agents as source-of-truth in the package `agents/` dir; a
`/wb-setup` command **idempotently syncs them into `~/.pi/agent/agents/`**, after
which the orchestrator drives them via `manager.spawn(...) + waitForAll()`.

*(Bonus: pi-subagents already swaps in a ~75%-smaller system prompt for
small/local models — the platform is small-model-aware.)*

---

## 4. Small-model adaptation rules (research-backed)

Applied throughout the port:

- **Cut complexity, not needed content.** Long prompts are fine *if* low-complexity;
  redundancy and nuance hurt.
- **Decompose** every multi-step task into discrete single-purpose steps/turns.
- **Ground file paths** against `git ls-files` before acting — path hallucination is
  the #1 coding-agent failure and is *uncorrelated* with coding skill.
- **Narrow, single-purpose subagents** beat fewer general ones (measured: orchestrated
  task partitioning resists load-collapse far better than a single agent).
- **Two-pass structured output** — reason first, format second (forcing JSON+reasoning
  in one turn costs small open models accuracy).
- **File tree / large context at the start or end of a prompt, never the middle**
  ("lost in the middle," amplified in small models).
- **Treat the model as a slot-filler, not a judge.** Move judgment into scaffolding;
  keep the `model_tier` switch to restore judgment when a strong model is present.

---

## 5. Architecture

Single git-installable Pi package:

```
workbench-pi/
  package.json                 # "pi": { extensions, skills, prompts }
  docs/PLAN.md                 # this file
  src/
    index.ts                   # factory: wires tools, commands, hooks; reads tier
    tier.ts                    # WORKBENCH_TIER = small | reasoning  (the switch)
    orchestrator.ts            # small-tier state machine: drives subagents step-by-step
    tools/
      scaffold-project.ts      # pure: create docs/plans/… tree + templated frontmatter
      verify-paths.ts          # pure core + pi wrapper: ground paths vs `git ls-files`
      beads.ts                 # deterministic bd create/dep/close with ID capture in code
    gates/
      no-claim-without-verify.ts   # message_end/tool_call hook: block "done" w/o evidence
      tdd-gate.ts                  # tool_call hook: block source Write w/o failing test
    prompts.ts                 # tier-aware system-prompt fragments
  agents/        # narrow single-purpose subagents (locator, analyzer, pattern, verifier)
  skills/        # ported disciplines (SKILL.md)
  prompts/       # thin slash-command entry points (/wb-* )
  test/          # node:test unit tests on the PURE modules (the backpressure)
  scripts/validate.sh          # the one command that runs all automatic checks
  evals/         # (future) LLM-as-judge eval harness to tune execution
```

**Design rule for testability:** every deterministic capability is a **pure core
function** (no Pi/`fs`/`exec` deps in the hot path where avoidable) + a **thin Pi
wrapper**. Pure cores get unit tests; wrappers get the integration smoke test.

### Two tiers, one workflow

| | `small` (default, qwen) | `reasoning` (Opus/Sonnet) |
|---|---|---|
| Control flow | extension orchestrator owns it | model-led, parallel fan-out |
| Subagents | one narrow agent at a time, grounded inputs | parallel, broad prompts |
| Disciplines | hard blocking gates | soft prompt instructions |
| Output | strict fill-in-the-blank templates | model-authored synthesis |
| Barriers | enforced in code | prompt markers |

Tier resolution (`src/tier.ts`): `WORKBENCH_TIER` env → model-id heuristic →
default `small`.

---

## 6. Decisions (locked with the user)

| Decision | Choice |
|---|---|
| v1 scope | **Core pipeline MVP**: project→research→design→execution→implement→validate + beads + key disciplines |
| Packaging | **git-installable Pi package** (`pi install git:…`); no npm publish |
| Discipline enforcement | **Hard gates + escape hatch** (`/wb-override`) |
| Implement command | **Coordinated workers** (coordinator + fresh-context worker per task + verifier) |
| Tier default | `small`; switch via `WORKBENCH_TIER` / model heuristic |

---

## 7. Build sequence & per-phase backpressure

Each phase ships with automatic validation runnable via `scripts/validate.sh`.

| Phase | Deliverable | Automatic validation (backpressure) |
|---|---|---|
| ✅ 0 | Skeleton: ping tool, `/wb-help`, tier banner | `pi -e` load + model invokes `wb_ping` → expected line |
| ✅ 1 | `scaffold-project` tool + `/wb-project`; tier-aware system prompt | unit: dir/file/frontmatter shape, idempotency, name slugging, arg parsing, prompt-fragment selection (9 tests) |
| 2 | `verify-paths` grounding tool + 4 subagents + `/wb-setup` sync | unit: path grounding (real vs hallucinated); setup sync idempotency |
| 3 | Small-tier **research orchestrator** (locator→analyzer→synthesize→research.md) | unit: state-machine transitions on mocked agent outputs; PoC run on qwen |
| 4 | `beads` tool (deterministic ID capture) + `/wb-design`, `/wb-execution` | unit: bd-call sequencing + ID capture against a fake `bd`; dep-graph builder |
| 5 | Discipline gates + escape hatch + coordinated `/wb-implement` + `/wb-validate` | unit: gate blocks/allows on crafted tool_call events; override path |
| 6 | Reasoning-tier rich prompts behind the switch + README | unit: tier selection picks correct prompt set; docs lint |

Checkpoint cadence: proceed autonomously; **hard stop at Phase 3** (the qwen
proof-of-concept) for human review.

### Deferred / backlog

- **`wb_run` Pi tool (DEFERRED — design locked, not building yet).** Expose the
  `run-silent.sh` backpressure as a first-class custom tool: `execute()` runs the
  command via `pi.exec("bash", ["-c", cmd], { cwd, signal })` and applies a shared
  **pure `backpressure()` policy** (success → one ✓ line with hidden-line count;
  failure → full output, tail-capped for huge logs). The win over the script: the
  tool **records the outcome in turn-scoped state**, so the Phase 5
  `no-claim-without-verify` gate can require a `wb_run` that exited 0 this turn —
  backpressure and the verification gate become one mechanism. Optional companion:
  a `tool_result` interceptor that auto-compresses successful built-in `bash` calls
  matching a test/build/lint allowlist (off by default; cannot fire globally because
  many successful bash calls are run *for* their output). Small-tier prompt would add
  one line steering verification through `wb_run`. Revisit alongside Phase 5.

---

## 8. Validation strategy

Three layers, increasing cost:

1. **Unit (always-on, no model):** `node --test` over `test/*.test.ts` against the
   pure cores. Fast, deterministic, machine-independent. This is the primary
   backpressure — every deterministic behavior must have one.
2. **Integration smoke (guarded):** `scripts/validate.sh` runs a `pi -e` load and a
   `wb_ping` round-trip when `pi` + Ollama are available; skipped gracefully otherwise.
3. **Eval (future, Phase 6+):** see below.

`scripts/validate.sh` is the single entry point and is safe to run on any commit.
It routes every layer through **`scripts/run-silent.sh`** — context-efficient
backpressure ("Success = ✓. Failure = full output.", after
[humanlayer](https://www.humanlayer.dev/blog/context-efficient-backpressure)): a
green run prints one ✓ per layer; a failing layer prints its full output; exit
codes are preserved. `run-silent.sh` is reusable standalone for any agent-run
command (`scripts/run-silent.sh "<desc>" <cmd…>`; optional `RUN_SILENT_TAIL=N`
caps huge failures and keeps the full log on disk). This keeps the small tier's
context small by construction and is a natural candidate to later expose as a Pi
`wb_run` tool.

---

## 9. Future: execution eval harness (`evals/`)

Goal: **tune the small-tier prompts/orchestration and judge quality automatically.**

Sketch:
- **Fixtures:** a few small sample repos + tasks with known-good expected artifacts
  (e.g., a `research.md` that correctly cites real `file:line`s).
- **Runner:** drive `/wb-research` (etc.) headlessly via `pi -p` on each fixture,
  capture the produced artifact.
- **Judges (LLM-as-judge, run on a strong model):** score on rubric dimensions —
  *path-grounding correctness* (every cited path exists; deterministic check, not a
  judge), *facts-only discipline* (no opinions in research.md), *completeness*,
  *template conformance*. Combine deterministic checks + judged dimensions.
- **Output:** a scorecard per tier/prompt-variant so we can A/B prompt changes and
  catch regressions. Wire into `scripts/validate.sh --eval`.

This is *why* §5 forces pure cores and templated outputs: deterministic checks do
most of the grading; the judge only handles genuinely subjective dimensions.

---

## 10. Appendix — key paths

- Pi SDK types: `…/node/<v>/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
- Pi docs: `…/@earendil-works/pi-coding-agent/docs/` (extensions, packages, skills, prompt-templates)
- Pi extension examples: `…/@earendil-works/pi-coding-agent/examples/extensions/` (permission-gate, claude-rules, commands, handoff, event-bus)
- Subagent loader/frontmatter: `~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents/src/custom-agents.ts`
- Subagent manager/spawn: `…/@tintinweb/pi-subagents/src/{index,agent-manager}.ts`
- Beads extension (closest analog): `~/.pi/agent/npm/node_modules/pi-beads-extension/src/index.ts`
- Source workbench: `/Users/gvarela/Development/Brightline/prompts/`
