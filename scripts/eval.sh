#!/usr/bin/env bash
# Score a generated workbench artifact (research.md / design.md / tasks.md) with the
# deterministic eval scorers. Free, no model. Set EVAL_MIN=0.8 to exit non-zero below.
#
#   scripts/eval.sh docs/plans/<dir>/research.md
set -uo pipefail
cd "$(dirname "$0")/.."
exec node --disable-warning=ExperimentalWarning src/eval/cli.ts "$@"
