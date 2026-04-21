'use strict';

/**
 * Cross-platform `NODE_ENV=production node server.js` without needing
 * `cross-env`. The `env` argument merges with our override and is
 * passed straight to the child process. `stdio: 'inherit'` so the child
 * replaces our terminal session.
 */

const path = require('path');
const { spawn } = require('child_process');

const serverPath = path.resolve(__dirname, '..', 'server.js');
const env = { ...process.env, NODE_ENV: 'production' };

const child = spawn(process.execPath, [serverPath], {
  env,
  stdio: 'inherit'
});

child.on('exit', (code) => process.exit(code || 0));

function forward(sig) {
  return () => { try { child.kill(sig); } catch {} };
}
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));
