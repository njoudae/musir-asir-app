const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const envPath = path.join(__dirname, '..', '.env.local');
const source = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const entries = new Map();

for (const line of source.split(/\r?\n/)) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (match) entries.set(match[1], match[2]);
}

const serviceSecret = entries.get('MUSIR_SERVICE_SECRET') || crypto.randomBytes(32).toString('base64url');
const appSecret = entries.get('APP_SECRET') || crypto.randomBytes(32).toString('base64url');
entries.set('MUSIR_SERVICE_SECRET', serviceSecret);
entries.set('APP_SECRET', appSecret);
entries.set('DATA_PROVIDER', 'convex');

const preservedComments = source.split(/\r?\n/).filter((line) => line.trim().startsWith('#'));
const output = [...preservedComments, ...[...entries].map(([key, value]) => `${key}=${value}`), ''].join('\n');
fs.writeFileSync(envPath, output, { encoding: 'utf8', mode: 0o600 });

const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(executable, ['convex', 'env', 'set', 'MUSIR_SERVICE_SECRET', serviceSecret], {
  cwd: path.join(__dirname, '..'),
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || 'Unable to configure Convex secret.');
  process.exit(result.status || 1);
}

process.stdout.write('Convex service credentials configured without printing secret values.\n');
