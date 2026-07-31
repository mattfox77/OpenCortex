#!/usr/bin/env bash
set -euo pipefail

# Publish an OpenCortex skill bundle that install-server.sh stages for user
# provisioning on every deploy (see ensure_skills() there).
#
# The bundle is a tar.gz with a top-level `skills/` directory. Write it to a
# local path, then publish that archive through the deployment channel for the
# target environment.
#
# Usage:
#   OPENCORTEX_SKILLS_SOURCE=./skills \
#   OPENCORTEX_SKILLS_BUNDLE_PATH=./opencortex-skills.tar.gz \
#   scripts/publish-skills.sh
#
# Env:
#   OPENCORTEX_SKILLS_SOURCE      (required) dir with skill packs
#   OPENCORTEX_SKILLS_BUNDLE_PATH (default: ./opencortex-skills.tar.gz)
#   OPENCORTEX_SKILLS_BUNDLE_VERSION version recorded in the bundle manifest
#   OPENCORTEX_SKILLS_PRIVATE_KEY_FILE optional Ed25519 PEM key used to sign
#   OPENCORTEX_SKILLS_PRIVATE_KEY_PEM  optional Ed25519 PEM key used to sign

skills_src="${OPENCORTEX_SKILLS_SOURCE:-${DIWAN_SKILLS_SOURCE:-}}"
bundle_path="${OPENCORTEX_SKILLS_BUNDLE_PATH:-${DIWAN_SKILLS_BUNDLE_PATH:-./opencortex-skills.tar.gz}}"

if [ -z "$skills_src" ]; then
  echo "OPENCORTEX_SKILLS_SOURCE is required" >&2
  exit 2
fi
if [ ! -d "$skills_src" ]; then
  echo "skills source not found: $skills_src" >&2
  exit 2
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bundle/skills"
# Copy skill packs (exclude AppleDouble cruft).
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude='._*' "$skills_src"/ "$tmp/bundle/skills"/
else
  cp -a "$skills_src"/. "$tmp/bundle/skills"/
  find "$tmp/bundle/skills" -name '._*' -delete
fi

metadata_script="$(dirname "$0")/../../skills/scripts/bundle-metadata.mjs"
node "$metadata_script" create "$tmp/bundle"

mkdir -p "$(dirname "$bundle_path")"
tar -czf "$bundle_path" -C "$tmp/bundle" \
  skills \
  opencortex-skills-manifest.json \
  opencortex-skills-integrity.json \
  $(if [ -f "$tmp/bundle/opencortex-skills-signature.json" ]; then printf '%s\n' opencortex-skills-signature.json; fi)

packs="$(ls "$tmp/bundle/skills" | wc -l | tr -d ' ')"
echo "wrote ${packs} skill packs to ${bundle_path}"
