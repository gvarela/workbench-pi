#!/usr/bin/env bash
# run-silent — context-efficient backpressure for commands run by an agent.
#
#   "Success = ✓. Failure = full output."
#   (after https://www.humanlayer.dev/blog/context-efficient-backpressure)
#
# On success, emit a single line so the model's context stays tiny. On failure,
# dump the complete combined output so the model sees the real error. Either way,
# the wrapped command's exit code is preserved so this composes in pipelines/CI.
#
# Usage:
#   scripts/run-silent.sh "<description>" <command> [args...]
#
# Optional env:
#   RUN_SILENT_TAIL=N   On failure, show only the last N lines and keep the full
#                       log on disk, printing its path (for truly huge output).
#
# Examples:
#   scripts/run-silent.sh "unit tests"        node --test 'test/**/*.test.ts'
#   scripts/run-silent.sh "typecheck"         npx tsc --noEmit
#   RUN_SILENT_TAIL=80 scripts/run-silent.sh "integration" bun run test:integration
set -uo pipefail

desc="${1:?usage: run-silent.sh <description> <command...>}"; shift
if [ "$#" -lt 1 ]; then
  echo "run-silent: no command given" >&2
  exit 2
fi

log="$(mktemp -t run-silent.XXXXXX)"
keep=0
cleanup() { [ "$keep" -eq 1 ] || rm -f "$log"; }
trap cleanup EXIT

start=$SECONDS
"$@" >"$log" 2>&1
code=$?
dur=$((SECONDS - start))

if [ "$code" -eq 0 ]; then
  echo "✓ ${desc} (${dur}s)"
else
  echo "✗ ${desc} — exit ${code} (${dur}s)"
  if [ -n "${RUN_SILENT_TAIL:-}" ] && [ "$(wc -l <"$log")" -gt "${RUN_SILENT_TAIL}" ]; then
    echo "--- last ${RUN_SILENT_TAIL} lines (full log: ${log}) ---"
    tail -n "${RUN_SILENT_TAIL}" "$log"
    keep=1   # retain so the agent can grep/read the full log
  else
    cat "$log"
  fi
fi

exit "$code"
