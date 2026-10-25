'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const registry = require('../lib/providers.js');
const presets = require('../lib/provider-presets.js');
const http = require('node:http');
const { EXIT, acceptGoogleTerms, connectCommand, parseArgs } = require('../lib/provider-commands.js');

const BASE = { id: 'acme', baseUrl: 'https://api.acme.test/anthropic', apiKeyEnv: 'ACME_API_KEY', models: ['acme-large'] };

function tempFile(name, contents) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-team-providers-'));
  const file = path.join(directory, name);
  if (contents !== undefined) fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return file;
}

// The worker reads the default providers.json under the isolated test home.
function useDefaultProviders(t, list) {
  fs.mkdirSync(path.dirname(registry.PROVIDERS_PATH), { recursive: true });
  registry.writeProviderList(list);
  t.after(() => {
    fs.rmSync(registry.PROVIDERS_PATH, { force: true });
    registry.writeProviderList([]);
    fs.rmSync(registry.PROVIDERS_PATH, { force: true });
  });
}

test('a valid provider is normalized with defaults', () => {
  const provider = registry.validateProvider({ ...BASE, baseUrl: 'https://api.acme.test/anthropic/' });
  assert.equal(provider.name, 'acme');
  assert.equal(provider.baseUrl, 'https://api.acme.test/anthropic');
  assert.equal(provider.authStyle, 'x-api-key');
  assert.equal(provider.modelsFrom, 'static');
  assert.deepEqual(provider.models, [{ id: 'acme-large' }]);
  assert.deepEqual(provider.headers, {});
});

test('registry validation names each problem', () => {
  const invalid = [
    [{ ...BASE, baseUrl: undefined }, /baseUrl must be an http\(s\) URL/],
    [{ ...BASE, baseUrl: 'ftp://acme.test' }, /http or https/],
    [{ ...BASE, baseUrl: 'http://api.acme.test' }, /plain http is allowed only for a local/],
    [{ ...BASE, baseUrl: 'https://user:pass@acme.test' }, /must not contain credentials/],
    [{ ...BASE, baseUrl: 'https://acme.test/anthropic/v1' }, /stop before \/v1/],
    [{ ...BASE, authStyle: 'basic' }, /authStyle must be one of/],
    [{ ...BASE, apiKeyEnv: 'NOT A NAME' }, /apiKeyEnv must be an environment variable name/],
    [{ ...BASE, models: [] }, /give a models array or "modelsFrom": "list"/],
    [{ ...BASE, modelsFrom: 'scrape' }, /modelsFrom must be "list"/],
    [{ ...BASE, ownedBy: 'antigravity' }, /ownedBy is a string filter for modelsFrom "list"/],
    [{ ...BASE, models: ['has space'] }, /non-empty id without spaces/],
    [{ ...BASE, contextWindow: 12.5 }, /contextWindow must be a whole token count/],
    [{ ...BASE, headers: { Host: 'evil.test' } }, /header "Host" is not allowed/],
    [{ ...BASE, headers: { Cookie: 'a=b' } }, /header "Cookie" is not allowed/],
    [{ ...BASE, headers: { 'X-Ok': 'a\r\nInjected: 1' } }, /single-line string/],
    [{ ...BASE, autostart: { args: [] } }, /autostart needs a command/],
    [{ ...BASE, autostart: { command: 'proxy', args: [1] } }, /autostart.args must be an array of strings/],
  ];
  for (const [entry, message] of invalid) assert.throws(() => registry.validateProvider(entry), message, JSON.stringify(entry));
  assert.equal(registry.validateProvider({ ...BASE, baseUrl: 'http://127.0.0.1:8317' }).baseUrl, 'http://127.0.0.1:8317');
  assert.equal(registry.validateProvider({ ...BASE, baseUrl: 'http://localhost:8317' }).baseUrl, 'http://localhost:8317');
});

test('reserved and malformed provider ids are refused', () => {
  for (const id of registry.RESERVED_IDS) {
    assert.throws(() => registry.validateProvider({ ...BASE, id }), /id is reserved/, id);
  }
  for (const id of ['gpt', 'grok', 'anthropic', 'claude']) assert.ok(registry.RESERVED_IDS.includes(id), id);
  for (const id of ['', 'Acme', 'ac-me', 'ac_me', '3p', 'a'.repeat(21), 42]) {
    assert.throws(() => registry.validateProvider({ ...BASE, id }), /must be 1-20 characters/, String(id));
  }
});

test('providers.json parsing keeps valid entries and reports the rest', () => {
  const file = tempFile('providers.json', [BASE, { ...BASE }, { ...BASE, id: 'grok' }, { ...BASE, id: 'other' }]);
  const config = registry.readProviderConfig({ file });
  assert.deepEqual(config.providers.map((provider) => provider.id), ['acme', 'other']);
  assert.equal(config.errors.length, 2);
  assert.match(config.errors[0], /entry 1: provider acme: duplicate id/);
  assert.match(config.errors[1], /entry 2: provider grok: id is reserved/);

  assert.deepEqual(registry.readProviderConfig({ file: tempFile('wrapped.json', { providers: [BASE] }) }).providers.map((p) => p.id), ['acme']);
  assert.match(registry.readProviderConfig({ file: tempFile('broken.json', '{') }).errors[0], /not valid JSON/);
  assert.match(registry.readProviderConfig({ file: tempFile('object.json', { acme: BASE }) }).errors[0], /JSON array/);
  const missing = registry.readProviderConfig({ file: tempFile('absent.json') });
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.errors, []);
});

test('writeProviderList refuses an invalid list and writes a private file atomically', () => {
  const file = tempFile('providers.json');
  assert.throws(() => registry.writeProviderList([{ ...BASE, id: 'claude' }], { file }), /reserved/);
  assert.equal(fs.existsSync(file), false);
  registry.writeProviderList([BASE], { file });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [BASE]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), []);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('every preset validates and the API-key presets read their key from the environment', () => {
  for (const name of presets.presetNames()) {
    const provider = registry.validateProvider(presets.providerFromPreset(name));
    assert.equal(provider.preset, name);
    if (name !== 'antigravity') {
      assert.match(provider.apiKeyEnv, /^[A-Z]+_API_KEY$/, name);
      assert.equal(provider.apiKey, undefined, name);
      assert.ok(provider.baseUrl.startsWith('https://'), name);
    }
  }
  const agy = registry.validateProvider(presets.providerFromPreset('antigravity'));
  assert.equal(agy.id, 'agy');
  assert.equal(agy.baseUrl, 'http://127.0.0.1:8317');
  assert.equal(agy.modelsFrom, 'list');
  assert.equal(agy.ownedBy, 'antigravity');
  assert.equal(agy.apiKeyFile, presets.ANTIGRAVITY_CONNECTION_FILE);
  assert.equal(registry.validateProvider(presets.providerFromPreset('kimi', { region: 'cn' })).baseUrl, 'https://api.moonshot.cn/anthropic');
  assert.throws(() => presets.providerFromPreset('deepseek', { region: 'cn' }), /has no region cn/);
  assert.throws(() => presets.providerFromPreset('nope'), /unknown preset/);
});

test('API keys resolve from the environment first, then providers.json, then a key file', () => {
  const keyFile = tempFile('connection.json', { apiKey: 'from-file' });
  const provider = registry.validateProvider({ ...BASE, apiKey: 'stored', apiKeyFile: keyFile });
  assert.deepEqual(registry.resolveApiKey(provider, { env: { ACME_API_KEY: 'from-env' } }), { key: 'from-env', source: 'env ACME_API_KEY' });
  assert.deepEqual(registry.resolveApiKey(provider, { env: {} }), { key: 'stored', source: 'providers.json' });
  const fileOnly = registry.validateProvider({ ...BASE, apiKeyEnv: undefined, apiKeyFile: keyFile });
  assert.equal(registry.resolveApiKey(fileOnly, { env: {} }).key, 'from-file');
  assert.equal(registry.resolveApiKey(registry.validateProvider(BASE), { env: {} }).key, null);
  assert.match(registry.missingKeyHint(registry.validateProvider(BASE)), /set ACME_API_KEY/);
});

test('auth headers carry only the provider key in the configured style', () => {
  const headersFor = (authStyle) => registry.providerAuthHeaders(registry.validateProvider({ ...BASE, authStyle, headers: { 'X-Extra': '1' } }), 'k');
  assert.deepEqual(headersFor('x-api-key'), { 'x-extra': '1', 'x-api-key': 'k' });
  assert.deepEqual(headersFor('bearer'), { 'x-extra': '1', authorization: 'Bearer k' });
  assert.deepEqual(headersFor('both'), { 'x-extra': '1', 'x-api-key': 'k', authorization: 'Bearer k' });
  assert.deepEqual(registry.providerAuthHeaders(registry.validateProvider(BASE), null), {});
});

test('picker ids route by provider prefix and map back to the upstream model id', () => {
  const providers = [
    registry.validateProvider({ ...BASE, models: ['acme-large', 'Acme-Mini/Preview'] }),
    registry.validateProvider({ ...BASE, id: 'other', models: ['m1'] }),
  ];
  const route = registry.routeForModel('claude-acme-acme-large[1m]', { providers });
  assert.equal(route.provider.id, 'acme');
  assert.equal(route.model, 'acme-large');
  assert.equal(route.backendId, 'acme-acme-large');
  assert.equal(registry.routeForModel('claude-acme-acme-mini-preview', { providers }).model, 'Acme-Mini/Preview');
  assert.equal(registry.routeForModel('claude-other-m1', { providers }).provider.id, 'other');
  // Unknown suffixes still go to the provider unchanged; it answers for its own catalog.
  assert.equal(registry.routeForModel('claude-acme-acme-xl', { providers }).model, 'acme-xl');
  for (const id of ['claude-opus-5-5[1m]', 'claude-sonnet-5-5', 'claude-gpt-6.1-sol', 'claude-grok-4.5', 'claude-nobody-x', 'acme-acme-large', 'claude-acme', 'claude-acme-', null, 42]) {
    assert.equal(registry.routeForModel(id, { providers }), null, String(id));
  }
  assert.equal(registry.routeForModel('claude-acme-acme-large', { providers: [] }), null);
});

test('picker catalog rows use the window policy and [1m] alias like the GPT rows', (t) => {
  useDefaultProviders(t, [
    { ...BASE, name: 'Acme', models: [{ id: 'acme-large', name: 'Acme Large', contextWindow: 1000000 }, 'acme-small'] },
    { id: 'tiny', baseUrl: 'http://127.0.0.1:9', models: [{ id: 'tiny-1', contextWindow: 128000 }] },
  ]);
  delete require.cache[require.resolve('../lib/request-worker.js')];
  const { gatewayModel } = require('../lib/request-worker.js');
  const rows = registry.configuredProviders()
    .flatMap((provider) => registry.providerCatalogEntries(provider))
    .map((entry) => ({ ...gatewayModel(entry.backendId, 'provider'), display_name: entry.displayName }));
  assert.deepEqual(rows, [
    { id: 'claude-acme-acme-large[1m]', display_name: 'Acme Large (Acme)', type: 'model', max_input_tokens: 1000000 },
    { id: 'claude-acme-acme-small', display_name: 'acme-small (Acme)', type: 'model', max_input_tokens: 200000 },
    { id: 'claude-tiny-tiny-1', display_name: 'tiny-1 (tiny)', type: 'model', max_input_tokens: 128000 },
  ]);
  const runtime = require('../lib/runtime.js');
  const large = runtime.resolveGatewayModelPolicy('claude-acme-acme-large[1m]');
  assert.equal(large.backend, 'provider');
  assert.equal(large.sentry, 'synthetic-413');
  assert.equal(runtime.effectiveSentryPolicy(large).compactTrigger, 1000000 - 40000);
  assert.equal(runtime.resolveGatewayModelPolicy('claude-acme-acme-small').sentry, 'none');
  assert.equal(runtime.effectiveSentryPolicy(runtime.resolveGatewayModelPolicy('claude-tiny-tiny-1')).compactTrigger, 88000);
  // Built-in rows and Claude models keep their own policies.
  assert.equal(runtime.resolveGatewayModelPolicy('claude-gpt-6.1-sol').backend, 'codex');
  assert.equal(runtime.resolveGatewayModelPolicy('claude-grok-4.5').backend, 'grok');
  assert.equal(runtime.resolveGatewayModelPolicy('claude-opus-5-5').backend, 'anthropic');
  assert.equal(gatewayModel('acme-acme-large', 'codex'), null);
});

test('listed catalogs merge with static entries and honour the ownedBy filter', () => {
  const provider = registry.validateProvider({ ...BASE, id: 'agy', modelsFrom: 'list', ownedBy: 'antigravity', models: [{ id: 'gem-pro', contextWindow: 1000000 }] });
  const listed = registry.parseModelList(Buffer.from(JSON.stringify({ data: [
    { id: 'gem-pro', owned_by: 'antigravity' },
    { id: 'gem-flash', owned_by: 'antigravity', display_name: 'Gem Flash' },
    { id: 'gpt-x', owned_by: 'openai' },
  ] })), provider);
  assert.deepEqual(listed, [{ id: 'gem-pro' }, { id: 'gem-flash', display_name: 'Gem Flash' }]);
  const models = registry.providerModels(provider, { cache: { models: listed } });
  assert.deepEqual(models, [{ id: 'gem-pro', contextWindow: 1000000 }, { id: 'gem-flash', name: 'Gem Flash' }]);
  assert.throws(() => registry.parseModelList(Buffer.from('{"models":[]}'), provider), /no data array/);
});

test('autostart launches at most once per interval, across autostarter instances', () => {
  const stateFile = tempFile('autostart.json');
  let clock = 1000000;
  const launches = [];
  const spawn = (command, args, options) => {
    launches.push({ command, args, detached: options.detached });
    return { on() {}, unref() {} };
  };
  const provider = registry.validateProvider({ ...BASE, baseUrl: 'http://127.0.0.1:9', autostart: { command: 'local-proxy', args: ['-config', 'c.yaml'] } });
  const first = registry.createAutostarter({ spawn, now: () => clock, stateFile });
  assert.deepEqual(first(provider), { started: true });
  clock += 30000;
  assert.deepEqual(first(provider), { started: false, reason: 'throttled', retryInMs: 30000 });
  const second = registry.createAutostarter({ spawn, now: () => clock, stateFile });
  assert.equal(second(provider).reason, 'throttled');
  clock += 30000;
  assert.deepEqual(second(provider), { started: true });
  assert.deepEqual(launches, [
    { command: 'local-proxy', args: ['-config', 'c.yaml'], detached: true },
    { command: 'local-proxy', args: ['-config', 'c.yaml'], detached: true },
  ]);
  assert.deepEqual(first(registry.validateProvider(BASE)), { started: false, reason: 'not-configured' });
  const failing = registry.createAutostarter({ spawn: () => { throw new Error('ENOENT'); }, now: () => clock, stateFile: null });
  assert.deepEqual(failing(provider), { started: false, reason: 'spawn-failed', error: 'ENOENT' });
  assert.match(registry.autostartHint(provider, { started: true }), /Starting .* local proxy now/);
  assert.match(registry.autostartHint(provider, { reason: 'throttled' }), /less than a minute ago/);
  assert.match(registry.autostartHint(registry.validateProvider(BASE), null), /add an "autostart"/);
});

test('the Antigravity terms gate needs a flag, a yes, or a recorded acceptance', async () => {
  const lines = [];
  const out = (line) => lines.push(line);
  const now = () => new Date('2026-10-25T12:00:00.000Z');
  assert.equal(await acceptGoogleTerms(parseArgs([]), null, { out, ask: async () => false, now }), null);
  assert.match(lines.join('\n'), /violates Google's terms of service and can get your\nGoogle account suspended/);
  const viaFlag = await acceptGoogleTerms(parseArgs(['--accept-google-terms']), null, { out, ask: async () => false, now });
  assert.deepEqual(viaFlag, { google: { acceptedAt: '2026-10-25T12:00:00.000Z', version: presets.GOOGLE_TERMS_VERSION, via: 'flag' } });
  const viaPrompt = await acceptGoogleTerms(parseArgs([]), null, { out, ask: async () => true, now });
  assert.equal(viaPrompt.google.via, 'prompt');
  const recorded = { termsAccepted: { google: { acceptedAt: '2026-01-01T00:00:00.000Z' } } };
  assert.equal(await acceptGoogleTerms(parseArgs([]), recorded, { out, ask: async () => false, now }), recorded.termsAccepted);
});

test('builtin connections record connect and disconnect state', () => {
  const file = tempFile('connections.json');
  registry.writeConnections({ grok: { connectedAt: 'x' } }, { file });
  const connections = registry.readConnections({ file });
  assert.equal(registry.builtinConnected('grok', connections), true);
  assert.equal(registry.builtinDisabled('grok', connections), false);
  assert.equal(registry.builtinDisabled('gpt', { gpt: { disabled: true } }), true);
  assert.equal(registry.builtinConnected('grok', { grok: { connectedAt: 'x', disabled: true } }), false);
});

test('connect tests a registered custom provider, then wires the project only when the key works', async (t) => {
  const server = http.createServer((req, res) => {
    const ok = req.headers['x-api-key'] === 'right-key';
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { data: [{ id: 'm1' }] } : { type: 'error', error: { type: 'authentication_error', message: 'bad key' } }));
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => server.close());
  const file = tempFile('providers.json');
  const baseUrl = `http://127.0.0.1:${port}`;
  registry.writeProviderList([
    { id: 'good', name: 'Good', baseUrl, apiKey: 'right-key', models: ['m1'] },
    { id: 'refused', name: 'Refused', baseUrl, apiKey: 'wrong-key', models: ['m1'] },
  ], { file });
  const lines = [];
  const wired = [];
  const context = { file, env: {}, out: (line) => lines.push(line), refreshGateway: async (options) => { wired.push(options); return { ok: true }; } };

  assert.equal(await connectCommand(['good'], context), EXIT.ok);
  assert.deepEqual(wired, [{ wire: true, providerId: 'good' }]);
  assert.match(lines.join('\n'), /Connected Good: 1 model \(claude-good-m1\)/);

  lines.length = 0;
  assert.equal(await connectCommand(['refused'], context), EXIT.action);
  assert.equal(wired.length, 1);
  assert.match(lines.join('\n'), /refused: FAILED: the provider refused the key \(HTTP 401\)/);
  assert.doesNotMatch(lines.join('\n'), /wrong-key/);
});
