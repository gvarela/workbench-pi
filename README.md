# workbench-pi

A [Pi](https://pi.dev) port of the [workbench](https://github.com/gvarela/workbench)
research → design → execution → implement workflow, tuned to run on a **small local
model** (`qwen3.6:35b-mlx` via Ollama) with a **tier switch** that scales the same
workflow up to frontier reasoning models.

Core idea: on the `small` tier the **extension owns control flow** (narrow
single-purpose subagents, deterministic assembly, hard discipline gates,
path-grounding) and the model only fills slots. On the `reasoning` tier the
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
| `/wb-design <topic>` | Draft `design.md` (small tier: gathered context + decisions checklist for you; reasoning tier: model-led) |
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

`WORKBENCH_TIER` or the active model selects behavior (default `small`):

- **small** (qwen/local): the extension owns control flow — narrow subagents, deterministic assembly, hard gates, path grounding. The model is a slot-filler.
- **reasoning** (Claude/GPT/etc. — auto-detected from the model id, or forced with `WORKBENCH_TIER=reasoning`): the model leads. `/wb-research` and `/wb-design` become model-led (it fans out subagents and synthesizes the artifact itself); `/wb-execution` and `/wb-implement` keep the deterministic beads tree + verifier-gated close, but their subagents run on the stronger model.

```bash
pi --provider anthropic --model sonnet    # → reasoning tier automatically
WORKBENCH_TIER=reasoning pi …             # force reasoning on any model
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
