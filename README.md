# workbench-pi

A [Pi](https://pi.dev) port of the [workbench](https://github.com/gvarela/workbench)
research → design → execution → implement workflow, tuned to run on a **small local
model** (`qwen3.6:35b-mlx` via Ollama) with a **tier switch** that scales the same
workflow up to capable frontier models.

Core idea: on the `small` tier the **extension owns control flow** (narrow
single-purpose subagents, deterministic assembly, hard discipline gates,
path-grounding) and the model only fills slots. On the `capable` tier the
model-led workbench behavior is restored.

See **[docs/PLAN.md](docs/PLAN.md)** for the full design, decisions, and build status.

## Install (git)

```bash
pi install git:github.com/gvarela/workbench-pi
pi   # then run /wb-setup once to register the subagents
```

## Commands

| Command | Does |
|---|---|
| `/wb-setup` | Install the workbench subagents into `~/.pi/agent/agents/` |
| `/wb-project [TICKET-123] <name>` | Scaffold `docs/plans/<date-name>/` (research / design / tasks) |
| `/wb-research <topic>` | Orchestrated subagents → `research.md` (facts only) |
| `/wb-design <topic>` | Draft `design.md` (small tier: gathered context + decisions checklist for you; capable tier: model-led) |
| `/wb-execution [epic title]` | `wb-planner` → phased tasks → deterministic beads issue tree → `tasks.md` (ids captured in code) |
| `/wb-implement [n]` | Work the next `n` ready beads tasks with fresh-context TDD workers; each closes only if `wb-verifier` independently passes (one retry on fail) |
| `/wb-validate` | Run the suite + verifier against the plan; writes `validation.md` |
| `/wb-override` | Escape hatch: toggle the discipline gates off/on for the session |

Requires the `bd` (beads) CLI for `/wb-execution` and `/wb-implement`; run `bd init` once in your project.

**Discipline gates** arm only during `/wb-implement`: the primary gate is structural
(a task's bead closes only on an independent verifier PASS); backstop hooks block
production-code writes before a failing test and warn on unverified success claims.
`/wb-override` bypasses them.

Tools: `wb_verify_paths` (ground paths vs `git ls-files`), `wb_ping`.

Subagents (installed by `/wb-setup`): `wb-locator`, `wb-analyzer`, `wb-pattern`, `wb-planner`, `wb-implementer`, `wb-verifier`.

## Tiers

The axis is **model capability**, not whether a model is technically a "reasoning"/thinking model — Sonnet, for instance, is a capable generalist that belongs on the capable tier. `WORKBENCH_TIER` or the active model selects behavior (default `small`):

- **small** (qwen/local): the extension owns control flow — narrow subagents, deterministic assembly, path grounding. The model is a slot-filler.
- **capable** (Claude/GPT/GLM-class/etc.): the model leads. `/wb-research` and `/wb-design` become model-led (it fans out subagents and synthesizes the artifact itself); `/wb-execution` and `/wb-implement` keep the deterministic beads tree + verifier-gated close, but their subagents run on the stronger model.

Tier detection: `WORKBENCH_TIER` wins (accepts `small`/`capable`, plus `reasoning`/`frontier`/`large` as aliases for capable); otherwise a best-effort heuristic recognizes a few well-known capable families (opus/sonnet/gpt-5/…). Capability isn't reliably in the model id, so **capable-but-unknown models (e.g. GLM 5.2) default to small — opt them in explicitly with `WORKBENCH_TIER=capable`.**

```bash
pi --provider anthropic --model sonnet    # → capable tier automatically
WORKBENCH_TIER=capable pi …               # force capable on any model (e.g. GLM)
WORKBENCH_TIER=small pi …                 # force small on any model
```

## Develop

```bash
npm run validate                # syntax + unit tests (fast)
./scripts/validate.sh --smoke   # also load in Pi + round-trip a tool (needs pi + Ollama)
# quick load + tool check (only this extension):
scripts/pi-run.sh -e ./src/index.ts -ne -nc --no-session -p "Call wb_ping and report verbatim."
# full command (loads subagent extension too):
PI_RUN_TIMEOUT=300 scripts/pi-run.sh -e ./src/index.ts -nc --no-session -p "/wb-research <topic>"
```

- `scripts/run-silent.sh` — context-efficient backpressure ("Success = ✓. Failure = full output.").
- `scripts/pi-run.sh` — thin timeout guard around `pi` (`PI_RUN_TIMEOUT` secs); you pass all pi flags/prompt.
- `scripts/eval.sh <artifact.md>` (`npm run eval`) — deterministic quality scorecard for a generated artifact (path-grounding, facts-only, template, placeholders). Free, no model; `EVAL_MIN=0.8` to gate.
