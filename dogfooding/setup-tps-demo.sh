#!/usr/bin/env bash
# godot-playtest dogfooding (issue #14): materializes locally the instrumented
# "fork" of godotengine/tps-demo (ADR-0003) without ever touching GitHub.
#
# This script:
#   1. clones godotengine/tps-demo --depth 1 into .dogfood/tps-demo (gitignored,
#      never committed — the asset volume does not belong in this repo);
#   2. copies addons/playtest/ (this repo's addon, as-is) into it;
#   3. applies the versioned instrumentation patch
#      (dogfooding/patches/0001-instrument-playtest-bridge.patch) — test-ids
#      + domain `_test_state()`, see dogfooding/INSTRUMENTATION.md.
#
# Usage: dogfooding/setup-tps-demo.sh [destination_path]
#   (default: .dogfood/tps-demo at the repo root)
#
# Idempotent: if the clone already exists, it is not re-cloned; it just
# re-applies the addon `cp` (useful after an update to addons/playtest/) and
# tries the patch (no-op if already applied, `git apply --check` handles it).
#
# Creating the real GitHub fork 64ix/tps-demo (instead of this local clone)
# remains a manual QA step, documented in dogfooding/FRICTIONS.md — this
# script never pushes anything anywhere.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_URL="https://github.com/godotengine/tps-demo.git"
DEST="${1:-$REPO_ROOT/.dogfood/tps-demo}"

echo "== godot-playtest dogfooding: instrumented TPS demo setup =="
echo "repo:  $REPO_ROOT"
echo "dest:  $DEST"

if [ -d "$DEST/.git" ]; then
  echo "-- clone already present, not re-cloning (rm -rf '$DEST' to start over)"
else
  mkdir -p "$(dirname "$DEST")"
  echo "-- cloning $UPSTREAM_URL --depth 1"
  # --depth 1: tps-demo ships ~800MB of assets (glTF/HDR textures), a full
  # clone would be disproportionate for a local dogfooding bench.
  git clone --depth 1 "$UPSTREAM_URL" "$DEST"
fi

echo "-- copying addons/playtest/ into the clone"
mkdir -p "$DEST/addons"
rm -rf "$DEST/addons/playtest"
cp -r "$REPO_ROOT/addons/playtest" "$DEST/addons/playtest"

PATCH="$REPO_ROOT/dogfooding/patches/0001-instrument-playtest-bridge.patch"
echo "-- applying the instrumentation patch ($PATCH)"
if git -C "$DEST" apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "   already applied, nothing to do"
elif git -C "$DEST" apply --check "$PATCH" 2>/dev/null; then
  git -C "$DEST" apply "$PATCH"
  echo "   applied"
else
  echo "   ERROR: the patch does not apply as-is (tps-demo may have"
  echo "   changed upstream). See dogfooding/FRICTIONS.md — reapply the"
  echo "   hunks from $PATCH onto the current tps-demo version by hand."
  exit 1
fi

cat <<'EOF'

--- Setup done. Next steps:

1. Import the assets (needed before the first headless run, can take
   several minutes the first time):

     GODOT_BIN --headless --path .dogfood/tps-demo --import

2. Replay the dogfooding frozen test (see dogfooding/playtests/):

     cp dogfooding/playtests/*.gd .dogfood/tps-demo/playtests/
     GODOT_BIN --headless --path .dogfood/tps-demo \
       res://addons/playtest/runner.tscn -- --suite=res://playtests/

3. MCP config (mcp-server/README.md) pointed at .dogfood/tps-demo as
   --path to replay/extend the session documented in
   dogfooding/SESSION.md.

Replace GODOT_BIN with your local Godot 4.6.3 binary (mono or non-mono).
EOF
