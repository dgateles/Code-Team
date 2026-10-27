'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CLI = path.join(__dirname, '..', 'bin', 'code-team.js');
const { baseUrlFromEnvironText } = require('../lib/settings-wiring.js');

function isolatedEnv(home) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CODEX_GATEWAY_') || key === 'ANTHROPIC_BASE_URL') delete env[key];
  return { ...env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_GATEWAY_PORT: '9', CODEX_GATEWAY_WORKER_PORT: '9', CODEX_GATEWAY_PROXY_PORT: '9' };
}

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-team-host-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('baseUrlFromEnvironText reads /proc environ and ps -E output', () => {
  assert.equal(baseUrlFromEnvironText('HOME=/x\0ANTHROPIC_BASE_URL=http://localhost:8787\0PATH=/bin'), 'http://localhost:8787');
  assert.equal(baseUrlFromEnvironText('claude --flag HOME=/x ANTHROPIC_BASE_URL=http://127.0.0.1:18774 PATH=/bin'), 'http://127.0.0.1:18774');
  assert.equal(baseUrlFromEnvironText('X_ANTHROPIC_BASE_URL=nope HOME=/x'), undefined);
});

test('effectiveBaseUrl inside a session uses the Claude Code process environment, not the tool subprocess', { skip: process.platform === 'win32' }, async (t) => {
  const dir = home(t);
  const host = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { env: { ...isolatedEnv(dir), ANTHROPIC_BASE_URL: 'http://host-process:1' }, stdio: 'ignore' });
  t.after(() => host.kill());
  await new Promise((resolve) => setTimeout(resolve, 200));
  const read = (extra) => JSON.parse(spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require(process.argv[1]).effectiveBaseUrl()))', path.join(__dirname, '..', 'lib', 'settings-wiring.js')], {
    encoding: 'utf8', cwd: dir, env: { ...isolatedEnv(dir), ANTHROPIC_BASE_URL: 'http://tool-subprocess:2', ...extra },
  }).stdout);
  assert.equal(read({}).value, 'http://tool-subprocess:2', 'plain shell: own environment');
  const inSession = read({ CLAUDECODE: '1', CLAUDE_PID: String(host.pid) });
  assert.equal(inSession.value, 'http://host-process:1');
  assert.equal(inSession.pid, host.pid);
});

test('upstream set/show/reset persist the Anthropic upstream and runtime reads it', (t) => {
  const dir = home(t);
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: dir, env: isolatedEnv(dir), timeout: 20000 });
  const runtimeUpstream = (extra = {}) => spawnSync(process.execPath, ['-p', `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'runtime.js'))}).ANTHROPIC_UPSTREAM`], { encoding: 'utf8', env: { ...isolatedEnv(dir), ...extra } }).stdout.trim();
  assert.equal(run('upstream', 'set', 'not-a-url').status, 2);
  assert.equal(run('upstream', 'set', 'http://localhost:8787').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'code-team', 'upstream.json'), 'utf8')), { anthropic: 'http://localhost:8787' });
  assert.match(run('upstream', 'show').stdout, /anthropic upstream: http:\/\/localhost:8787 \(.*upstream\.json\)/);
  assert.equal(runtimeUpstream(), 'http://localhost:8787');
  assert.equal(runtimeUpstream({ CODEX_GATEWAY_ANTHROPIC_UPSTREAM: 'http://env:1' }), 'http://env:1', 'the env var still overrides');
  assert.equal(run('upstream', 'reset').status, 0);
  assert.equal(runtimeUpstream(), 'https://api.anthropic.com');
});

test('login --reset ends a leftover sign-in process recorded in codex-login.pid', { skip: process.platform === 'win32' }, async (t) => {
  const dir = home(t);
  const leftover = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => { try { leftover.kill(); } catch {} });
  fs.mkdirSync(path.join(dir, '.claude', 'code-team'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'code-team', 'codex-login.pid'), String(leftover.pid));
  const result = spawnSync(process.execPath, [CLI, 'login', '--reset'], { encoding: 'utf8', cwd: dir, env: isolatedEnv(dir), timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`stopped the pending ChatGPT sign-in \\(PID ${leftover.pid}\\)`));
  await new Promise((resolve) => leftover.once('exit', resolve));
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'code-team', 'codex-login.pid')), false);
});

test('login --start prints and saves the sign-in link; login --wait follows the detached sign-in', { skip: process.platform === 'win32' }, (t) => {
  const dir = home(t);
  const binDir = path.join(dir, '.claude', 'code-team', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'claude-code-proxy'), [
    '#!/bin/sh',
    'if [ "$3" = "status" ]; then echo "Logged in as account test"; exit 0; fi',
    'echo "Open this URL to sign in: https://auth.openai.com/authorize?state=abc"',
    'sleep 1',
  ].join('\n'), { mode: 0o755 });
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: dir, env: isolatedEnv(dir), timeout: 20000 });
  const started = run('login', '--start');
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /Sign-in link \(also saved at .*login-url\.txt\):\n {2}https:\/\/auth\.openai\.com\/authorize\?state=abc/);
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'code-team', 'logs', 'login-url.txt'), 'utf8').trim(), 'https://auth.openai.com/authorize?state=abc');
  const waited = run('login', '--wait');
  assert.equal(waited.status, 0, waited.stderr + waited.stdout);
  assert.match(waited.stdout, /signed in/);
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'code-team', 'codex-login.pid')), false);
});

test('untilModelsListed retries an empty model list and stops at the first listed one', async () => {
  const { untilModelsListed } = require('../lib/provider-commands.js');
  const results = [{ ok: false, models: 0 }, { ok: false, models: 0 }, { ok: true, models: 9 }];
  let calls = 0;
  const waits = [];
  const result = await untilModelsListed(() => results[calls++], { attempts: 5, delayMs: 7, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(result, { ok: true, models: 9 });
  assert.deepEqual(waits, [7, 7]);
  calls = 0;
  const unreachable = await untilModelsListed(() => { calls++; return { ok: false, models: null }; }, { attempts: 5, sleep: async () => {} });
  assert.equal(calls, 1, 'an unreachable provider is not retried here');
  calls = 0;
  await untilModelsListed(() => { calls++; return { ok: false, models: 0 }; }, { attempts: 5, sleep: async () => {} });
  assert.equal(calls, 5);
  assert.equal(unreachable.models, null);
});
