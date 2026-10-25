'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const cli = path.join(__dirname, '..', 'bin', 'code-team.js');

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

// The CLI runs against its own home and a closed gateway port, so nothing reaches a real gateway.
async function cliHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'code-team-cli-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const closedPort = String(await freePort());
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CODEX_GATEWAY_') || /_API_KEY$/.test(key)) delete env[key];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_GATEWAY_PORT: closedPort, CODEX_GATEWAY_WORKER_PORT: closedPort, CODEX_GATEWAY_PROXY_PORT: closedPort,
    CODEX_GATEWAY_CLAUDE_BIN: path.join(home, 'no-claude'), CODEX_GATEWAY_GROK_HOME: path.join(home, '.grok'),
    HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '*',
  });
  const providersFile = path.join(home, '.claude', 'code-team', 'providers.json');
  const run = (args, { input = '', extraEnv = {} } = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: home, env: { ...env, ...extraEnv }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
  const providers = () => (fs.existsSync(providersFile) ? JSON.parse(fs.readFileSync(providersFile, 'utf8')) : null);
  return { home, run, providers, providersFile };
}

async function fakeProvider(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers });
      handler(req, res, Buffer.concat(chunks).toString());
    });
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => server.close());
  return { port, seen, baseUrl: `http://127.0.0.1:${port}` };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('provider add --custom, list, test and remove against a local endpoint', async (t) => {
  const { run, providers } = await cliHome(t);
  const fake = await fakeProvider(t, (req, res) => {
    if (req.headers['x-api-key'] !== 'right-key') return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'bad key right-key? no' } });
    if (req.url === '/v1/models') return json(res, 200, { data: [{ id: 'local-big' }, { id: 'local-small' }] });
    return json(res, 404, {});
  });

  const added = await run(['provider', 'add', '--custom', '--id', 'local', '--name', 'Local', '--base-url', fake.baseUrl,
    '--api-key-stdin', '--model', 'local-big:400000', '--header', 'X-Team: blue'], { input: 'right-key\n' });
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /added provider local \(Local\)/);
  assert.match(added.stdout, /key from providers\.json/);
  assert.match(added.stdout, /picker ids: claude-local-local-big\[1m\]/);
  assert.doesNotMatch(added.stdout + added.stderr, /right-key/);
  assert.deepEqual(providers(), [{
    id: 'local', name: 'Local', baseUrl: fake.baseUrl, headers: { 'X-Team': 'blue' },
    models: [{ id: 'local-big', contextWindow: 400000 }], apiKey: 'right-key',
  }]);

  const again = await run(['provider', 'add', '--custom', '--id', 'local', '--name', 'Local', '--base-url', fake.baseUrl, '--api-key-stdin', '--model', 'local-big:400000', '--header', 'X-Team: blue'], { input: 'right-key' });
  assert.match(again.stdout, /updated provider local/);
  assert.equal(providers().length, 1);

  const listed = await run(['provider', 'list', '--json']);
  assert.equal(listed.status, 0);
  const listing = JSON.parse(listed.stdout);
  assert.equal(listing.providers[0].id, 'local');
  assert.doesNotMatch(listed.stdout, /right-key/);

  const tested = await run(['provider', 'test', 'local']);
  assert.equal(tested.status, 0, tested.stdout + tested.stderr);
  assert.match(tested.stdout, /local: OK: 2 models listed/);
  assert.equal(fake.seen.at(-1).headers['x-team'], 'blue');

  const removed = await run(['provider', 'remove', 'local']);
  assert.equal(removed.status, 0);
  assert.match(removed.stdout, /removed provider local/);
  assert.deepEqual(providers(), []);
  assert.match((await run(['provider', 'remove', 'local'])).stdout, /nothing to remove/);
  const unknown = await run(['provider', 'test', 'local']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no provider local/);
});
test('provider test reports a refused key and spends no tokens without --live', async (t) => {
  const { run } = await cliHome(t);
  const fake = await fakeProvider(t, (req, res) => {
    if (req.url === '/v1/models') return json(res, 404, { error: { message: 'no list here' } });
    if (req.url === '/v1/messages/count_tokens') {
      return req.headers.authorization === 'Bearer good' ? json(res, 200, { input_tokens: 3 }) : json(res, 401, { error: { message: 'invalid key' } });
    }
    return json(res, 500, {});
  });
  await run(['provider', 'add', '--custom', '--id', 'counted', '--base-url', fake.baseUrl, '--auth-style', 'bearer', '--api-key-env', 'COUNTED_KEY', '--model', 'c1']);
  const good = await run(['provider', 'test', 'counted', '--json'], { extraEnv: { COUNTED_KEY: 'good' } });
  assert.equal(good.status, 0);
  assert.deepEqual(JSON.parse(good.stdout), { id: 'counted', ok: true, reachable: true, auth: 'ok', models: null, detail: 'key accepted (count_tokens)' });
  const bad = await run(['provider', 'test', 'counted'], { extraEnv: { COUNTED_KEY: 'wrong' } });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /counted: FAILED: the provider refused the key \(HTTP 401\): invalid key/);
  const unset = await run(['provider', 'test', 'counted']);
  assert.equal(unset.status, 1);
  assert.match(unset.stdout, /no API key for counted: set COUNTED_KEY/);
  assert.equal(fake.seen.some((entry) => entry.url === '/v1/messages'), false, 'no tokens were spent');

  const closed = await freePort();
  await run(['provider', 'add', '--custom', '--id', 'gone', '--base-url', `http://127.0.0.1:${closed}`, '--model', 'g']);
  const down = await run(['provider', 'test', 'gone']);
  assert.equal(down.status, 1);
  assert.match(down.stdout, /gone: FAILED: not answering at http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\)/);
});

test('presets add without network, and the Antigravity preset needs explicit acceptance', async (t) => {
  const { run, providers } = await cliHome(t);
  const deepseek = await run(['provider', 'add', 'deepseek'], { extraEnv: { DEEPSEEK_API_KEY: 'sk-test' } });
  assert.equal(deepseek.status, 0, deepseek.stderr);
  assert.match(deepseek.stdout, /added provider deepseek \(DeepSeek\) at https:\/\/api\.deepseek\.com\/anthropic; key from env DEEPSEEK_API_KEY/);
  assert.equal(providers()[0].apiKey, undefined, 'an environment key is never written to disk');

  const refused = await run(['provider', 'add', 'antigravity']);
  assert.equal(refused.status, 3);
  assert.match(refused.stdout, /violates Google's terms of service/);
  assert.match(refused.stderr, /--accept-google-terms/);
  assert.deepEqual(providers().map((provider) => provider.id), ['deepseek']);

  const accepted = await run(['provider', 'add', 'antigravity', '--accept-google-terms']);
  assert.equal(accepted.status, 0, accepted.stderr);
  const agy = providers().find((provider) => provider.id === 'agy');
  assert.equal(agy.baseUrl, 'http://127.0.0.1:8317');
  assert.equal(agy.ownedBy, 'antigravity');
  assert.match(agy.termsAccepted.google.acceptedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(agy.termsAccepted.google.via, 'flag');

  const kept = await run(['provider', 'add', 'antigravity']);
  assert.equal(kept.status, 0);
  assert.match(kept.stdout, /Acceptance already recorded on/);
  assert.equal(providers().find((provider) => provider.id === 'agy').termsAccepted.google.acceptedAt, agy.termsAccepted.google.acceptedAt);

  const reserved = await run(['provider', 'add', '--custom', '--id', 'claude', '--base-url', 'https://example.test', '--model', 'x']);
  assert.equal(reserved.status, 1);
  assert.match(reserved.stderr, /id is reserved/);
  const usage = await run(['provider', 'add']);
  assert.equal(usage.status, 2);
});

test('connect asks for a key before touching providers.json, and disconnect reverses a connection', async (t) => {
  const { run, providers, home } = await cliHome(t);
  const needKey = await run(['connect', 'kimi']);
  assert.equal(needKey.status, 3);
  assert.match(needKey.stdout, /Kimi needs an API key/);
  assert.match(needKey.stdout, /set MOONSHOT_API_KEY/);
  assert.equal(providers(), null);

  const unknown = await run(['connect', 'nowhere']);
  assert.equal(unknown.status, 2);

  const listing = await run(['connect']);
  assert.equal(listing.status, 0);
  for (const name of ['gpt', 'grok', 'antigravity', 'deepseek', 'kimi', 'glm', 'minimax', 'openrouter']) assert.match(listing.stdout, new RegExp(`\\b${name}\\b`));
  assert.match(listing.stdout, /Gateway: not running/);

  const grok = await run(['connect', 'grok']);
  assert.equal(grok.status, 3);
  assert.match(grok.stdout, /Run `grok` in a terminal/);

  const disconnected = await run(['disconnect', 'grok']);
  assert.equal(disconnected.status, 0);
  const connections = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'code-team', 'connections.json'), 'utf8'));
  assert.equal(connections.grok.disabled, true);
  assert.match((await run(['connect'])).stdout, /grok\s+Grok\s+disconnected/);
});
