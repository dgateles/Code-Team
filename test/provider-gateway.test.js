'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnGatewayProcess } = require('./support.js');

const cli = path.join(__dirname, '..', 'bin', 'code-team.js');

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function request(port, { method = 'POST', path: urlPath = '/v1/messages', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// A fake Anthropic-compatible provider that records what reaches it.
async function fakeProvider(t, { models = [], messagesStatus = 200 } = {}) {
  const observed = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      observed.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: models }));
      }
      if (req.url === '/v1/messages/count_tokens') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not here');
      }
      if (req.url === '/v1/messages' && body?.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', model: body.model, usage: { input_tokens: 7, output_tokens: 0 } } })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })}\n\n`);
        return res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      }
      res.writeHead(messagesStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(messagesStatus === 200
        ? { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'hi from fake' }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 2 } }
        : { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
    });
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => server.close());
  return { port, observed };
}

async function startWorker(t, providers, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'code-team-provider-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, '.claude', 'code-team');
  fs.mkdirSync(state, { recursive: true });
  if (providers) fs.writeFileSync(path.join(state, 'providers.json'), JSON.stringify(providers));
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const child = spawnGatewayProcess(t, process.execPath, [cli, 'serve-worker'], {
    env: {
      ...process.env, ...env, HOME: home, USERPROFILE: home,
      CODEX_GATEWAY_PORT: String(shimPort), CODEX_GATEWAY_WORKER_PORT: String(shimPort), CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0', CODEX_GATEWAY_SENTRY: '0', CODEX_GATEWAY_GROK_HOME: path.join(home, '.grok'),
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  for (let retry = 0; retry < 200; retry += 1) {
    try {
      const response = await request(shimPort, { method: 'GET', path: '/v1/models' });
      if (response.status === 200) return { port: shimPort, home, state, models: JSON.parse(response.body).data };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('worker did not answer /v1/models');
}

test('provider rows join the picker catalog and requests route by prefix without client credentials', async (t) => {
  const fake = await fakeProvider(t, { models: [
    { id: 'gem-pro', owned_by: 'antigravity' },
    { id: 'other-model', owned_by: 'someone-else' },
  ] });
  const worker = await startWorker(t, [
    { id: 'fake', name: 'Fake', baseUrl: `http://127.0.0.1:${fake.port}`, apiKeyEnv: 'FAKE_PROVIDER_KEY', authStyle: 'both', headers: { 'X-Tenant': 'team-1' }, models: [{ id: 'Fake-Model', contextWindow: 1000000 }] },
    { id: 'listed', name: 'Listed', baseUrl: `http://127.0.0.1:${fake.port}`, modelsFrom: 'list', ownedBy: 'antigravity' },
  ], { FAKE_PROVIDER_KEY: 'provider-secret' });

  const providerRows = worker.models.filter((model) => /^claude-(fake|listed)-/.test(model.id));
  assert.deepEqual(providerRows, [
    { id: 'claude-fake-fake-model[1m]', display_name: 'Fake-Model (Fake)', type: 'model', max_input_tokens: 1000000 },
    { id: 'claude-listed-gem-pro', display_name: 'gem-pro (Listed)', type: 'model', max_input_tokens: 200000 },
  ]);
  // Only providers were connected and claude-code-proxy is not installed: no stand-in GPT rows.
  assert.equal(worker.models.some((model) => model.id.startsWith('claude-gpt-')), false);
  assert.equal(worker.models.some((model) => model.id.startsWith('claude-grok-')), false, 'no Grok rows without a Grok login');

  const sent = { model: 'claude-fake-fake-model[1m]', max_tokens: 16, metadata: { user_id: 'u' }, messages: [{ role: 'user', content: 'hello' }] };
  const response = await request(worker.port, {
    body: sent,
    headers: {
      authorization: 'Bearer claude-ai-oauth-token',
      'x-api-key': 'sk-ant-client-key',
      cookie: 'session=claude',
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'x-claude-code-session-id': 'session-1',
      'proxy-authorization': 'Basic abc',
    },
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).content[0].text, 'hi from fake');
  const forwarded = fake.observed.find((entry) => entry.url === '/v1/messages');
  assert.deepEqual(forwarded.body, { ...sent, model: 'Fake-Model' });
  assert.equal(forwarded.headers['x-api-key'], 'provider-secret');
  assert.equal(forwarded.headers.authorization, 'Bearer provider-secret');
  assert.equal(forwarded.headers['x-tenant'], 'team-1');
  assert.equal(forwarded.headers['anthropic-version'], '2023-06-01');
  for (const header of ['cookie', 'anthropic-beta', 'x-claude-code-session-id', 'proxy-authorization']) {
    assert.equal(forwarded.headers[header], undefined, header);
  }
  assert.doesNotMatch(JSON.stringify(forwarded.headers), /claude-ai-oauth-token|sk-ant-client-key|session=claude/);

  const listedResponse = await request(worker.port, { body: { model: 'claude-listed-gem-pro', max_tokens: 4, stream: true, messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(listedResponse.status, 200);
  assert.match(listedResponse.headers['content-type'], /event-stream/);
  assert.match(listedResponse.body, /message_stop/);
  const listedForward = fake.observed.filter((entry) => entry.url === '/v1/messages').at(-1);
  assert.equal(listedForward.body.model, 'gem-pro');
  assert.equal(listedForward.headers['x-api-key'], undefined);
  assert.equal(listedForward.headers.authorization, undefined);

  const counted = await request(worker.port, { path: '/v1/messages/count_tokens', body: { model: 'claude-fake-fake-model', messages: [{ role: 'user', content: 'hello there' }] } });
  assert.equal(counted.status, 200);
  assert.equal(counted.headers['x-code-team-estimate'], '1');
  assert.ok(JSON.parse(counted.body).input_tokens > 0);

  const health = JSON.parse((await request(worker.port, { method: 'GET', path: '/healthz' })).body);
  assert.deepEqual(health.providers, [{ id: 'fake', keyPresent: true }, { id: 'listed', keyPresent: false }]);
  assert.equal(health.served.providers, 3);
  assert.equal(health.catalog, 'none');
});

test('a provider that is down or has no key answers with a clear Anthropic-format error', async (t) => {
  const closedPort = await freePort();
  const worker = await startWorker(t, [
    { id: 'down', name: 'Down Proxy', baseUrl: `http://127.0.0.1:${closedPort}`, models: ['m'] },
    { id: 'nokey', name: 'No Key', baseUrl: `http://127.0.0.1:${closedPort}`, apiKeyEnv: 'CODE_TEAM_TEST_UNSET_KEY', models: ['m'] },
  ]);
  const down = await request(worker.port, { body: { model: 'claude-down-m', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] } });
  assert.equal(down.status, 502);
  const error = JSON.parse(down.body);
  assert.equal(error.type, 'error');
  assert.equal(error.error.type, 'api_error');
  assert.match(error.error.message, /Down Proxy is not answering at http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\)/);
  assert.match(error.error.message, /add an "autostart"/);

  const missing = await request(worker.port, { body: { model: 'claude-nokey-m', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] } });
  assert.equal(missing.status, 401);
  assert.equal(JSON.parse(missing.body).error.type, 'authentication_error');
  assert.match(JSON.parse(missing.body).error.message, /set CODE_TEAM_TEST_UNSET_KEY/);
});

test('upstream errors pass through, and a gateway without providers keeps the upstream catalog', async (t) => {
  const fake = await fakeProvider(t, { messagesStatus: 429 });
  const worker = await startWorker(t, [{ id: 'busy', baseUrl: `http://127.0.0.1:${fake.port}`, models: ['m'] }]);
  const limited = await request(worker.port, { body: { model: 'claude-busy-m', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] } });
  assert.equal(limited.status, 429);
  assert.equal(JSON.parse(limited.body).error.message, 'slow down');

  const bare = await startWorker(t, null);
  assert.ok(bare.models.some((model) => model.id.startsWith('claude-gpt-')), 'unconfigured gateway keeps the upstream fallback rows');
  const health = JSON.parse((await request(bare.port, { method: 'GET', path: '/healthz' })).body);
  assert.deepEqual(health.providers, []);
});
