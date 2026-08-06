#!/usr/bin/env bash
set -euo pipefail

readonly GODOT_VERSION="4.6.3-stable"
readonly GODOT_ARCHIVE="Godot_v4.6.3-stable_linux.x86_64.zip"
readonly GODOT_SHA512="a035258da32b77f966a5376f9fa29c30a6adde826a85ba918e1605bd1fc9823eba7d85f1dd5e748956bd2ba72827c0025ffa11bb82aec91128c407a2e723c99c"
readonly GODOT_URL="https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}/${GODOT_ARCHIVE}"

curl --fail --location --show-error --silent \
  --proto '=https' --tlsv1.2 \
  --output godot.zip \
  "$GODOT_URL"

echo "${GODOT_SHA512}  godot.zip" | sha512sum --check --strict
unzip -q godot.zip
mv "${GODOT_ARCHIVE%.zip}" godot-bin
chmod +x godot-bin
./godot-bin --version
