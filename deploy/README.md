# Deploying Dhruv FreightOps (Jarvis)

One-click Linux deploy for the voice agent demo at `jarvis.whoisdhruv.com`.

Target: Ubuntu 22.04/24.04, Debian 12, or Oracle Linux 9 on ARM64 (aarch64),
4 vCPU / 24 GB RAM, with nginx already installed and hosting two other
sites. The deploy script **never touches** the existing sites.

---

## Prerequisites

Before running the deploy script:

1. **DNS.** Point `jarvis.whoisdhruv.com` at the target box. You need BOTH:
   - `A    jarvis.whoisdhruv.com -> <IPv4 of the box>`
   - `AAAA jarvis.whoisdhruv.com -> <IPv6 of the box>` (optional but
     recommended — nginx listens on both).
   Verify with `dig +short jarvis.whoisdhruv.com` and
   `dig +short AAAA jarvis.whoisdhruv.com`.
2. **Repo on the box.** SSH in and clone:
   ```bash
   sudo mkdir -p /opt
   sudo git clone <repo-url> /opt/jarvis-freightops
   cd /opt/jarvis-freightops
   ```
3. **Cert email.** You need a contact email for Let's Encrypt (ACME requires
   it). Set `CERT_EMAIL` when you run the script.
4. **Port 80/443.** The box's firewall should already permit both (you have
   two other nginx sites on it). Port 3011 stays **localhost-only** — the
   Node service binds `127.0.0.1:3011`, nginx proxies.

---

## One-line install

```bash
sudo CERT_EMAIL=you@example.com bash /opt/jarvis-freightops/deploy/deploy.sh
```

What this does (in order):

1. Detects the OS + arch. Installs `nginx`, `certbot`, `jq`, `curl` if missing.
2. Installs Node 20 via NodeSource if your host has `node < 20`.
3. Creates the `jarvis` system user (no login shell). Chowns the repo.
4. Runs `npm ci --omit=dev` and `npm run build` as the `jarvis` user.
5. Creates `.env` from `.env.example` if missing (with a 0600 perm + warning).
6. Writes `/etc/systemd/system/jarvis-freightops.service`, enables it,
   starts it.
7. Waits for `http://127.0.0.1:3011/api/health` to return 200.
8. Copies `deploy/nginx/jarvis.whoisdhruv.com.conf` into
   `sites-available/`, symlinks from `sites-enabled/`, runs `nginx -t`,
   reloads.
9. Runs `certbot --nginx` for `jarvis.whoisdhruv.com` (only if the cert
   doesn't exist yet — idempotent).
10. Verifies `https://jarvis.whoisdhruv.com/api/health` returns 200.
11. Prints a summary with journalctl and edit-env reminders.

Safe to re-run: every step is a no-op on a fully-applied host.

### Script options

```
--target <dir>   Installation directory (default: /opt/jarvis-freightops)
--domain <host>  Nginx server_name       (default: jarvis.whoisdhruv.com)
```

### What if I don't have CERT_EMAIL yet?

The script installs the HTTP block + the Node service, but leaves TLS off.
The site runs on port 80 (no HTTPS). Once DNS is ready and you have an
email, run:

```bash
sudo certbot --nginx -d jarvis.whoisdhruv.com \
    --non-interactive --agree-tos -m you@example.com --redirect
```

Then re-run `deploy.sh` so the `:443` server block is restored from the
template.

---

## Env var cheat sheet

Edit `/opt/jarvis-freightops/.env` (created by the script). All are optional
except `GEMINI_API_KEY`.

| Var | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | *(unset — FAIL)* | Google Gemini API key with Live API access. |
| `PORT` | `3011` | TCP port the Node service binds on 127.0.0.1. |
| `NODE_ENV` | `development` | `production` serves minified `dist/` with long `Cache-Control`. |
| `DEBUG` | *(unset)* | Set to `1` for per-session bridge logs. |
| `GEMINI_TRANSCRIPTION` | `false` | Include server-side transcription in Live config. `false` saves STT credits; browser uses local Web Speech for user side. |
| `SHOW_TEXT` | `true` | Render transcript panel + tool args in UI + server logs. `false` shows tool NAMES only in the activity log; transcript panel hidden; server redacts text from logs. |
| `ALLOWED_ORIGINS` | *(empty = localhost-only)* | Comma-separated HTTPS origins allowed for WS upgrade. Set once you have a custom front-end hitting this service. |
| `GEMINI_LIVE_MODEL` | `gemini-3.1-flash-live-preview` | Pin a Live model. |
| `GEMINI_EVAL_MODEL` | `gemini-2.5-flash` | Model for `/api/eval`. |
| `SOURCEMAPS` | *(unset)* | Set `true` to emit source maps in `npm run build`. |

After editing `.env`, `sudo systemctl restart jarvis-freightops`. The Node
process reads env once at startup.

### Flag behaviour matrix

| `GEMINI_TRANSCRIPTION` | `SHOW_TEXT` | Transcript shown | Source | Server logs text |
|---|---|---|---|---|
| `false` | `true` | yes, user only | local Web Speech API | yes |
| `false` | `false` | no | — | no |
| `true` | `true` | yes, both sides | Gemini | yes |
| `true` | `false` | no | — | no |

When `GEMINI_TRANSCRIPTION=false` AND `SHOW_TEXT=true`, a subtle hint appears
under the transcript: "Agent speech not transcribed (configured to save
credits)."

---

## Operating the service

### Live log tail
```bash
sudo journalctl -u jarvis-freightops -f --output=short
```

### Health check
```bash
curl -s http://127.0.0.1:3011/api/health            # behind nginx
curl -s https://jarvis.whoisdhruv.com/api/health    # public
```

### Restart after env change
```bash
sudo systemctl restart jarvis-freightops
```

### Update nginx config (after editing `deploy/nginx/*.conf` in the repo)
```bash
sudo cp /opt/jarvis-freightops/deploy/nginx/jarvis.whoisdhruv.com.conf \
       /etc/nginx/sites-available/jarvis.whoisdhruv.com.conf
sudo nginx -t && sudo systemctl reload nginx
```

---

## Updating the application

### Routine update (pull + restart)
```bash
cd /opt/jarvis-freightops
sudo -u jarvis git pull
sudo -u jarvis npm ci --omit=dev      # only if package-lock changed
sudo -u jarvis npm run build          # only if js/ or css/ changed
sudo systemctl restart jarvis-freightops
```

### Full redeploy
```bash
cd /opt/jarvis-freightops && sudo -u jarvis git pull
sudo CERT_EMAIL=you@example.com bash deploy/deploy.sh
```

---

## Rollback

### To the previous git revision
```bash
cd /opt/jarvis-freightops
sudo -u jarvis git log --oneline -n 10               # find the commit
sudo -u jarvis git checkout <sha>
sudo -u jarvis npm ci --omit=dev
sudo -u jarvis npm run build
sudo systemctl restart jarvis-freightops
```

### To stop the service (so nginx returns 502 without running Node)
```bash
sudo systemctl stop jarvis-freightops
sudo systemctl disable jarvis-freightops
```

### Uninstall completely
```bash
sudo systemctl disable --now jarvis-freightops
sudo rm /etc/systemd/system/jarvis-freightops.service
sudo rm /etc/nginx/sites-enabled/jarvis.whoisdhruv.com.conf
sudo rm /etc/nginx/sites-available/jarvis.whoisdhruv.com.conf
sudo systemctl daemon-reload
sudo nginx -t && sudo systemctl reload nginx
sudo userdel jarvis                                  # optional
sudo rm -rf /opt/jarvis-freightops                   # optional
```

Cert files under `/etc/letsencrypt/live/jarvis.whoisdhruv.com/` are kept by
certbot; delete with `sudo certbot delete --cert-name jarvis.whoisdhruv.com`
if you want a clean slate.

---

## Troubleshooting

### `502 Bad Gateway` in the browser
The Node service isn't running, or crashed.
```bash
sudo systemctl status jarvis-freightops
sudo journalctl -u jarvis-freightops -n 100 --output=short
```

### `websocket connection closed abnormally` in DevTools
Usually a cert issue (WebSocket on a mixed http/https page) or nginx's
`proxy_read_timeout` is shorter than your call. The provided config sets
`3600s`. Double-check `/etc/nginx/sites-available/jarvis.whoisdhruv.com.conf`
still has `proxy_set_header Upgrade $http_upgrade;` on `/api/live`.

### `No audio playback` in Safari/Chrome
The browser's autoplay policy blocked `AudioContext.resume()` because the
user hasn't gestured yet. Click **Place Call** — it triggers the sync
unlock path. If the in-dock hint "Enable audio" appears, click it.

### `Gemini rejected the API key`
`GEMINI_API_KEY` in `/opt/jarvis-freightops/.env` is wrong or unset. Edit
and `sudo systemctl restart jarvis-freightops`.

### `429 Too Many Requests` on the WS upgrade
The per-IP rate limiter (see `api/rate-limit.js`) hit its cap (60
sessions/hour, 1 concurrent). Normal for a noisy dev session — wait a
minute.

### Certbot asks to renew my other sites
That's fine — certbot renews ALL certs on the box. It's cron-scheduled by
default; no action needed.

---

## What's in `deploy/`

| File | Purpose |
|---|---|
| `deploy.sh` | Idempotent installer (this is the one you run). |
| `nginx/jarvis.whoisdhruv.com.conf` | Site config; 80→443 redirect + TLS 1.2/1.3 + HTTP/2 + CSP + HSTS + WS upgrade for `/api/live`. |
| `README.md` | This file. |

The `systemd` unit (`jarvis-freightops.service`) is **generated by**
`deploy.sh` so it can interpolate paths/user, and written to
`/etc/systemd/system/`. If you want to template it separately, copy it out
after the first run:
```bash
sudo cat /etc/systemd/system/jarvis-freightops.service
```
