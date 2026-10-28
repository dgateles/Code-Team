'use strict';

// A Code Team-managed CLIProxyAPI (https://github.com/router-for-me/CLIProxyAPI) for the Antigravity
// connection: release download with checksum verification, a loopback-only config with its own client
// key, the `-antigravity-login` browser OAuth flow, and a detached start. Google tokens stay in
// CLIProxyAPI's own auth directory; Code Team never reads them.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeFileAtomically } = require('./atomic-file.js');
const { downloadArchiveVerifiedByList } = require('./release-verification.js');

const WIN = process.platform === 'win32';
const REPO = 'router-for-me/CLIProxyAPI';
const STATE = path.join(os.homedir(), '.claude', 'code-team');
const DIR = path.join(STATE, 'cliproxyapi');
const BINARY = path.join(DIR, WIN ? 'cli-proxy-api.exe' : 'cli-proxy-api');
const CONFIG = path.join(DIR, 'config.yaml');
const CONNECTION = path.join(DIR, 'connection.json');
const AUTH_DIR = path.join(DIR, 'auths');
const LOG = path.join(STATE, 'logs', 'cliproxyapi.log');
// Not 8317: a CLIProxyAPI the user already runs keeps its own port.
const MANAGED_PORT = Number(process.env.CODE_TEAM_CLIPROXYAPI_PORT || 18776);

function assetName(version, { platform = process.platform, arch = process.arch } = {}) {
  const plat = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
  const cpu = arch === 'arm64' ? 'aarch64' : 'amd64';
  return `CLIProxyAPI_${version}_${plat}_${cpu}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
}

function quoteYaml(value) {
  return JSON.stringify(String(value));
}

function configText({ port, apiKey, authDir }) {
  return [
    '# Written by Code Team for the Antigravity connection. Loopback only; management API disabled.',
    'config-version: 8',
    'server:',
    `  host: ${quoteYaml('127.0.0.1')}`,
    `  port: ${port}`,
    'management:',
    '  allow-remote: false',
    `  secret-key: ${quoteYaml('')}`,
    'access:',
    '  api-keys:',
    `    - ${quoteYaml(apiKey)}`,
    'oauth:',
    `  auth-dir: ${quoteYaml(authDir.replace(/\\/g, '/'))}`,
    // One Google login, so a cooldown has no other credential to fail over to. Stock CLIProxyAPI cools the
    // whole credential after any 429, including a weekly "Individual quota reached" on one quota group, and
    // then answers every model with "cooling down" for days while the Antigravity usage page shows 100%
    // (router-for-me/CLIProxyAPI#5843). Google answers per quota group itself, so let every request through.
    'routing:',
    '  cooldown:',
    '    disable-cooling: true',
    '',
  ].join('\n');
}

function readConnection(file = CONNECTION) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed?.apiKey === 'string' && typeof parsed?.baseUrl === 'string' ? parsed : null;
  } catch { return null; }
}

// Idempotent: an existing key is kept so a running proxy and the gateway stay in agreement.
function writeManagedConfig({ port = MANAGED_PORT } = {}) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const existing = readConnection();
  const apiKey = existing?.apiKey || crypto.randomBytes(24).toString('hex');
  const baseUrl = `http://127.0.0.1:${port}`;
  writeFileAtomically(CONFIG, configText({ port, apiKey, authDir: AUTH_DIR }), { mode: 0o600 });
  writeFileAtomically(CONNECTION, JSON.stringify({ baseUrl, apiKey }, null, 2) + '\n', { mode: 0o600 });
  return { baseUrl, connectionFile: CONNECTION, config: CONFIG };
}

function installed() {
  return fs.existsSync(BINARY);
}

async function install({ fetchUrl, log = () => {} }) {
  const response = await fetchUrl(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (response.status !== 200) throw new Error(`GitHub API returned ${response.status} for ${REPO}`);
  const release = JSON.parse(response.body.toString());
  const version = String(release.tag_name || '').replace(/^v/, '');
  const name = assetName(version);
  const archive = await downloadArchiveVerifiedByList(release, name, { fetchUrl, log });
  fs.mkdirSync(DIR, { recursive: true });
  const stage = fs.mkdtempSync(path.join(DIR, 'stage-'));
  try {
    const archiveFile = path.join(stage, name);
    fs.writeFileSync(archiveFile, archive);
    const tar = WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const extracted = spawnSync(tar, ['-xf', archiveFile], { cwd: stage, encoding: 'utf8', windowsHide: true });
    if (extracted.status !== 0) throw new Error(`extract failed: ${extracted.stderr || extracted.status}`);
    const binary = fs.readdirSync(stage, { recursive: true }).map(String).find((file) => path.basename(file) === path.basename(BINARY));
    if (!binary) throw new Error(`${path.basename(BINARY)} not found in ${name}`);
    fs.rmSync(BINARY, { force: true });
    fs.renameSync(path.join(stage, binary), BINARY);
    if (!WIN) fs.chmodSync(BINARY, 0o755);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  log(`installed CLIProxyAPI ${release.tag_name} at ${BINARY}`);
  return { version: release.tag_name, binary: BINARY };
}

// CLIProxyAPI names Antigravity credential files after the provider; the type field is the fallback.
function hasAntigravityLogin(authDir = AUTH_DIR) {
  let files;
  try { files = fs.readdirSync(authDir); } catch { return false; }
  return files.some((file) => {
    if (!file.endsWith('.json')) return false;
    if (/antigravity/i.test(file)) return true;
    try { return JSON.parse(fs.readFileSync(path.join(authDir, file), 'utf8'))?.type === 'antigravity'; } catch { return false; }
  });
}

// Interactive: opens the browser (or prints the URL with noBrowser) and waits for the OAuth callback.
function login({ noBrowser = false, spawn = spawnSync } = {}) {
  const args = ['-config', CONFIG, '-antigravity-login', ...(noBrowser ? ['-no-browser'] : [])];
  const result = spawn(BINARY, args, { stdio: 'inherit', windowsHide: false });
  return { ok: result.status === 0, status: result.status };
}

function autostartEntry() {
  return { command: BINARY, args: ['-config', CONFIG], cwd: DIR };
}

// The CLI runs inside a hook or a terminal whose job cleanup would kill a plain child on Windows.
function launch() {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  if (WIN) {
    const { spawnWindowsDetached } = require('./windows-detached.js');
    return spawnWindowsDetached(BINARY, ['-config', CONFIG], { env: process.env, logPath: LOG, state: STATE });
  }
  const out = fs.openSync(LOG, 'a');
  try {
    const child = require('node:child_process').spawn(BINARY, ['-config', CONFIG], { cwd: DIR, detached: true, stdio: ['ignore', out, out] });
    child.once('error', () => {});
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(out);
  }
}

module.exports = {
  AUTH_DIR, BINARY, CONFIG, CONNECTION, DIR, LOG, MANAGED_PORT, REPO,
  assetName, autostartEntry, configText, hasAntigravityLogin, install, installed, launch, login, readConnection, writeManagedConfig,
};
