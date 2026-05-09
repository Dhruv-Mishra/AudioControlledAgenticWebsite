#!/usr/bin/env bash
set -euo pipefail

section() { printf '\n== %s ==\n' "$*"; }
info() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_DIR="/opt/jarvis-freightops"
APP_OWNER="${SUDO_USER:-$(id -un)}"
FORCE=0

usage() {
  cat <<EOF
Usage: sudo bash deploy/bootstrap-vm.sh [options]

Options:
  --app-dir <dir>   Target runtime directory. Default: /opt/jarvis-freightops
  --owner <user>    User that should own the runtime directory. Default: invoking sudo user
  --force           Overwrite generated local config files if they already exist
  -h, --help        Show this help

What this script does:
  1. Installs Docker Engine and Docker Compose plugin if missing
  2. Enables and starts the Docker service
  3. Creates the runtime directory layout
  4. Copies compose.yaml and deploy/remote-deploy.sh into the runtime directory
  5. Creates .env and deploy/system.env.local from repo templates if missing

What it does NOT do:
  - fill real secrets into .env
  - configure GitHub secrets
  - configure nginx / TLS
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir)
      APP_DIR="$2"
      shift 2
      ;;
    --owner)
      APP_OWNER="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

[[ $EUID -eq 0 ]] || fail 'Run this script with sudo.'
id "$APP_OWNER" >/dev/null 2>&1 || fail "User does not exist: $APP_OWNER"
[[ -f "$REPO_ROOT/compose.yaml" ]] || fail 'Run this from a cloned repository.'
[[ -f "$REPO_ROOT/.env.example" ]] || fail 'Missing .env.example in the repository.'
[[ -f "$REPO_ROOT/deploy/system.env.example" ]] || fail 'Missing deploy/system.env.example in the repository.'
[[ -f "$REPO_ROOT/deploy/remote-deploy.sh" ]] || fail 'Missing deploy/remote-deploy.sh in the repository.'

detect_pkg_mgr() {
  [[ -f /etc/os-release ]] || fail 'Cannot detect OS: /etc/os-release not found.'
  # shellcheck disable=SC1091
  . /etc/os-release
  local like="${ID_LIKE:-${ID:-}}"
  case "$like" in
    *debian*|*ubuntu*) echo apt ;;
    *rhel*|*fedora*|*centos*|*ol*) echo dnf ;;
    *) fail "Unsupported Linux distribution: ${ID:-unknown}" ;;
  esac
}

install_docker_apt() {
  section 'Installing Docker via apt'
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
    curl -fsSL https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
  fi
  local arch codename repo_file
  arch="$(dpkg --print-architecture)"
  # shellcheck disable=SC1091
  . /etc/os-release
  codename="${VERSION_CODENAME:-}"
  [[ -n "$codename" ]] || fail 'Could not detect Debian/Ubuntu codename.'
  repo_file=/etc/apt/sources.list.d/docker.list
  if [[ ! -f "$repo_file" ]]; then
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
      "$arch" "$ID" "$codename" > "$repo_file"
  fi
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

install_docker_dnf() {
  section 'Installing Docker via dnf'
  dnf install -y -q dnf-plugins-core ca-certificates curl
  if [[ ! -f /etc/yum.repos.d/docker-ce.repo ]]; then
    dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  fi
  dnf install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

ensure_curl() {
  command -v curl >/dev/null 2>&1 && return
  section 'Installing curl'
  case "$(detect_pkg_mgr)" in
    apt)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq curl ca-certificates
      ;;
    dnf)
      dnf install -y -q curl ca-certificates
      ;;
    *)
      fail 'Could not install curl on this distribution.'
      ;;
  esac
}

ensure_docker() {
  local pkg_mgr
  pkg_mgr="$(detect_pkg_mgr)"
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    info 'Docker and Docker Compose plugin already installed.'
  else
    case "$pkg_mgr" in
      apt) install_docker_apt ;;
      dnf) install_docker_dnf ;;
      *) fail "Unhandled package manager: $pkg_mgr" ;;
    esac
  fi

  section 'Enabling Docker service'
  systemctl enable --now docker
  usermod -aG docker "$APP_OWNER" || true
}

write_system_env() {
  local target_file="$1"
  awk -v app_env_file="${APP_DIR}/.env" '
    /^APP_ENV_FILE=/ { print "APP_ENV_FILE=" app_env_file; next }
    { print }
  ' "$REPO_ROOT/deploy/system.env.example" > "$target_file"
}

copy_if_missing_or_forced() {
  local src="$1"
  local dst="$2"
  local mode="$3"
  if [[ -f "$dst" && "$FORCE" -ne 1 ]]; then
    info "Keeping existing file: $dst"
    return
  fi
  install -m "$mode" "$src" "$dst"
}

prepare_runtime_layout() {
  section 'Preparing runtime layout'
  install -d -m 0755 "$APP_DIR"
  install -d -m 0755 "$APP_DIR/deploy"

  install -m 0644 "$REPO_ROOT/compose.yaml" "$APP_DIR/compose.yaml"
  install -m 0755 "$REPO_ROOT/deploy/remote-deploy.sh" "$APP_DIR/deploy/remote-deploy.sh"
  install -m 0644 "$REPO_ROOT/.env.example" "$APP_DIR/.env.example"
  install -m 0644 "$REPO_ROOT/deploy/system.env.example" "$APP_DIR/deploy/system.env.example"

  if [[ ! -f "$APP_DIR/.env" || "$FORCE" -eq 1 ]]; then
    copy_if_missing_or_forced "$REPO_ROOT/.env.example" "$APP_DIR/.env" 0600
  else
    chmod 600 "$APP_DIR/.env"
    info "Keeping existing file: $APP_DIR/.env"
  fi

  if [[ ! -f "$APP_DIR/deploy/system.env.local" || "$FORCE" -eq 1 ]]; then
    write_system_env "$APP_DIR/deploy/system.env.local"
    chmod 0644 "$APP_DIR/deploy/system.env.local"
  else
    info "Keeping existing file: $APP_DIR/deploy/system.env.local"
  fi

  chown -R "$APP_OWNER":"$APP_OWNER" "$APP_DIR"
}

verify_setup() {
  section 'Verifying setup'
  docker --version
  docker compose version
  [[ -f "$APP_DIR/compose.yaml" ]] || fail "Missing file: $APP_DIR/compose.yaml"
  [[ -f "$APP_DIR/deploy/remote-deploy.sh" ]] || fail "Missing file: $APP_DIR/deploy/remote-deploy.sh"
  [[ -f "$APP_DIR/.env" ]] || fail "Missing file: $APP_DIR/.env"
  [[ -f "$APP_DIR/deploy/system.env.local" ]] || fail "Missing file: $APP_DIR/deploy/system.env.local"
}

print_next_steps() {
  section 'Next steps'
  cat <<EOF
Machine bootstrap completed.

Files created:
  $APP_DIR/.env
  $APP_DIR/deploy/system.env.local
  $APP_DIR/compose.yaml
  $APP_DIR/deploy/remote-deploy.sh

Do this next:
  1. Edit $APP_DIR/.env and fill the real secrets.
  2. Add your GitHub Actions SSH public key to ${APP_OWNER}'s ~/.ssh/authorized_keys.
  3. In the repo, replace the host placeholder in deploy/targets.json with this machine's public IP. Change user or paths only if you are not using the defaults.
  4. In GitHub, create PROD_SSH_PRIVATE_KEY. PROD_SSH_KNOWN_HOSTS is optional if you want pinned SSH host keys.
  5. Push to master to trigger the production workflow.

Notes:
  - ${APP_OWNER} was added to the docker group. A new login session may be needed.
  - If you use a reverse proxy, keep HOST_BIND=127.0.0.1 in deploy/system.env.local.
EOF
}

ensure_docker
ensure_curl
prepare_runtime_layout
verify_setup
print_next_steps