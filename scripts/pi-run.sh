#!/usr/bin/env bash
# pi-run — run `pi` with a wall-clock timeout guard (macOS has no `timeout`).
#
# Thin passthrough, like run-silent.sh: no project knowledge baked in. The caller
# supplies every pi flag and the prompt. Override the guard with PI_RUN_TIMEOUT (secs).
#
#   scripts/pi-run.sh -e ./src/index.ts -ne -nc --no-session -p "Call wb_ping and report verbatim."
#   PI_RUN_TIMEOUT=300 scripts/pi-run.sh -e ./src/index.ts -nc --no-session -p "/wb-research tier switch"
set -uo pipefail
exec perl -e 'alarm shift; exec @ARGV' "${PI_RUN_TIMEOUT:-150}" pi "$@"
