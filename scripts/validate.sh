#!/usr/bin/env bash
# Automatic backpressure for workbench-pi. Runs each layer through run-silent so a
# green run stays tiny (one ✓ per layer) and a failure shows only that layer's
# full output. Exits non-zero on the first failing layer (CI/commit-gate friendly).
#
#   ./scripts/validate.sh          fast: syntax-check every src file + run unit tests
#   ./scripts/validate.sh --smoke  also load the extension in Pi and round-trip wb_ping
#                                   (requires `pi` on PATH and Ollama running)
set -uo pipefail
cd "$(dirname "$0")/.."

RS="bash scripts/run-silent.sh"
NODE="node --disable-warning=ExperimentalWarning"

$RS "syntax-check src/*.ts" bash -c "$NODE scripts/tscheck.mjs \$(find src -name '*.ts')" || exit 1

$RS "unit tests (node:test)" $NODE --test 'test/**/*.test.ts' || exit 1

if [[ "${1:-}" == "--smoke" ]]; then
  if ! command -v pi >/dev/null 2>&1; then
    echo "⏭  smoke skipped: pi not on PATH"
  elif ! curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
    echo "⏭  smoke skipped: Ollama not reachable at :11434"
  else
    $RS "pi load + wb_ping round-trip" bash -c '
      out=$(scripts/pi-run.sh -e ./src/index.ts -ne -nc --no-session \
        -p "Call the wb_ping tool right now, then report verbatim what text it returned." 2>&1)
      echo "$out"
      echo "$out" | grep -q "workbench-pi v.* active (tier:"
    ' || exit 1
  fi
fi

echo "✅ validate passed"
