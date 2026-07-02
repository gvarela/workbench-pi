#!/usr/bin/env bash
# Fixture eval runner: clone pinned real repos, drive the pipeline, score + check.
#   scripts/eval-run.sh [--only <name>] [--target small|capable] [--runs N] [--judge]
set -uo pipefail
cd "$(dirname "$0")/.."
exec node --disable-warning=ExperimentalWarning src/eval/run.ts "$@"
