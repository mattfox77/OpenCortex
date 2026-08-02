#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <opencortex-linux-user>" >&2
  exit 2
fi

user="$1"
# Bare username (email local-part), e.g. "mfox". Must be a safe Linux username:
# lowercase alnum/dash, starting with a letter, and not a reserved system name.
case "$user" in
  [a-z][a-z0-9-]*)
    ;;
  *)
    echo "invalid OpenCortex user: $user" >&2
    exit 2
    ;;
esac

case " root admin administrator daemon bin sys sync diwan opencortex ssm-user ubuntu ec2-user nobody sshd www-data " in
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
        echo "timed out waiting for OpenCortex user provisioning lock" >&2
        exit 1
      }
      create_linux_user_with_retry
    ) 9>/var/lock/opencortex-user-provision.lock
    return
  fi

  create_linux_user_with_retry
}

ensure_linux_user

home_root="${OPENCORTEX_HOME_ROOT:-/home}"
home="${home_root%/}/$user"

# Per-user git-root "repos" folder in the user's home. This is the cwd the
# embedded OpenCode session opens into, and the landing place for repos the
# user asks to pull. git init makes it a git root so OpenCode treats it as a
# project even before any repo is cloned.
install -d -o "$user" -g "$user" "$home/repos"
if [ ! -d "$home/repos/.git" ]; then
  sudo -u "$user" git -C "$home/repos" init -q
fi

workspace_root="${OPENCORTEX_WORKSPACE_ROOT:-${DIWAN_WORKSPACE_ROOT:-/srv/opencortex/workspaces}}"
install -d -o "$user" -g "$user" "$workspace_root/$user/repos"

install -d -o "$user" -g "$user" "$home/.config/opencode" "$home/.config/gh" "$home/.config/acli"
install -d -o "$user" -g "$user" "$home/.opencode/skills" "$home/.codex/skills"
install -d -o "$user" -g "$user" "$home/.opencortex/memory" "$home/.opencortex/credentials"
install -d -o "$user" -g "$user" \
  "$home/.local/share/opencode" \
  "$home/.local/state/opencode" \
  "$home/.cache/opencode"
install -d -o "$user" -g "$user" "$home/.azure" "$home/.ssh"
chown -R "$user:$user" "$home/.config" "$home/.opencode" "$home/.codex" "$home/.opencortex" "$home/.local" "$home/.cache"
chmod 700 "$home/.azure" "$home/.ssh" "$home/.opencortex" "$home/.opencortex/memory" "$home/.opencortex/credentials" "$home/.config/gh" "$home/.config/acli"

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

echo "provisioned $user"
