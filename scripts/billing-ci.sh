#!/usr/bin/env bash
#
# CI entrypoint for billing configs — portable across CI runners.
#
#   billing-ci.sh validate   # fmt --check + void check + compile IR (PRs)
#   billing-ci.sh deploy     # validate, then deploy to $VOID_ENDPOINT (main)
#
# Environment:
#   BILLING_CONFIGS   space-separated .void files   (default: examples/pro.void)
#   VOID_BIN          the void CLI                  (default: node packages/cli/dist/bin.js)
#   VOID_ENDPOINT     full deploy URL, e.g. https://billing.internal/v1/deploy  (deploy only)
#   VOID_TOKEN        bearer token                                              (optional)
#   DRY_RUN           1 = compile + print the deploy payload, send nothing
#
# Deploys are idempotent: the payload carries a sha256 over the canonical IR,
# and the server no-ops (200 "unchanged") when that checksum is already
# active — so running deploy on every push to main is safe.
#
# On GitHub Actions, checksums are appended to the job summary; elsewhere
# they just print.

set -euo pipefail

COMMAND="${1:?usage: billing-ci.sh <validate|deploy>}"
CONFIGS="${BILLING_CONFIGS:-examples/pro.void}"
VOID="${VOID_BIN:-node packages/cli/dist/bin.js}"

summary() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

validate_one() {
  local config="$1"
  echo "── validating ${config}"
  $VOID fmt --check "$config"
  $VOID check "$config"
  local checksum
  checksum="$($VOID build "$config" | node -e '
    const { createHash } = require("node:crypto")
    let raw = ""
    process.stdin.on("data", (c) => (raw += c))
    process.stdin.on("end", () => {
      const ir = JSON.parse(raw)
      console.log("sha256:" + createHash("sha256").update(JSON.stringify(ir)).digest("hex"))
    })
  ')"
  summary "✓ ${config} — \`${checksum}\`"
}

deploy_one() {
  local config="$1"
  if [ "${DRY_RUN:-0}" = "1" ]; then
    $VOID deploy "$config" --dry-run
    summary "↷ ${config} — dry run, nothing sent"
    return
  fi
  # VOID_ENDPOINT / VOID_TOKEN are read by the CLI from the environment.
  local output
  output="$($VOID deploy "$config")"
  echo "$output"
  summary "🚀 ${config} — ${output}"
}

case "$COMMAND" in
  validate)
    for config in $CONFIGS; do validate_one "$config"; done
    ;;
  deploy)
    : "${VOID_ENDPOINT:?VOID_ENDPOINT is required to deploy (or set DRY_RUN=1)}"
    for config in $CONFIGS; do
      validate_one "$config"
      deploy_one "$config"
    done
    ;;
  *)
    echo "unknown command: ${COMMAND}" >&2
    exit 1
    ;;
esac
