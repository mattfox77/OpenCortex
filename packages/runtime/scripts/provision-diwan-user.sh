#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <diwan-linux-user>" >&2
  exit 2
fi

user="$1"
# Bare username (email local-part), e.g. "mfox". Must be a safe Linux username:
# lowercase alnum/dash, starting with a letter, and not a reserved system name.
case "$user" in
  [a-z][a-z0-9-]*)
    ;;
  *)
    echo "invalid Diwan user: $user" >&2
    exit 2
    ;;
esac

case " root admin administrator daemon bin sys sync diwan ssm-user ubuntu ec2-user nobody sshd www-data " in
  *" $user "*)
    echo "reserved system user, refusing: $user" >&2
    exit 2
    ;;
esac

create_linux_user_with_retry() {
  if id "$user" >/dev/null 2>&1; then
    return 0
  fi

  local attempt
  local max_attempts=20
  for attempt in $(seq 1 "$max_attempts"); do
    if useradd --create-home --shell /bin/bash "$user"; then
      return 0
    fi
    if id "$user" >/dev/null 2>&1; then
      return 0
    fi
    if [ "$attempt" -lt "$max_attempts" ]; then
      echo "useradd failed for $user; retrying after passwd lock contention (${attempt}/${max_attempts})" >&2
      sleep 3
    fi
  done

  echo "failed to create Linux user after retries: $user" >&2
  return 1
}

ensure_linux_user() {
  if id "$user" >/dev/null 2>&1; then
    return 0
  fi

  if command -v flock >/dev/null 2>&1; then
    mkdir -p /var/lock
    (
      flock -w 120 9 || {
        echo "timed out waiting for Diwan user provisioning lock" >&2
        exit 1
      }
      create_linux_user_with_retry
    ) 9>/var/lock/diwan-user-provision.lock
    return
  fi

  create_linux_user_with_retry
}

ensure_linux_user

home="/home/$user"

# Per-user git-root "repos" folder in the user's home. This is the cwd the
# embedded OpenCode session opens into, and the landing place for repos the
# user asks to pull. git init makes it a git root so OpenCode treats it as a
# project even before any repo is cloned.
install -d -o "$user" -g "$user" "$home/repos"
if [ ! -d "$home/repos/.git" ]; then
  sudo -u "$user" git -C "$home/repos" init -q
fi

# Legacy workspace path retained for compatibility with older sessions.
install -d -o "$user" -g "$user" "/srv/diwan/workspaces/$user/repos"

install -d -o "$user" -g "$user" "$home/.config/opencode" "$home/.config/gh" "$home/.config/acli"
install -d -o "$user" -g "$user" "$home/.opencode/skills" "$home/.codex/skills"
install -d -o "$user" -g "$user" "$home/.braintrust"
install -d -o "$user" -g "$user" \
  "$home/.local/share/opencode" \
  "$home/.local/state/opencode" \
  "$home/.cache/opencode"
install -d -o "$user" -g "$user" "$home/.aws" "$home/.azure" "$home/.ssh"
chown -R "$user:$user" "$home/.config" "$home/.opencode" "$home/.codex" "$home/.braintrust" "$home/.local" "$home/.cache"
chmod 700 "$home/.aws" "$home/.azure" "$home/.ssh" "$home/.braintrust" "$home/.config/gh" "$home/.config/acli"

skills_source="${OPENCORTEX_SKILLS_DIR:-${DIWAN_BRAIN_SKILLS_SOURCE:-/opt/opencortex/skills/skills}}"

seed_skills() {
  local source="$1"
  local target="$2"
  if [ ! -d "$source" ]; then
    return
  fi
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude='._*' "$source"/ "$target"/
  else
    cp -a "$source"/. "$target"/
    find "$target" -name '._*' -delete
  fi
  chown -R "$user:$user" "$target"
}

seed_skills "$skills_source" "$home/.opencode/skills"
seed_skills "$skills_source" "$home/.codex/skills"

legacy_pai_source="${OPENCORTEX_LEGACY_PAI_DIR:-${DIWAN_BRAIN_PAI_SOURCE:-}}"

if [ -d "$legacy_pai_source" ]; then
  seed_skills "$legacy_pai_source" "$home/.opencode/skills/PAI"
  seed_skills "$legacy_pai_source" "$home/.codex/skills/PAI"
  if [ -f "$home/.opencode/skills/PAI/SKILL.md" ]; then
    sed -i '1{/^<!-- PAI SKILL.md/d;}' "$home/.opencode/skills/PAI/SKILL.md"
  fi
  if [ -f "$home/.codex/skills/PAI/SKILL.md" ]; then
    sed -i '1{/^<!-- PAI SKILL.md/d;}' "$home/.codex/skills/PAI/SKILL.md"
  fi
fi

# Seed the OpenCode config so the embedded session defaults to Amazon Bedrock
# using the EC2 instance role (braintrust-ec2) via IMDS — no profile or keys.
# Region us-east-1, where the US system-defined inference profiles live. Models
# mirror this server's own config: latest US Claude tier (Opus / Sonnet / Haiku).
# Written only if absent so per-user customizations are not clobbered on re-run.
config="$home/.config/opencode/opencode.json"
if [ ! -s "$config" ] || ! grep -q '"amazon-bedrock"' "$config"; then
  cat > "$config" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "amazon-bedrock": {
      "options": { "region": "us-east-1" },
      "models": {
        "us.anthropic.claude-opus-4-8": { "name": "Claude Opus 4.8 (Bedrock US)" },
        "us.anthropic.claude-sonnet-4-5-20250929-v1:0": { "name": "Claude Sonnet 4.5 (Bedrock US)" },
        "us.anthropic.claude-haiku-4-5-20251001-v1:0": { "name": "Claude Haiku 4.5 (Bedrock US)" }
      }
    }
  },
  "model": "amazon-bedrock/us.anthropic.claude-opus-4-8"
}
JSON
  chown "$user:$user" "$config"
fi

echo "provisioned $user"
