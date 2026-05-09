#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'deploy', 'system.env.local');
const FALLBACK_CONFIG_PATH = path.join(ROOT, 'deploy', 'system.env');
const EXAMPLE_CONFIG_PATH = path.join(ROOT, 'deploy', 'system.env.example');
const COMPOSE_FILE_PATH = path.join(ROOT, 'compose.yaml');
const VALID_COMMANDS = new Set(['up', 'down', 'restart', 'logs', 'ps', 'health', 'doctor', 'sync-master', 'sync-up']);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function info(message) {
  process.stdout.write(`${message}\n`);
}

function repoRelative(targetPath) {
  const relative = path.relative(ROOT, targetPath);
  return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : targetPath;
}

function printHelp() {
  info('Usage: node deploy/deploy.mjs [command] [--config path]');
  info('');
  info('Commands:');
  info('  up       Build and start the container, then wait for /api/health.');
  info('  down     Stop and remove the container stack.');
  info('  restart  Rebuild and recreate the container stack.');
  info('  logs     Follow container logs.');
  info('  ps       Show compose service status.');
  info('  health   Check the published /api/health endpoint once.');
  info('  doctor   Validate deploy config and print the resolved settings.');
  info('  sync-master  Fast-forward the local checkout to origin/master.');
  info('  sync-up      Fast-forward to origin/master, then deploy.');
  info('');
  info(`Default config path: ${repoRelative(DEFAULT_CONFIG_PATH)}`);
}

function parseArgs(argv) {
  const positional = [];
  let configPath = '';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      const nextValue = argv[index + 1];
      if (!nextValue) fail('Missing value for --config.');
      configPath = nextValue;
      index += 1;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }
    if (arg.startsWith('-')) {
      fail(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    fail(`Only one command is allowed. Received: ${positional.join(' ')}`);
  }

  const command = positional[0] || 'up';
  if (!VALID_COMMANDS.has(command)) {
    fail(`Unknown command: ${command}`);
  }

  return { command, configPath };
}

function parseEnvFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalsIndex = rawLine.indexOf('=');
    if (equalsIndex === -1) continue;
    const key = rawLine.slice(0, equalsIndex).trim();
    if (!key) continue;
    let value = rawLine.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function toPositiveInt(rawValue, fallback, label) {
  if (rawValue == null || rawValue === '') return fallback;
  const numeric = Number(rawValue);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    fail(`${label} must be a positive integer. Received: ${rawValue}`);
  }
  return numeric;
}

function ensureLeadingSlash(value, fallback) {
  const candidate = String(value || fallback || '/').trim();
  return candidate.startsWith('/') ? candidate : `/${candidate}`;
}

function resolveConfigPath(explicitPath) {
  if (explicitPath) return path.resolve(process.cwd(), explicitPath);
  if (fs.existsSync(DEFAULT_CONFIG_PATH)) return DEFAULT_CONFIG_PATH;
  if (fs.existsSync(FALLBACK_CONFIG_PATH)) return FALLBACK_CONFIG_PATH;
  return DEFAULT_CONFIG_PATH;
}

function resolveEnvPath(rawPath) {
  if (!rawPath) return path.join(ROOT, '.env');
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(ROOT, rawPath);
}

function runCommand(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    stdio: options.stdio || 'inherit',
    encoding: options.encoding || 'utf8'
  });
  if (result.error) {
    fail(`Failed to run ${executable}: ${result.error.message}`);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
  return result;
}

function ensureCleanGitWorktree() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    fail('sync-master requires running inside a git checkout.');
  }

  const diffFiles = spawnSync('git', ['status', '--porcelain'], {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8'
  });
  if (diffFiles.error) {
    fail(`Failed to inspect git worktree: ${diffFiles.error.message}`);
  }
  if (diffFiles.status !== 0) {
    process.exit(diffFiles.status);
  }
  if (String(diffFiles.stdout || '').trim().length > 0) {
    fail('sync-master refuses to run with local changes present. Commit or stash them first.');
  }
}

function syncMasterBranch() {
  ensureCleanGitWorktree();
  info('Syncing local checkout to origin/master ...');
  runCommand('git', ['fetch', '--prune', 'origin', 'master']);
  runCommand('git', ['checkout', 'master']);
  runCommand('git', ['pull', '--ff-only', 'origin', 'master']);
}

function validateConfig(resolvedConfigPath, options = {}) {
  const needsAppEnvFile = options.needsAppEnvFile !== false;
  const needsRuntimeSecrets = options.needsRuntimeSecrets === true;

  if (!fs.existsSync(COMPOSE_FILE_PATH)) {
    fail(`Missing compose file: ${repoRelative(COMPOSE_FILE_PATH)}`);
  }
  if (!fs.existsSync(resolvedConfigPath)) {
    fail(
      `Missing deployment config: ${repoRelative(resolvedConfigPath)}\n` +
      `Copy ${repoRelative(EXAMPLE_CONFIG_PATH)} to ${repoRelative(DEFAULT_CONFIG_PATH)} and edit it first.`
    );
  }

  const deployEnv = parseEnvFile(resolvedConfigPath);
  const appEnvPath = resolveEnvPath(deployEnv.APP_ENV_FILE || '.env');
  if (needsAppEnvFile && !fs.existsSync(appEnvPath)) {
    fail(`Missing app env file: ${repoRelative(appEnvPath)}`);
  }

  const appEnv = fs.existsSync(appEnvPath) ? parseEnvFile(appEnvPath) : {};
  const hostBind = deployEnv.HOST_BIND || '127.0.0.1';
  const containerPort = toPositiveInt(deployEnv.CONTAINER_PORT, 3011, 'CONTAINER_PORT');
  const hostPort = toPositiveInt(deployEnv.HOST_PORT, containerPort, 'HOST_PORT');
  const healthProtocol = deployEnv.HEALTHCHECK_PROTOCOL || 'http';
  const healthHost = deployEnv.HEALTHCHECK_HOST || '127.0.0.1';
  const healthPort = toPositiveInt(deployEnv.HEALTHCHECK_PORT, hostPort, 'HEALTHCHECK_PORT');
  const healthPath = ensureLeadingSlash(deployEnv.HEALTHCHECK_PATH, '/api/health');
  const healthTimeoutMs = toPositiveInt(deployEnv.HEALTHCHECK_TIMEOUT_MS, 60000, 'HEALTHCHECK_TIMEOUT_MS');
  const composeProjectName = deployEnv.COMPOSE_PROJECT_NAME || 'freightops';
  const imageName = deployEnv.IMAGE_NAME || 'dhruv-freightops:latest';
  const imageRef = (deployEnv.IMAGE_REF || process.env.IMAGE_REF || '').trim();
  const geminiApiKey = appEnv.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
  const wsNonceSecret = appEnv.WS_NONCE_SECRET || process.env.WS_NONCE_SECRET || '';
  const allowedOrigins = (appEnv.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS || '').trim();
  const defaultLocalOrigins = `http://localhost:${hostPort},http://127.0.0.1:${hostPort}`;

  if (needsRuntimeSecrets) {
    if (!geminiApiKey || /your_gemini_api_key_here/i.test(geminiApiKey)) {
      fail(`GEMINI_API_KEY must be set in ${repoRelative(appEnvPath)} before deploying.`);
    }
    if (wsNonceSecret.length < 16) {
      fail(`WS_NONCE_SECRET must be set to at least 16 characters in ${repoRelative(appEnvPath)} for production deployments.`);
    }
    if (!allowedOrigins) {
      fail(
        `ALLOWED_ORIGINS must be set in ${repoRelative(appEnvPath)} for production/container deployments.\n` +
        `For a local-only deployment, use: ${defaultLocalOrigins}`
      );
    }
  }

  if (appEnv.PORT && Number(appEnv.PORT) !== containerPort) {
    info(`Warning: ${repoRelative(appEnvPath)} sets PORT=${appEnv.PORT}; compose will override it to ${containerPort}.`);
  }

  const composedAppEnvPath = repoRelative(appEnvPath);
  const healthUrl = `${healthProtocol}://${healthHost}:${healthPort}${healthPath}`;

  return {
    appEnvPath,
    commandEnv: {
      ...process.env,
      ...deployEnv,
      APP_ENV_FILE: composedAppEnvPath,
      COMPOSE_PROJECT_NAME: composeProjectName,
      IMAGE_REF: imageRef,
      CONTAINER_PORT: String(containerPort),
      HOST_BIND: hostBind,
      HOST_PORT: String(hostPort),
      IMAGE_NAME: imageName
    },
    composeProjectName,
    containerPort,
    healthTimeoutMs,
    healthUrl,
    hostBind,
    hostPort,
    imageRef,
    imageName,
    resolvedConfigPath
  };
}

function detectComposeTool() {
  const plugin = spawnSync('docker', ['compose', 'version'], { stdio: 'pipe', encoding: 'utf8' });
  if (plugin.status === 0) {
    return { executable: 'docker', prefix: ['compose'] };
  }

  const standalone = spawnSync('docker-compose', ['version'], { stdio: 'pipe', encoding: 'utf8' });
  if (standalone.status === 0) {
    return { executable: 'docker-compose', prefix: [] };
  }

  fail('Docker Compose was not found. Install Docker Desktop or Docker Engine with the compose plugin first.');
}

function runCompose(ctx, composeTool, args) {
  const commandArgs = [
    ...composeTool.prefix,
    '--env-file',
    ctx.resolvedConfigPath,
    '-f',
    COMPOSE_FILE_PATH,
    ...args
  ];
  const result = spawnSync(composeTool.executable, commandArgs, {
    cwd: ROOT,
    env: ctx.commandEnv,
    stdio: 'inherit'
  });
  if (result.error) {
    fail(`Failed to run Docker Compose: ${result.error.message}`);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}

function deployUp(ctx, composeTool, { forceRecreate = false } = {}) {
  const useRemoteImage = Boolean(ctx.imageRef);
  if (useRemoteImage) {
    runCompose(ctx, composeTool, ['pull', 'app']);
    const upArgs = ['up', '-d', '--remove-orphans'];
    if (forceRecreate) upArgs.push('--force-recreate');
    upArgs.push('app');
    runCompose(ctx, composeTool, upArgs);
    return;
  }

  const upArgs = ['up', '-d', '--build', '--remove-orphans'];
  if (forceRecreate) upArgs.push('--force-recreate');
  runCompose(ctx, composeTool, upArgs);
}

async function fetchHealth(url) {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fetchHealth(url);
    if (result.ok) {
      info(`Health OK: ${url}`);
      if (result.body) info(result.body);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  fail(`Timed out waiting for health at ${url}`);
}

async function checkHealthOnce(url) {
  const result = await fetchHealth(url);
  if (!result.ok) {
    const details = result.error ? ` (${result.error})` : result.status ? ` (status ${result.status})` : '';
    fail(`Health check failed for ${url}${details}`);
  }
  info(`Health OK: ${url}`);
  if (result.body) info(result.body);
}

function printDoctorSummary(ctx) {
  info('Deployment summary');
  info(`  deploy config:    ${repoRelative(ctx.resolvedConfigPath)}`);
  info(`  app env:          ${repoRelative(ctx.appEnvPath)}`);
  info(`  compose project:  ${ctx.composeProjectName}`);
  info(`  image:            ${ctx.imageName}`);
  info(`  publish:          ${ctx.hostBind}:${ctx.hostPort} -> ${ctx.containerPort}`);
  info(`  health:           ${ctx.healthUrl}`);
}

const { command, configPath } = parseArgs(process.argv.slice(2));
if (command === 'sync-master') {
  syncMasterBranch();
  process.exit(0);
}

if (command === 'sync-up') {
  syncMasterBranch();
}

const resolvedConfigPath = resolveConfigPath(configPath);
const ctx = validateConfig(resolvedConfigPath, {
  needsAppEnvFile: command !== 'health',
  needsRuntimeSecrets: command === 'up' || command === 'restart' || command === 'doctor' || command === 'sync-up'
});

if (command === 'doctor') {
  printDoctorSummary(ctx);
  process.exit(0);
}

if (command === 'health') {
  await checkHealthOnce(ctx.healthUrl);
  process.exit(0);
}

const composeTool = detectComposeTool();

switch (command) {
  case 'up':
  case 'sync-up':
    deployUp(ctx, composeTool);
    await waitForHealth(ctx.healthUrl, ctx.healthTimeoutMs);
    break;
  case 'down':
    runCompose(ctx, composeTool, ['down', '--remove-orphans']);
    break;
  case 'restart':
    deployUp(ctx, composeTool, { forceRecreate: true });
    await waitForHealth(ctx.healthUrl, ctx.healthTimeoutMs);
    break;
  case 'logs':
    runCompose(ctx, composeTool, ['logs', '--follow', '--tail', '200']);
    break;
  case 'ps':
    runCompose(ctx, composeTool, ['ps']);
    break;
  default:
    fail(`Unhandled command: ${command}`);
}