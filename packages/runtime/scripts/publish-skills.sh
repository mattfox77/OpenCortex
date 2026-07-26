#!/usr/bin/env bash
set -euo pipefail

# Publish the brain skills + PAI bundle that install-server.sh stages into
# /opt/braintrust on every deploy (see ensure_skills() there).
#
# The bundle is a tar.gz with top-level `skills/` and `PAI/` directories,
# uploaded to the deploy bucket at <prefix>/skills/diwan-skills.tar.gz — a key
# under the deploy prefix so the EC2 instance role (which can read
# <prefix>/*) can fetch it without an IAM change.
#
# Usage:
#   DIWAN_DEPLOY_BUCKET=dsn-diwan-deploy-381492040186 \
#   DIWAN_SKILLS_SOURCE=~/.claude/skills \
#   DIWAN_PAI_SOURCE=~/.claude/PAI \
#   scripts/publish-skills.sh
#
# Env:
#   DIWAN_DEPLOY_BUCKET   (required) target S3 bucket
#   DIWAN_DEPLOY_PREFIX   (default: deploy/diwan-runtime)
#   DIWAN_SKILLS_SOURCE   (default: $HOME/.claude/skills) dir with skill packs
#   DIWAN_PAI_SOURCE      (default: $HOME/.claude/PAI) PAI dir (optional)
#   AWS_REGION            (default: us-east-1)
#   AWS_PROFILE           (optional) profile used for the upload

bucket="${DIWAN_DEPLOY_BUCKET:-}"
prefix="${DIWAN_DEPLOY_PREFIX:-deploy/diwan-runtime}"
skills_src="${DIWAN_SKILLS_SOURCE:-$HOME/.claude/skills}"
pai_src="${DIWAN_PAI_SOURCE:-$HOME/.claude/PAI}"
region="${AWS_REGION:-us-east-1}"

if [ -z "$bucket" ]; then
  echo "DIWAN_DEPLOY_BUCKET is required" >&2
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

tar -czf "$tmp/diwan-skills.tar.gz" -C "$tmp/bundle" skills $( [ -d "$tmp/bundle/PAI" ] && echo PAI )

key="${prefix}/skills/diwan-skills.tar.gz"
aws s3 cp "$tmp/diwan-skills.tar.gz" "s3://${bucket}/${key}" --region "$region"

packs="$(ls "$tmp/bundle/skills" | wc -l | tr -d ' ')"
echo "published ${packs} skill packs$( [ -d "$tmp/bundle/PAI" ] && echo ' + PAI') to s3://${bucket}/${key}"
