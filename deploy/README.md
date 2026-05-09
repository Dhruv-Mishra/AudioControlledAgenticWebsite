# Deployment

The production path is now:

1. GitHub Actions builds one immutable Docker image on every `master` push.
2. GitHub pushes that image to GHCR.
3. GitHub deploys that exact image digest to one or more VMs over SSH.
4. Each VM keeps only machine-local config and secrets.

That is the better long-term design than rebuilding on each VM. It gives you one artifact per commit, straightforward multi-VM fan-out, and clean rollback by image digest.

## Fastest VM setup

If you want the shortest possible machine setup, do this on the VM after cloning the repo:

```bash
sudo bash deploy/bootstrap-vm.sh
```

That one script will:

1. install Docker Engine and the Docker Compose plugin if missing,
2. enable and start Docker,
3. create `/opt/jarvis-freightops`,
4. copy `compose.yaml` and `deploy/remote-deploy.sh` there,
5. create `/opt/jarvis-freightops/.env` from `.env.example`,
6. create `/opt/jarvis-freightops/deploy/system.env.local` from defaults.

After that, you only need to fill the real secrets in `/opt/jarvis-freightops/.env`, add your SSH key for GitHub Actions, and complete the GitHub-side configuration.

## Two modes

### Manual machine deploy

Use this when you are on a cloned checkout and want to deploy locally or on a non-production machine.

```bash
npm run deploy              # build locally and run with Docker Compose
npm run deploy:sync-master  # fast-forward this checkout to origin/master
npm run deploy:sync-up      # fast-forward to origin/master, then deploy
```

### Production deploy

Use GitHub Actions for real production. Build once on GitHub, then ship the same image to every VM.

## What lives where

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage production image build. |
| `compose.yaml` | Runtime contract for both local Docker Compose and VM deploys. |
| `deploy/deploy.mjs` | Cross-platform local deploy runner. Supports local build mode and `sync-up`. |
| `deploy/remote-deploy.sh` | Linux VM deploy script used by GitHub Actions. Pulls a pinned image and restarts the service. |
| `deploy/system.env.example` | Template for machine-local deploy settings. |
| `deploy/targets.json` | VM inventory for GitHub Actions rollouts. Add one object per VM. |
| `.github/workflows/deploy-production.yml` | Build-and-deploy workflow triggered by `master` pushes. |
| `deploy/nginx/jarvis.whoisdhruv.com.conf` | Example reverse proxy config when you want HTTPS in front of the VM. |

## End-to-end setup

### 1. Prepare the VM once

On each production VM:

The easy path is to run:

```bash
sudo bash deploy/bootstrap-vm.sh
```

If you prefer to do it manually, the bootstrap script is just automating these steps:

1. Install Docker Engine and the Docker Compose plugin.
2. Install `curl`.
3. Create the app directory.
4. Create `.env` with the app secrets.
5. Create `deploy/system.env.local` with machine-specific settings.

Example layout on the VM:

```text
/opt/jarvis-freightops/
   .env
   compose.yaml                  # copied by GitHub Actions on each deploy
   deploy/
      remote-deploy.sh            # copied by GitHub Actions on each deploy
      system.env.local            # created once on the VM
```

Minimal `.env` on the VM:

```dotenv
GEMINI_API_KEY=...
WS_NONCE_SECRET=...
ALLOWED_ORIGINS=https://your-domain.example.com
```

Minimal `deploy/system.env.local` on the VM:

```dotenv
COMPOSE_PROJECT_NAME=freightops
HOST_BIND=127.0.0.1
HOST_PORT=3011
CONTAINER_PORT=3011
APP_ENV_FILE=/opt/jarvis-freightops/.env
HEALTHCHECK_PROTOCOL=http
HEALTHCHECK_HOST=127.0.0.1
HEALTHCHECK_PORT=3011
HEALTHCHECK_PATH=/api/health
HEALTHCHECK_TIMEOUT_MS=60000
```

Keep `HOST_BIND=127.0.0.1` when nginx, Caddy, or Traefik will proxy to the container.

The bootstrap script supports a custom target directory and owner too:

```bash
sudo bash deploy/bootstrap-vm.sh --app-dir /srv/jarvis --owner deploy
```

### 2. Decide whether the GHCR image is public or private

You have two options:

1. Make the GHCR package public. This is the simplest path. The VM can pull images without a registry token.
2. Keep the GHCR package private. Then GitHub Actions must send a pull-only GHCR username and token to the VM during deployment.

If you keep it private, create a read-only GHCR token and store it in GitHub secrets as `GHCR_PULL_USERNAME` and `GHCR_PULL_TOKEN`.

### 3. Fill in the VM inventory

Edit `deploy/targets.json` in the repo. In the default case you only replace the placeholder host with the VM public IP or a DNS-only deploy hostname.

If you do not want to commit the host into the repo, you can leave the placeholder in place and set `PROD_VM_HOST` in GitHub instead.

Example:

```json
[
   {
      "name": "prod-1",
      "host": "92.4.78.70",
      "port": 22,
   "user": "ubuntu",
      "appDir": "/opt/jarvis-freightops",
      "systemEnvFile": "/opt/jarvis-freightops/deploy/system.env.local",
      "appEnvFile": "/opt/jarvis-freightops/.env",
      "healthUrl": "http://127.0.0.1:3011/api/health",
      "healthTimeoutSeconds": 90
   }
]
```

The workflow rolls targets serially with `max-parallel: 1`, which is the correct default before you introduce a load balancer.

The `user` value must be the actual SSH login for the VM and it should usually own the app directory. If you ran `sudo bash deploy/bootstrap-vm.sh` without `--owner`, this is normally the user who invoked `sudo`, not automatically `deploy`.

### 4. Add GitHub secrets

In the GitHub repository settings, add:

| Secret | Required | Purpose |
|---|---|---|
| `PROD_SSH_PRIVATE_KEY` | yes | Private key for the deploy user on the VM(s). |
| `PROD_SSH_KNOWN_HOSTS` | optional | Pinned `known_hosts` entries for each VM. If omitted, the workflow runs `ssh-keyscan` against the target host at deploy time. |
| `PROD_VM_HOST` | optional | VM public IP or SSH hostname when you want GitHub to supply the host instead of committing it in `deploy/targets.json`. Prefer a repository variable for this; a secret also works. |
| `PROD_VM_USER` | optional | VM SSH login when you want GitHub to supply the user instead of committing it in `deploy/targets.json`. Prefer a repository variable for this; a secret also works. |
| `GHCR_PULL_USERNAME` | only for private GHCR images | Read-only GHCR username. |
| `GHCR_PULL_TOKEN` | only for private GHCR images | Read-only GHCR token. |

Minimum required setup for the SSH path:

1. Put the VM public IP in `deploy/targets.json`.
2. Put the VM SSH user in `deploy/targets.json`.
3. Create `PROD_SSH_PRIVATE_KEY`.

That is enough for the workflow to connect because it will auto-discover the host key from the target IP.

Alternative if you do not want the host committed in the repo:

1. Leave `deploy/targets.json` with the placeholder host.
2. Create a repository variable named `PROD_VM_HOST` with the VM public IP or deploy hostname.
3. Create a repository variable named `PROD_VM_USER` with the VM SSH login.
4. Create `PROD_SSH_PRIVATE_KEY`.

If your workflow reaches the SSH copy step and then fails, the most common cause is that the `user` does not match the actual SSH login or does not own `appDir`.

If you want stricter SSH pinning, also create `PROD_SSH_KNOWN_HOSTS`.

How to generate `PROD_SSH_KNOWN_HOSTS` manually:

```bash
ssh-keyscan -H 92.4.78.70
ssh-keyscan -H deploy.example.com
```

Paste the combined output into the secret. The host on the left side must match the `host` value in `deploy/targets.json`.

### 5. Push to `master`

On every push to `master`, `.github/workflows/deploy-production.yml` will:

1. build the Docker image,
2. push it to GHCR with `master` and `sha-<commit>` tags,
3. resolve the immutable image digest,
4. copy `compose.yaml` and `deploy/remote-deploy.sh` to each VM,
5. tell each VM to pull that digest and restart the app,
6. wait for `/api/health`.

### 6. Verify production

After a deploy:

1. Open the GitHub Actions run and confirm every target passed.
2. Hit the public site or the VM-local health endpoint.
3. If you use a reverse proxy, verify the public domain and WebSocket path both work.

## Rollback

The workflow also supports manual deploys via `workflow_dispatch` with an `image_ref` input. That is your rollback mechanism.

To roll back:

1. Find the old image digest in GHCR or a prior Actions run.
2. Open the `Build And Deploy Production` workflow in GitHub.
3. Click `Run workflow`.
4. Paste the old `ghcr.io/...@sha256:...` image ref into `image_ref`.
5. Run the workflow.

That redeploys the previous artifact without rebuilding anything.

## Reverse proxy and TLS

The app container should usually stay bound to `127.0.0.1:3011`. Put nginx, Caddy, or Traefik in front of it for:

1. HTTPS certificates,
2. `80/443` public exposure,
3. WebSocket proxying,
4. headers and rate limiting.

The existing nginx example in `deploy/nginx/jarvis.whoisdhruv.com.conf` is still the starting point for that layer.

## If you insist on VM-side git pull

For non-production machines or a dedicated source checkout, `npm run deploy:sync-up` now does a safe fast-forward to `origin/master` and then deploys locally.

That is acceptable for a dev box or a one-off internal VM. It is not the preferred production model because production should deploy a pinned image, not rebuild from whatever the VM has locally.

## Linux bare-metal path

`deploy/deploy.sh` still exists for the older Linux-only model where the repo also manages systemd, nginx, and certbot. Keep using it only if you explicitly want host provisioning from the repo itself.
