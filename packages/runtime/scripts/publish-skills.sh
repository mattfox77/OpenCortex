#!/usr/bin/env bash
set -euo pipefail

# Publish an OpenCortex skill bundle that install-server.sh stages for user
# provisioning on every deploy (see ensure_skills() there).
#
# The bundle is a tar.gz with a top-level `skills/` directory, uploaded to the
# deploy bucket at <prefix>/skills/opencortex-skills.tar.gz. Optional legacy PAI
# content is included only when explicitly configured.
#
# Usage:
#   OPENCORTEX_DEPLOY_BUCKET=opencortex-deploy \
#   OPENCORTEX_SKILLS_SOURCE=./skills \
#   scripts/publish-skills.sh
#
# Env:
#   OPENCORTEX_DEPLOY_BUCKET      (required) target S3 bucket
#   OPENCORTEX_DEPLOY_PREFIX      (default: deploy/opencortex)
#   OPENCORTEX_SKILLS_SOURCE      (required) dir with skill packs
#   OPENCORTEX_LEGACY_PAI_SOURCE  (optional) legacy PAI dir
#   AWS_REGION                    (default: us-east-1)
#   AWS_PROFILE                   (optional) profile used for the upload

bucket="${OPENCORTEX_DEPLOY_BUCKET:-${DIWAN_DEPLOY_BUCKET:-}}"
prefix="${OPENCORTEX_DEPLOY_PREFIX:-${DIWAN_DEPLOY_PREFIX:-deploy/opencortex}}"
skills_src="${OPENCORTEX_SKILLS_SOURCE:-${DIWAN_SKILLS_SOURCE:-}}"
pai_src="${OPENCORTEX_LEGACY_PAI_SOURCE:-${DIWAN_PAI_SOURCE:-}}"
region="${AWS_REGION:-us-east-1}"

if [ -z "$bucket" ]; then
  echo "OPENCORTEX_DEPLOY_BUCKET is required" >&2
  exit 2
fi
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

if [ -d "$pai_src" ]; then
  mkdir -p "$tmp/bundle/PAI"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude='._*' "$pai_src"/ "$tmp/bundle/PAI"/
  else
    cp -a "$pai_src"/. "$tmp/bundle/PAI"/
    find "$tmp/bundle/PAI" -name '._*' -delete
  fi
fi

tar -czf "$tmp/opencortex-skills.tar.gz" -C "$tmp/bundle" skills $( [ -d "$tmp/bundle/PAI" ] && echo PAI )

key="${prefix}/skills/opencortex-skills.tar.gz"
aws s3 cp "$tmp/opencortex-skills.tar.gz" "s3://${bucket}/${key}" --region "$region"

packs="$(ls "$tmp/bundle/skills" | wc -l | tr -d ' ')"
echo "published ${packs} skill packs$( [ -d "$tmp/bundle/PAI" ] && echo ' + PAI') to s3://${bucket}/${key}"
