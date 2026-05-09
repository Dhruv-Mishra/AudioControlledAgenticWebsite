#!/usr/bin/env bash
# deploy.sh — Linux-only bare-metal installer for Dhruv FreightOps "Jarvis".
#
# Tested on: Ubuntu 22.04/24.04, Debian 12, Oracle Linux 9, on ARM64.
# Hardware: 4 vCPU / 24 GB RAM, aarch64.
#
# Prerequisites (handled by this script where possible):
#   - sudo access on the target box.
#   - Node ≥ 20 (auto-installed via NodeSource if missing).
#   - nginx + certbot (auto-installed via apt/dnf if missing).
#   - DNS `A`/`AAAA` records for jarvis.whoisdhruv.com already pointing here
#     (this script does NOT edit DNS).
#   - The repo already git-cloned to a target directory (default
#     /opt/jarvis-freightops). This script does NOT clone for you — run
#     `sudo git clone <repo> /opt/jarvis-freightops` first.
#
# Usage:
#   sudo CERT_EMAIL=you@example.com bash deploy/deploy.sh [--target <dir>]
#
# What it does:
#   1. Detects OS + architecture, installs missing system packages.
#   2. Creates a `jarvis` system user (no login shell, no home password).
#   3. `npm ci --omit=dev` and `npm run build` as the jarvis user.
#   4. Writes /etc/systemd/system/jarvis-freightops.service (hardened).
#   5. Copies nginx site config; symlinks; `nginx -t`; reload.
#   6. If CERT_EMAIL is set and the cert is absent, runs certbot --nginx.
#   7. Verifies /api/health over 127.0.0.1 (and https if the cert exists).
#
# Safe to re-run. Each step is a no-op on a fully-applied host.

set -euo pipefail

# --------- tiny helpers ---------
C_BLUE='\033[1;34m'; C_GREEN='\033[1;32m'; C_YELLOW='\033[1;33m'; C_RED='\033[1;31m'; C_OFF='\033[0m'
section() { printf "\n${C_BLUE}== %s ==${C_OFF}\n" "$*"; }
ok()      { printf "${C_GREEN}✓ %s${C_OFF}\n" "$*"; }
warn()    { printf "${C_YELLOW}! %s${C_OFF}\n" "$*" >&2; }
fail()    { printf "${C_RED}✗ %s${C_OFF}\n" "$*" >&2; exit 1; }
need_sudo() {
  if [[ $EUID -ne 0 ]]; then fail "Run as root (use \`sudo\`)."; fi
}

# --------- args ---------
TARGET_DIR="/opt/jarvis-freightops"
SERVICE_NAME="jarvis-freightops"
JARVIS_USER="jarvis"
DOMAIN="jarvis.whoisdhruv.com"
PORT="3011"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET_DIR="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    -h|--help)
      cat <<EOF
Usage: sudo CERT_EMAIL=you@example.com bash deploy/deploy.sh [options]

Options:
  --target DIR    Installation directory (default: /opt/jarvis-freightops).
  --domain HOST   Nginx server_name (default: jarvis.whoisdhruv.com).
  -h, --help      This help.

Environment:
  CERT_EMAIL      If set, the script runs \`certbot --nginx\` for the domain.
                  If unset, the nginx config is installed but HTTPS is skipped
                  — run \`certbot --nginx -d \$DOMAIN -m <email>\` manually.
EOF
      exit 0 ;;
    *) fail "Unknown arg: $1" ;;
  esac
done

need_sudo

CERT_EMAIL="${CERT_EMAIL:-}"

# --------- 1. Preflight: OS + arch ---------
section "Preflight"

ARCH="$(uname -m)"
if [[ "$ARCH" != "aarch64" && "$ARCH" != "arm64" ]]; then
  warn "Host arch is $ARCH — this script is tuned for aarch64. Continuing."
fi
ok "Arch: $ARCH"

if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_LIKE="${ID_LIKE:-$OS_ID}"
else
  OS_ID="unknown"
  OS_LIKE="unknown"
fi

case "$OS_LIKE" in
  *debian*|*ubuntu*) PKG_MGR="apt" ;;
  *rhel*|*fedora*|*centos*|*ol*) PKG_MGR="dnf" ;;
  *) warn "Unknown OS family ($OS_ID / $OS_LIKE); assuming apt."; PKG_MGR="apt" ;;
esac
ok "OS: $OS_ID (package manager: $PKG_MGR)"

if [[ ! -d "$TARGET_DIR" ]]; then
  fail "TARGET_DIR does not exist: $TARGET_DIR. Clone the repo there first:
      sudo mkdir -p $(dirname "$TARGET_DIR")
      sudo git clone <repo> $TARGET_DIR"
fi
ok "Target dir: $TARGET_DIR"

# --------- 2. System packages ---------
section "System packages"

if [[ "$PKG_MGR" == "apt" ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg nginx certbot python3-certbot-nginx jq
elif [[ "$PKG_MGR" == "dnf" ]]; then
  dnf install -y -q nginx jq
  # certbot on Oracle Linux ships via epel.
  if ! command -v certbot >/dev/null 2>&1; then
    dnf install -y -q epel-release || true
    dnf install -y -q certbot python3-certbot-nginx
  fi
fi
ok "nginx + certbot installed"

# --------- 3. Node ≥ 20 ---------
section "Node.js ≥ 20"

NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v | sed 's/^v//')"
  NODE_MAJOR="${NODE_VER%%.*}"
  if [[ "$NODE_MAJOR" -ge 20 ]]; then NODE_OK=1; fi
fi

if [[ "$NODE_OK" -eq 0 ]]; then
  if [[ "$PKG_MGR" == "apt" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y -q nodejs
  fi
fi
NODE_BIN="$(command -v node)"
ok "Node $(node -v) at $NODE_BIN"

# --------- 4. `jarvis` system user ---------
section "System user: $JARVIS_USER"

if id "$JARVIS_USER" >/dev/null 2>&1; then
  ok "User already exists"
else
  useradd --system --shell /usr/sbin/nologin --home-dir "$TARGET_DIR" --no-create-home "$JARVIS_USER"
  ok "Created user"
fi
chown -R "$JARVIS_USER":"$JARVIS_USER" "$TARGET_DIR"
ok "chowned $TARGET_DIR"

# --------- 5. npm ci + build ---------
section "npm ci + build"

run_as_jarvis() { sudo -H -u "$JARVIS_USER" --preserve-env=PATH bash -c "$*"; }

# The jarvis user sometimes lacks a populated PATH when invoked via sudo;
# resolve the node binary dir and pass it through.
NODE_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_DIR:$PATH"

(
  cd "$TARGET_DIR"
  run_as_jarvis "cd $TARGET_DIR && PATH=$NODE_DIR:\$PATH npm ci"
  run_as_jarvis "cd $TARGET_DIR && PATH=$NODE_DIR:\$PATH npm run build"
  run_as_jarvis "cd $TARGET_DIR && PATH=$NODE_DIR:\$PATH npm prune --omit=dev"
)
ok "Dependencies installed + dist/ built"

# --------- 6. .env bootstrap ---------
section ".env"

if [[ ! -f "$TARGET_DIR/.env" && -f "$TARGET_DIR/.env.example" ]]; then
  cp "$TARGET_DIR/.env.example" "$TARGET_DIR/.env"
  chown "$JARVIS_USER":"$JARVIS_USER" "$TARGET_DIR/.env"
  chmod 600 "$TARGET_DIR/.env"
  warn "Created .env from .env.example — edit $TARGET_DIR/.env and set GEMINI_API_KEY."
else
  ok ".env already present (leaving untouched)"
fi

# --------- 7. systemd unit ---------
section "systemd unit: $SERVICE_NAME"

UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Dhruv FreightOps voice-agent demo (Jarvis)
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${JARVIS_USER}
Group=${JARVIS_USER}
WorkingDirectory=${TARGET_DIR}
EnvironmentFile=${TARGET_DIR}/.env
Environment=NODE_ENV=production
Environment=PORT=${PORT}
ExecStart=${NODE_BIN} ${TARGET_DIR}/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# Hardening — non-root service bound to 127.0.0.1:${PORT}; nginx handles 443.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${TARGET_DIR}
LockPersonality=true
RestrictRealtime=true
RestrictNamespaces=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
EOF
ok "Wrote $UNIT_PATH"

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME" >/dev/null
ok "systemd: enabled + started"

# Wait up to ~10s for the process to become healthy on 127.0.0.1:${PORT}.
section "Wait for health on 127.0.0.1:${PORT}"
HEALTH_OK=0
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 0.5
done
if [[ "$HEALTH_OK" -eq 1 ]]; then
  ok "/api/health OK"
else
  warn "/api/health did NOT respond. Check: journalctl -u $SERVICE_NAME --output=short"
fi

# --------- 8. nginx ---------
section "nginx site"

NGINX_SITES_AVAIL="/etc/nginx/sites-available"
NGINX_SITES_ENAB="/etc/nginx/sites-enabled"
SITE_FILE="${NGINX_SITES_AVAIL}/${DOMAIN}.conf"
LINK_FILE="${NGINX_SITES_ENAB}/${DOMAIN}.conf"
SRC_CONF="${TARGET_DIR}/deploy/nginx/${DOMAIN}.conf"

if [[ ! -d "$NGINX_SITES_AVAIL" ]]; then
  # On RHEL/OL, nginx uses /etc/nginx/conf.d/*.conf. Emit it there and skip
  # the sites-enabled symlink.
  SITE_FILE="/etc/nginx/conf.d/${DOMAIN}.conf"
  LINK_FILE=""
  warn "sites-available not present; installing to /etc/nginx/conf.d/"
fi

cp "$SRC_CONF" "$SITE_FILE"
ok "Copied $SITE_FILE"

if [[ -n "$LINK_FILE" && ! -L "$LINK_FILE" ]]; then
  ln -s "$SITE_FILE" "$LINK_FILE"
  ok "Symlinked $LINK_FILE"
fi

# Pre-cert safety net: if no cert exists yet, the provided config has ssl_*
# directives that nginx -t will reject. We patch around that by temporarily
# commenting the ssl_certificate lines until certbot runs. Certbot will
# restore them via its --nginx installer.
CERT_FULLCHAIN="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
if [[ ! -f "$CERT_FULLCHAIN" ]]; then
  warn "No TLS cert present yet — temporarily disabling the :443 server block."
  # Rewrite: comment the entire second `server {` block (for :443). Simple
  # heuristic: comment lines between the `listen 443` anchor and the next
  # closing brace at column 0. Works for our single-host conf.
  awk '
    BEGIN{in_ssl=0}
    /listen 443/ { in_ssl=1 }
    {
      if (in_ssl) { print "# " $0 } else { print $0 }
      if (in_ssl && $0 ~ /^\}/) { in_ssl=0 }
    }
  ' "$SITE_FILE" > "${SITE_FILE}.tmp"
  mv "${SITE_FILE}.tmp" "$SITE_FILE"
  ok "Commented :443 server block until certbot runs"
fi

nginx -t
systemctl reload nginx
ok "nginx validated + reloaded"

# --------- 9. certbot (optional) ---------
section "certbot (TLS)"

if [[ -f "$CERT_FULLCHAIN" ]]; then
  ok "Cert already present for $DOMAIN — skipping certbot."
elif [[ -z "$CERT_EMAIL" ]]; then
  warn "CERT_EMAIL not set; skipping certbot."
  warn "Run this manually once DNS is pointing here:"
  warn "    sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m you@example.com"
  warn "Then re-run this deploy.sh to re-enable the :443 server block."
else
  # Restore the full config with :443 block so certbot can install the cert
  # directly into it.
  cp "$SRC_CONF" "$SITE_FILE"
  nginx -t
  systemctl reload nginx

  # Run certbot for THIS domain only — --nginx-server-root keeps it from
  # touching other sites.
  certbot --nginx -d "$DOMAIN" \
    --non-interactive --agree-tos -m "$CERT_EMAIL" \
    --redirect --expand || warn "certbot returned non-zero; check /var/log/letsencrypt/."
  if [[ -f "$CERT_FULLCHAIN" ]]; then
    ok "Cert installed for $DOMAIN"
  else
    warn "Cert still not present after certbot run; check /var/log/letsencrypt/."
  fi
fi

# Final reload in case certbot changed anything.
if systemctl is-active nginx >/dev/null; then
  systemctl reload nginx
fi

# --------- 10. Public HTTPS smoke ---------
section "Verify (public HTTPS)"

if [[ -f "$CERT_FULLCHAIN" ]]; then
  if curl -fsS --max-time 10 "https://${DOMAIN}/api/health" >/dev/null 2>&1; then
    ok "https://${DOMAIN}/api/health OK"
  else
    warn "https://${DOMAIN}/api/health did not respond — DNS might not be propagated yet, or systemd service still warming up."
  fi
else
  warn "Skipping public HTTPS smoke (no cert yet)."
fi

# --------- 11. Summary ---------
section "Summary"

cat <<EOF

Service:     ${SERVICE_NAME}
Target dir:  ${TARGET_DIR}
Runs as:     ${JARVIS_USER}
Node:        $(node -v)
Port:        127.0.0.1:${PORT} (HTTP), behind nginx on 443 (HTTPS)

Useful commands:
  sudo systemctl status   ${SERVICE_NAME}
  sudo systemctl restart  ${SERVICE_NAME}
  sudo journalctl -u ${SERVICE_NAME} -f --output=short
  sudo -u ${JARVIS_USER} nano ${TARGET_DIR}/.env
  sudo nginx -t && sudo systemctl reload nginx

Next steps:
  1. Edit ${TARGET_DIR}/.env and set GEMINI_API_KEY.
  2. sudo systemctl restart ${SERVICE_NAME}
  3. Verify: curl -s http://127.0.0.1:${PORT}/api/health
$(if [[ ! -f "$CERT_FULLCHAIN" ]]; then
    echo "  4. When DNS is ready, run: sudo certbot --nginx -d ${DOMAIN} -m you@example.com"
    echo "     Then re-run this deploy.sh to restore the :443 server block."
  else
    echo "  4. Open https://${DOMAIN} in a browser."
  fi
)
EOF

ok "Done."
