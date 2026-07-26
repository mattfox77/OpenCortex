#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${DIWAN_APP_DIR:-/opt/diwan}"
SERVICE_USER="${DIWAN_SERVICE_USER:-diwan}"
INSTALL_LOCK_FILE="${DIWAN_INSTALL_LOCK_FILE:-/var/lock/diwan-runtime-install.lock}"
INSTALL_LOCK_TIMEOUT="${DIWAN_INSTALL_LOCK_TIMEOUT:-900}"

acquire_install_lock() {
  if ! command -v flock >/dev/null 2>&1; then
    echo "flock is unavailable; continuing without deploy serialization." >&2
    return 0
  fi

  mkdir -p "$(dirname "$INSTALL_LOCK_FILE")"
  exec 9>"$INSTALL_LOCK_FILE"
  if ! flock -w "$INSTALL_LOCK_TIMEOUT" 9; then
    echo "timed out waiting for Diwan install lock: $INSTALL_LOCK_FILE" >&2
    exit 1
  fi
}

acquire_install_lock

ensure_apt_packages() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "apt package install requires root." >&2
    exit 1
  fi

  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
    if [ "$major" -ge 22 ]; then
      if command -v corepack >/dev/null 2>&1; then
        corepack enable >/dev/null 2>&1 || true
      fi
      return 0
    fi
  fi

  if [ "$(id -u)" -ne 0 ]; then
    echo "Node.js 22+ is required. Re-run as root or install Node before deploying." >&2
    exit 1
  fi

  ensure_apt_packages ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  ensure_apt_packages nodejs
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
  fi
}

ensure_rsync() {
  if command -v rsync >/dev/null 2>&1; then
    return 0
  fi

  if [ "$(id -u)" -ne 0 ]; then
    echo "rsync is required. Re-run as root or install rsync before deploying." >&2
    exit 1
  fi

  ensure_apt_packages rsync
}

# Per-user code sessions expect Node.js/npm/npx, git, jq, GitHub (gh),
# Atlassian (acli), and Brain Trust (brain) on PATH. Install them system-wide
# so every Diwan Linux user's session shell can use them.
# Idempotent: skips anything already present.
ensure_clis() {
  local arch
  arch="$(dpkg --print-architecture)"  # amd64 | arm64
  case "$arch" in
    amd64|arm64) ;;
    *)
      echo "unsupported architecture for Diwan CLI bootstrap: $arch" >&2
      exit 1
      ;;
  esac

  ensure_apt_packages ca-certificates curl gnupg unzip git jq python3 make g++

  # GitHub CLI via the official apt repository. Always configure the official
  # repo before install so an old distro gh package is upgraded on deploy.
  mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | gpg --dearmor --yes -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  ensure_apt_packages gh

  # Atlassian CLI (acli). Install the current official latest binary on every
  # deploy so stale shared installs are refreshed for all Diwan users.
  local acliurls tmp installed
  case "$arch" in
    amd64)
      acliurls=(
        "https://acli.atlassian.com/linux/latest/acli_linux_amd64/acli"
        "https://acli.atlassian.com/linux/latest/acli_linux_amd64.tar.gz"
      )
      ;;
    arm64)
      acliurls=(
        "https://acli.atlassian.com/linux/latest/acli_linux_arm64/acli"
        "https://acli.atlassian.com/linux/latest/acli_linux_arm64.tar.gz"
      )
      ;;
  esac
  tmp="$(mktemp -d)"
  installed=0
  for acliurl in "${acliurls[@]}"; do
    if curl -fsSL "$acliurl" -o "$tmp/acli-download"; then
      if tar -tzf "$tmp/acli-download" >/dev/null 2>&1; then
        tar -xzf "$tmp/acli-download" -C "$tmp"
        install -o root -g root -m 0755 "$(find "$tmp" -type f -name acli | head -1)" /usr/local/bin/acli
      else
        install -o root -g root -m 0755 "$tmp/acli-download" /usr/local/bin/acli
      fi
      installed=1
      break
    fi
  done
  rm -rf "$tmp"
  if [ "$installed" -ne 1 ]; then
    echo "failed to install Atlassian CLI for $arch" >&2
    exit 1
  fi

  for required in node npm npx git jq gh acli; do
    if ! command -v "$required" >/dev/null 2>&1; then
      echo "required CLI missing after install: $required" >&2
      exit 1
    fi
  done
}

ensure_brain_cli() {
  # The Brain Trust CLI is a single executable script. Install only the shared
  # binary here; each Diwan Linux user keeps their own ~/.braintrust/config.
  local target="/usr/local/bin/brain"

  if [ -n "${DIWAN_BRAIN_CLI_BIN:-}" ] && [ -f "${DIWAN_BRAIN_CLI_BIN}" ]; then
    if [ ! -x "$target" ] || ! cmp -s "${DIWAN_BRAIN_CLI_BIN}" "$target"; then
      install -o root -g root -m 0755 "${DIWAN_BRAIN_CLI_BIN}" "$target"
      echo "installed brain CLI from ${DIWAN_BRAIN_CLI_BIN}"
    fi
    return 0
  fi

  if [ -f /opt/braintrust/dist/brain ]; then
    if [ ! -x "$target" ] || ! cmp -s /opt/braintrust/dist/brain "$target"; then
      install -o root -g root -m 0755 /opt/braintrust/dist/brain "$target"
      echo "installed brain CLI from /opt/braintrust/dist/brain"
    fi
    return 0
  fi

  if [ -n "${DIWAN_BRAIN_CLI_URL:-}" ]; then
    local tmp
    tmp="$(mktemp -d)"
    curl -fsSL --retry 3 "${DIWAN_BRAIN_CLI_URL}" -o "${tmp}/brain"
    install -o root -g root -m 0755 "${tmp}/brain" "$target"
    rm -rf "$tmp"
    echo "installed brain CLI from ${DIWAN_BRAIN_CLI_URL}"
    return 0
  fi

  if [ -x "$target" ]; then
    return 0
  fi

  echo "WARNING: brain CLI source unavailable; continuing without /usr/local/bin/brain. Set DIWAN_BRAIN_CLI_BIN or DIWAN_BRAIN_CLI_URL, or stage /opt/braintrust/dist/brain to install it." >&2
  return 0
}

ensure_opencode() {
  # Diwan embeds the DySoN OpenCode fork (anomalyco/opencode, dyson-sidebar-runtime
  # branch) which adds the Skills + Automations sidebar panels. The fork ships as a
  # single self-contained linux-x64 binary with the web UI embedded. Provide it via
  # DIWAN_OPENCODE_FORK_URL (tarball or raw binary) or DIWAN_OPENCODE_FORK_BIN (local
  # path); install to /usr/local/bin/opencode. Falls back to stock opencode-ai only
  # if no fork source is configured.
  local target="/usr/local/bin/opencode"

  if [ -n "${DIWAN_OPENCODE_FORK_BIN:-}" ] && [ -f "${DIWAN_OPENCODE_FORK_BIN}" ]; then
    install -m 0755 "${DIWAN_OPENCODE_FORK_BIN}" "$target"
    echo "installed OpenCode fork from ${DIWAN_OPENCODE_FORK_BIN}"
    return 0
  fi

  if [ -n "${DIWAN_OPENCODE_FORK_URL:-}" ]; then
    if [ "$(id -u)" -ne 0 ]; then
      echo "installing the OpenCode fork requires root." >&2
      exit 1
    fi
    local tmp
    tmp="$(mktemp -d)"
    curl -fsSL "${DIWAN_OPENCODE_FORK_URL}" -o "${tmp}/opencode-fork"
    # Accept either a raw ELF binary or a .tar.gz containing bin/opencode.
    if tar -tzf "${tmp}/opencode-fork" >/dev/null 2>&1; then
      tar -xzf "${tmp}/opencode-fork" -C "${tmp}"
      install -m 0755 "$(find "${tmp}" -type f -name opencode | head -1)" "$target"
    else
      install -m 0755 "${tmp}/opencode-fork" "$target"
    fi
    rm -rf "${tmp}"
    echo "installed OpenCode fork from ${DIWAN_OPENCODE_FORK_URL}"
    return 0
  fi

  if [ -x "$target" ]; then
    return 0
  fi

  if command -v opencode >/dev/null 2>&1; then
    local found
    found="$(command -v opencode)"
    if [ "$(id -u)" -ne 0 ]; then
      echo "opencode found at $found, but $target is required. Re-run as root to install the system-wide runtime binary." >&2
      exit 1
    fi
    install -m 0755 "$found" "$target"
    echo "installed OpenCode from $found to $target"
    return 0
  fi

  if [ "$(id -u)" -ne 0 ]; then
    echo "opencode is required. Re-run as root or install opencode before deploying." >&2
    exit 1
  fi

  echo "WARNING: no OpenCode fork source configured; falling back to stock opencode-ai (no DySoN sidebar)." >&2
  npm install -g opencode-ai
  if [ "$(command -v opencode)" != "/usr/local/bin/opencode" ]; then
    ln -sf "$(command -v opencode)" /usr/local/bin/opencode
  fi
}

install_sudoers() {
  if [ "$(id -u)" -ne 0 ]; then
    return 0
  fi

  cat > /etc/sudoers.d/diwan-opencode <<'SUDOERS'
diwan ALL=(ALL) NOPASSWD: /usr/bin/bash
SUDOERS
  chmod 0440 /etc/sudoers.d/diwan-opencode
  visudo -cf /etc/sudoers.d/diwan-opencode
}

install_nginx_site() {
  if ! command -v nginx >/dev/null 2>&1; then
    echo "nginx not installed; skipping nginx site install"
    return 0
  fi

  install -m 0644 "${APP_DIR}/nginx/diwan.conf" /etc/nginx/sites-available/diwan
  rm -f /etc/nginx/sites-enabled/default
  ln -sf /etc/nginx/sites-available/diwan /etc/nginx/sites-enabled/diwan
  nginx -t
  systemctl reload nginx || systemctl restart nginx
}

provision_persisted_session_users() {
  local sessions_file="/var/lib/diwan/code-sessions.json"
  local provision_script="${APP_DIR}/scripts/provision-diwan-user.sh"
  if [ ! -s "$sessions_file" ] || [ ! -x "$provision_script" ] || ! command -v jq >/dev/null 2>&1; then
    return 0
  fi

  jq -r '.[].linuxUser // empty' "$sessions_file" \
    | sort -u \
    | while IFS= read -r linux_user; do
        [ -n "$linux_user" ] || continue
        /usr/bin/bash "$provision_script" "$linux_user"
      done
}

# Stage the OpenCortex skill bundle so provision-diwan-user.sh can seed it into
# every user's ~/.opencode/skills and ~/.codex/skills. The bundle is maintained
# out-of-band and supplied as a local tarball or HTTPS URL. Optional legacy PAI
# content is unpacked only when the bundle carries it explicitly.
#
# Best-effort: a missing or unreachable bundle must NOT fail the install. If a
# fetch fails but the staged skills directory already exists, the existing copy
# is kept.
ensure_skills() {
  local bundle_path="${OPENCORTEX_SKILLS_BUNDLE_PATH:-${DIWAN_SKILLS_BUNDLE_PATH:-}}"
  local bundle_url="${OPENCORTEX_SKILLS_BUNDLE_URL:-${DIWAN_SKILLS_BUNDLE_URL:-}}"
  local dest="${OPENCORTEX_SKILLS_STAGING_DIR:-${DIWAN_BRAIN_DIR:-/opt/opencortex/skills}}"

  if [ -z "$bundle_path" ] && [ -z "$bundle_url" ]; then
    echo "ensure_skills: no skill bundle path or URL configured; skipping skills staging." >&2
    return 0
  fi

  local tmp
  tmp="$(mktemp -d)"
  local archive="${tmp}/skills.tar.gz"
  local fetched=0

  if [ -n "$bundle_path" ]; then
    if [ -f "$bundle_path" ]; then
      cp "$bundle_path" "$archive"
      fetched=1
    else
      echo "ensure_skills: skill bundle path not found: ${bundle_path}" >&2
    fi
  elif curl -fsSL --retry 3 "$bundle_url" -o "$archive"; then
    fetched=1
  else
    echo "ensure_skills: unable to fetch skill bundle URL: ${bundle_url}" >&2
  fi

  if [ "$fetched" -eq 1 ]; then
    if tar -xzf "${tmp}/skills.tar.gz" -C "${tmp}" 2>/dev/null \
       && [ -d "${tmp}/skills" ]; then
      mkdir -p "$dest"
      rm -rf "${dest}/skills"
      mv "${tmp}/skills" "${dest}/skills"
      if [ -d "${tmp}/PAI" ]; then
        rm -rf "${dest}/PAI"
        mv "${tmp}/PAI" "${dest}/PAI"
      fi
      echo "ensure_skills: staged skills to ${dest} ($(ls "${dest}/skills" | wc -l) packs)"
    else
      echo "ensure_skills: bundle malformed; leaving existing ${dest}/skills in place." >&2
    fi
  else
    echo "ensure_skills: leaving existing ${dest}/skills in place." >&2
  fi
  rm -rf "${tmp}"
}

ensure_node
ensure_rsync
ensure_clis
ensure_skills
ensure_brain_cli
ensure_opencode

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
install_sudoers

install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$APP_DIR" /var/lib/diwan /srv/diwan/workspaces
install -d -o root -g root /etc/diwan

rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude data \
  ./ "$APP_DIR/"

provision_persisted_session_users

cd "$APP_DIR"
rm -rf node_modules
npm ci
npm run build
npm prune --omit=dev
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" /var/lib/diwan

install -m 0644 systemd/diwan.service /etc/systemd/system/diwan.service
systemctl daemon-reload
systemctl enable diwan.service
systemctl restart diwan.service
install_nginx_site

echo "installed Diwan runtime at $APP_DIR"
