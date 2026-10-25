'use strict';

// Registry of providers that already speak the Anthropic Messages API
// (`POST <baseUrl>/v1/messages`). The gateway passes their requests straight
// through and changes only the model id and the auth headers.
//
// Config: ~/.claude/code-team/providers.json, a JSON array of providers. Picker
// ids are `claude-<provider id>-<model>`; an unconfigured gateway reads one
// missing file and never probes anything.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { writeFileAtomically } = require('./atomic-file.js');

const STATE = path.join(os.homedir(), '.claude', 'code-team');
const PROVIDERS_PATH = path.join(STATE, 'providers.json');
const CONNECTIONS_PATH = path.join(STATE, 'connections.json');
const PROVIDER_MODELS_DIR = path.join(STATE, 'provider-models');
const AUTOSTART_STATE_PATH = path.join(STATE, 'autostart.json');

// [a-z0-9], starting with a letter: claude-3-5-sonnet style ids must never reach a provider called "3".
const ID_RE = /^[a-z][a-z0-9]*$/;
const MAX_ID_LENGTH = 20;
// gpt/grok/codex are routed by the built-in backends; the Claude family names would shadow real Claude models.
const RESERVED_IDS = Object.freeze(['gpt', 'grok', 'anthropic', 'claude', 'codex', 'opus', 'sonnet', 'haiku', 'fable']);
const AUTH_STYLES = Object.freeze(['x-api-key', 'bearer', 'both']);
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'cookie', 'proxy-authorization']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
// Claude Code's window for a model it does not know.
const UNKNOWN_MODEL_WINDOW = 200000;
// The synthetic-413 sentry keeps 40k of headroom, so a window has to leave room above it.
const MIN_SENTRY_WINDOW = 80000;
const AUTOSTART_INTERVAL_MS = 60000;
const MODEL_LIST_TTL_MS = 5 * 60 * 1000;

function expandHome(value) {
  return typeof value === 'string' && /^~(?=$|[\\/])/.test(value) ? path.join(os.homedir(), value.slice(1)) : value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validContextWindow(value, where) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1000 || value > 10000000) throw new Error(`${where}: contextWindow must be a whole token count between 1000 and 10000000`);
  return value;
}

function validateBaseUrl(value, where) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error(`${where}: baseUrl must be an http(s) URL`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${where}: baseUrl must use http or https`);
  if (url.username || url.password) throw new Error(`${where}: baseUrl must not contain credentials; use apiKeyEnv`);
  if (url.search || url.hash) throw new Error(`${where}: baseUrl must not contain a query or fragment`);
  // A key sent over plain http to another machine is readable on the network.
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) throw new Error(`${where}: plain http is allowed only for a local (loopback) baseUrl`);
  const normalized = url.href.replace(/\/+$/, '');
  if (/\/v1(\/messages)?$/.test(normalized)) throw new Error(`${where}: baseUrl must stop before /v1 (the gateway appends /v1/messages)`);
  return normalized;
}

function validateHeaders(headers, where) {
  if (headers === undefined) return {};
  if (!isPlainObject(headers)) throw new Error(`${where}: headers must be an object of strings`);
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME_RE.test(name) || FORBIDDEN_HEADERS.has(lower)) throw new Error(`${where}: header ${JSON.stringify(name)} is not allowed`);
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error(`${where}: header ${name} must be a single-line string`);
    result[lower] = value;
  }
  return result;
}

function validateModel(entry, where) {
  const model = typeof entry === 'string' ? { id: entry } : entry;
  if (!isPlainObject(model) || typeof model.id !== 'string' || !model.id || model.id.length > 128 || /[\s\u0000-\u001f]/.test(model.id)) {
    throw new Error(`${where}: each model needs a non-empty id without spaces`);
  }
  if (model.name !== undefined && typeof model.name !== 'string') throw new Error(`${where}: model ${model.id} name must be a string`);
  const result = { id: model.id };
  if (model.name) result.name = model.name;
  const contextWindow = validContextWindow(model.contextWindow, `${where} model ${model.id}`);
  if (contextWindow) result.contextWindow = contextWindow;
  return result;
}

function validateAutostart(autostart, where) {
  if (autostart === undefined || autostart === null) return null;
  if (!isPlainObject(autostart) || typeof autostart.command !== 'string' || !autostart.command.trim()) {
    throw new Error(`${where}: autostart needs a command`);
  }
  if (autostart.args !== undefined && (!Array.isArray(autostart.args) || autostart.args.some((arg) => typeof arg !== 'string'))) {
    throw new Error(`${where}: autostart.args must be an array of strings`);
  }
  if (autostart.cwd !== undefined && typeof autostart.cwd !== 'string') throw new Error(`${where}: autostart.cwd must be a string`);
  return { command: autostart.command, args: autostart.args || [], ...(autostart.cwd ? { cwd: autostart.cwd } : {}) };
}

function validateAuth(raw, where) {
  const auth = {};
  if (raw.apiKey !== undefined) {
    if (typeof raw.apiKey !== 'string' || !raw.apiKey || /[\r\n]/.test(raw.apiKey)) throw new Error(`${where}: apiKey must be a non-empty string`);
    auth.apiKey = raw.apiKey;
  }
  if (raw.apiKeyEnv !== undefined) {
    if (typeof raw.apiKeyEnv !== 'string' || !ENV_NAME_RE.test(raw.apiKeyEnv)) throw new Error(`${where}: apiKeyEnv must be an environment variable name`);
    auth.apiKeyEnv = raw.apiKeyEnv;
  }
  if (raw.apiKeyFile !== undefined) {
    if (typeof raw.apiKeyFile !== 'string' || !raw.apiKeyFile) throw new Error(`${where}: apiKeyFile must be a path`);
    auth.apiKeyFile = raw.apiKeyFile;
  }
  const authStyle = raw.authStyle === undefined ? 'x-api-key' : raw.authStyle;
  if (!AUTH_STYLES.includes(authStyle)) throw new Error(`${where}: authStyle must be one of ${AUTH_STYLES.join(', ')}`);
  auth.authStyle = authStyle;
  return auth;
}

function validateModels(raw, where) {
  if (raw.modelsFrom !== undefined && raw.modelsFrom !== 'list') throw new Error(`${where}: modelsFrom must be "list" (or omit it and give models)`);
  if (raw.models !== undefined && !Array.isArray(raw.models)) throw new Error(`${where}: models must be an array`);
  const models = (raw.models || []).map((model) => validateModel(model, where));
  if (raw.modelsFrom !== 'list' && !models.length) throw new Error(`${where}: give a models array or "modelsFrom": "list"`);
  if (raw.ownedBy !== undefined && (typeof raw.ownedBy !== 'string' || raw.modelsFrom !== 'list')) throw new Error(`${where}: ownedBy is a string filter for modelsFrom "list"`);
  return { modelsFrom: raw.modelsFrom === 'list' ? 'list' : 'static', ...(raw.ownedBy ? { ownedBy: raw.ownedBy } : {}), models };
}

// Returns the normalized provider, or throws an Error that names the problem.
function validateProvider(raw) {
  if (!isPlainObject(raw)) throw new Error('each provider must be an object');
  const { id } = raw;
  if (typeof id !== 'string' || !ID_RE.test(id) || id.length > MAX_ID_LENGTH) {
    throw new Error(`provider id ${JSON.stringify(id)} must be 1-${MAX_ID_LENGTH} characters of [a-z0-9], starting with a letter`);
  }
  const where = `provider ${id}`;
  if (RESERVED_IDS.includes(id)) throw new Error(`${where}: id is reserved (${RESERVED_IDS.join(', ')})`);
  if (raw.name !== undefined && (typeof raw.name !== 'string' || !raw.name.trim())) throw new Error(`${where}: name must be a non-empty string`);
  const provider = {
    id,
    name: raw.name || id,
    baseUrl: validateBaseUrl(raw.baseUrl, where),
    ...validateAuth(raw, where),
    headers: validateHeaders(raw.headers, where),
    ...validateModels(raw, where),
  };
  const contextWindow = validContextWindow(raw.contextWindow, where);
  if (contextWindow) provider.contextWindow = contextWindow;
  const autostart = validateAutostart(raw.autostart, where);
  if (autostart) provider.autostart = autostart;
  if (typeof raw.preset === 'string') provider.preset = raw.preset;
  if (isPlainObject(raw.termsAccepted)) provider.termsAccepted = raw.termsAccepted;
  return provider;
}

function parseProviderList(parsed) {
  const list = Array.isArray(parsed) ? parsed : isPlainObject(parsed) && Array.isArray(parsed.providers) ? parsed.providers : null;
  if (!list) return { providers: [], errors: ['providers.json must hold a JSON array of providers'] };
  const providers = [];
  const errors = [];
  const seen = new Set();
  list.forEach((entry, index) => {
    try {
      const provider = validateProvider(entry);
      if (seen.has(provider.id)) throw new Error(`provider ${provider.id}: duplicate id`);
      seen.add(provider.id);
      providers.push(provider);
    } catch (error) {
      errors.push(`entry ${index}: ${error.message}`);
    }
  });
  return { providers, errors };
}

function readProviderConfig({ file = PROVIDERS_PATH } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    return { file, exists: false, raw: [], providers: [], errors: error.code === 'ENOENT' ? [] : [`could not read ${file}: ${error.code}`] };
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    return { file, exists: true, raw: [], providers: [], errors: [`${file} is not valid JSON`] };
  }
  const raw = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.providers) ? parsed.providers : [];
  return { file, exists: true, raw, ...parseProviderList(parsed) };
}

// The worker resolves picker ids on every request, so it reads the file again only when its mtime changes.
let snapshot = { file: null, checkedAt: 0, stamp: null, providers: [], errors: [] };
function fileStamp(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch { return null; }
}

function configuredProviders({ file = PROVIDERS_PATH, now = Date.now } = {}) {
  const time = now();
  if (snapshot.file === file && time - snapshot.checkedAt < 1000) return snapshot.providers;
  const stamp = fileStamp(file);
  if (snapshot.file !== file || stamp !== snapshot.stamp) {
    const config = stamp ? readProviderConfig({ file }) : { providers: [], errors: [] };
    snapshot = { file, checkedAt: time, stamp, providers: config.providers, errors: config.errors };
  } else {
    snapshot.checkedAt = time;
  }
  return snapshot.providers;
}

function providersStamp(file = PROVIDERS_PATH) {
  return `${fileStamp(file)}|${fileStamp(CONNECTIONS_PATH)}`;
}

function writeProviderList(list, { file = PROVIDERS_PATH } = {}) {
  const { errors } = parseProviderList(list);
  if (errors.length) throw new Error(errors.join('; '));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // providers.json may hold an apiKey, so it is private to this user.
  writeFileAtomically(file, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  snapshot = { file: null, checkedAt: 0, stamp: null, providers: [], errors: [] };
}

function readConnections({ file = CONNECTIONS_PATH } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlainObject(parsed) ? parsed : {};
  } catch { return {}; }
}

function writeConnections(value, { file = CONNECTIONS_PATH } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomically(file, JSON.stringify(value, null, 2) + '\n');
}

function builtinDisabled(name, connections = readConnections()) {
  return connections[name]?.disabled === true;
}

function builtinConnected(name, connections = readConnections()) {
  return Boolean(connections[name]?.connectedAt) && !builtinDisabled(name, connections);
}

function readKeyFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(expandHome(file), 'utf8'));
    return typeof parsed?.apiKey === 'string' && parsed.apiKey ? parsed.apiKey : null;
  } catch { return null; }
}

// Environment first, as documented: a key in the environment never has to be written to disk.
function resolveApiKey(provider, { env = process.env } = {}) {
  if (provider.apiKeyEnv && env[provider.apiKeyEnv]) return { key: env[provider.apiKeyEnv], source: `env ${provider.apiKeyEnv}` };
  if (provider.apiKey) return { key: provider.apiKey, source: 'providers.json' };
  if (provider.apiKeyFile) {
    const key = readKeyFile(provider.apiKeyFile);
    if (key) return { key, source: `file ${provider.apiKeyFile}` };
  }
  return { key: null, source: null };
}

function missingKeyHint(provider) {
  const options = [];
  if (provider.apiKeyEnv) options.push(`set ${provider.apiKeyEnv} in the environment that starts the gateway`);
  if (provider.apiKeyFile) options.push(`make sure ${provider.apiKeyFile} holds an apiKey`);
  options.push('or store a key with `provider add ... --api-key-stdin`');
  return `no API key for ${provider.name}: ${options.join(', ')}`;
}

// Only the provider's own key goes out; the client's Anthropic credentials are never copied here.
function providerAuthHeaders(provider, key) {
  const headers = { ...provider.headers };
  if (!key) return headers;
  if (provider.authStyle !== 'bearer') headers['x-api-key'] = key;
  if (provider.authStyle !== 'x-api-key') headers.authorization = `Bearer ${key}`;
  return headers;
}

function pickerSuffix(modelId) {
  return String(modelId).toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function modelsCachePath(provider, directory = PROVIDER_MODELS_DIR) {
  return path.join(directory, `${provider.id}.json`);
}

function readModelsCache(provider, { directory = PROVIDER_MODELS_DIR } = {}) {
  try {
    const cache = JSON.parse(fs.readFileSync(modelsCachePath(provider, directory), 'utf8'));
    if (cache?.baseUrl !== provider.baseUrl || !Array.isArray(cache.models)) return null;
    return { fetchedAt: cache.fetchedAt, models: cache.models.filter((model) => typeof model?.id === 'string' && model.id) };
  } catch { return null; }
}

function writeModelsCache(provider, models, { directory = PROVIDER_MODELS_DIR, now = Date.now } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  writeFileAtomically(modelsCachePath(provider, directory), JSON.stringify({ baseUrl: provider.baseUrl, fetchedAt: now(), models }, null, 2) + '\n');
}

function removeModelsCache(provider, { directory = PROVIDER_MODELS_DIR } = {}) {
  try { fs.rmSync(modelsCachePath(provider, directory), { force: true }); } catch {}
}

// Static entries win over listed ones, so a configured name or contextWindow survives a refresh.
function providerModels(provider, { cache = provider.modelsFrom === 'list' ? readModelsCache(provider) : null } = {}) {
  const byId = new Map();
  for (const model of cache?.models || []) {
    byId.set(model.id, { id: model.id, ...(typeof model.display_name === 'string' ? { name: model.display_name } : {}) });
  }
  for (const model of provider.models) byId.set(model.id, { ...byId.get(model.id), ...model });
  return [...byId.values()];
}

function upstreamModelFor(provider, suffix, models = providerModels(provider)) {
  const match = models.find((model) => pickerSuffix(model.id) === suffix);
  return match ? match.id : suffix;
}

// claude-<id>-<suffix>[1m] -> { provider, model, backendId }; null for every id a provider does not own.
function routeForModel(model, { providers = configuredProviders() } = {}) {
  if (typeof model !== 'string' || !providers.length) return null;
  const bare = model.replace(/\[1m\]$/, '');
  if (!bare.startsWith('claude-')) return null;
  return routeForBackendId(bare.slice('claude-'.length), { providers });
}

function routeForBackendId(backendId, { providers = configuredProviders() } = {}) {
  const dash = backendId.indexOf('-');
  if (dash <= 0) return null;
  const provider = providers.find((entry) => entry.id === backendId.slice(0, dash));
  const suffix = backendId.slice(dash + 1);
  if (!provider || !suffix) return null;
  const models = providerModels(provider);
  const upstreamModel = upstreamModelFor(provider, suffix, models);
  const entry = models.find((candidate) => candidate.id === upstreamModel) || { id: upstreamModel };
  return { provider, model: upstreamModel, entry, backendId: `${provider.id}-${suffix}` };
}

function modelContextWindow(provider, entry) {
  return entry?.contextWindow || provider.contextWindow || null;
}

// Same shape as runtime.js MODEL_WINDOW_POLICY rows, so the [1m] alias and sentry logic treat these rows
// exactly like the GPT ones. An unconfigured window stays at Claude Code's unknown-model 200k.
function providerModelPolicy(backendId, options = {}) {
  const route = routeForBackendId(backendId, options);
  if (!route) return null;
  const window = modelContextWindow(route.provider, route.entry);
  return Object.freeze({
    backend: 'provider',
    providerId: route.provider.id,
    providerName: route.provider.name,
    upstreamModel: route.model,
    backendId: route.backendId,
    backendWindow: window,
    measurement: window ? `configured contextWindow for ${route.provider.name}` : 'not configured; Claude Code unknown-model window',
    pickerAliasTemplate: 'claude-{backendId}[1m]',
    advertisedWindow: window || UNKNOWN_MODEL_WINDOW,
    sentry: window && window > MIN_SENTRY_WINDOW ? 'synthetic-413' : 'none',
  });
}

function providerDisplayName(provider, entry) {
  return `${entry.name || entry.id} (${provider.name})`;
}

function providerCatalogEntries(provider, models = providerModels(provider)) {
  return models.map((entry) => ({
    backendId: `${provider.id}-${pickerSuffix(entry.id)}`,
    displayName: providerDisplayName(provider, entry),
  }));
}

function parseModelList(body, provider) {
  const data = JSON.parse(body.toString()).data;
  if (!Array.isArray(data)) throw new Error('model list has no data array');
  return data
    .filter((model) => model && typeof model.id === 'string' && model.id)
    .filter((model) => !provider.ownedBy || model.owned_by === provider.ownedBy)
    .map((model) => ({ id: model.id, ...(typeof model.display_name === 'string' ? { display_name: model.display_name } : {}) }));
}

// Never follows redirects: a redirect would carry the provider key to whatever host it names.
function requestProvider(url, { method = 'GET', headers = {}, body = null, timeout = 10000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const payload = body == null ? null : Buffer.from(body);
    const request = transport.request(target, {
      method,
      agent: false,
      headers: {
        'user-agent': 'code-team',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= maxBytes) chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(timeout, () => request.destroy(Object.assign(new Error(`timeout after ${timeout}ms`), { code: 'ETIMEDOUT' })));
    request.end(payload);
  });
}

async function fetchProviderModels(provider, { request = requestProvider, env = process.env, timeout = 2500 } = {}) {
  const { key } = resolveApiKey(provider, { env });
  let response;
  try {
    response = await request(`${provider.baseUrl}/v1/models`, {
      timeout,
      headers: { 'anthropic-version': '2023-06-01', ...providerAuthHeaders(provider, key) },
    });
  } catch (error) {
    return { ok: false, unreachable: true, error: error.code || error.message };
  }
  if (response.status !== 200) return { ok: false, status: response.status };
  try { return { ok: true, status: 200, models: parseModelList(response.body, provider) }; } catch (error) {
    return { ok: false, status: 200, error: error.message };
  }
}

function readAutostartState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

// Launches a provider's configured local proxy at most once per interval, across processes:
// the CLI and the worker share the last attempt time through a small state file.
function createAutostarter({
  spawn = (command, args, options) => childProcess.spawn(command, args, options),
  now = Date.now,
  intervalMs = AUTOSTART_INTERVAL_MS,
  stateFile = AUTOSTART_STATE_PATH,
} = {}) {
  const attempts = new Map();
  function lastAttempt(id) {
    const stored = stateFile ? Number(readAutostartState(stateFile)[id]) : NaN;
    return Math.max(attempts.get(id) ?? -Infinity, Number.isFinite(stored) ? stored : -Infinity);
  }
  function record(id, time) {
    attempts.set(id, time);
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileAtomically(stateFile, JSON.stringify({ ...readAutostartState(stateFile), [id]: time }) + '\n');
    } catch {}
  }
  return function ensureStarted(provider) {
    if (!provider?.autostart) return { started: false, reason: 'not-configured' };
    const time = now();
    const elapsed = time - lastAttempt(provider.id);
    if (elapsed < intervalMs) return { started: false, reason: 'throttled', retryInMs: intervalMs - elapsed };
    record(provider.id, time);
    const { command, args, cwd } = provider.autostart;
    try {
      const child = spawn(expandHome(command), args.map(expandHome), {
        cwd: cwd ? expandHome(cwd) : undefined, detached: true, stdio: 'ignore', windowsHide: true,
      });
      child?.on?.('error', () => {});
      child?.unref?.();
      return { started: true };
    } catch (error) {
      return { started: false, reason: 'spawn-failed', error: error.message };
    }
  };
}

function autostartHint(provider, result) {
  if (result?.started) return ` Starting ${provider.name}'s local proxy now (${provider.autostart.command}); retry in a few seconds.`;
  if (result?.reason === 'throttled') return ` A start of its local proxy was attempted less than a minute ago; retry shortly, or check that ${provider.autostart.command} runs.`;
  if (result?.reason === 'spawn-failed') return ` Its autostart command failed: ${result.error}.`;
  return ` Start it yourself, or add an "autostart" {command, args} entry for ${provider.id} in providers.json.`;
}

module.exports = {
  AUTH_STYLES, AUTOSTART_INTERVAL_MS, AUTOSTART_STATE_PATH, CONNECTIONS_PATH, MIN_SENTRY_WINDOW, MODEL_LIST_TTL_MS,
  PROVIDER_MODELS_DIR, PROVIDERS_PATH, RESERVED_IDS, STATE, UNKNOWN_MODEL_WINDOW,
  autostartHint, builtinConnected, builtinDisabled, configuredProviders, createAutostarter, expandHome,
  fetchProviderModels, missingKeyHint, modelContextWindow, parseModelList, parseProviderList, pickerSuffix,
  providerAuthHeaders, providerCatalogEntries, providerDisplayName, providerModelPolicy, providerModels,
  providersStamp, readConnections, readModelsCache, readProviderConfig, removeModelsCache, requestProvider, resolveApiKey,
  routeForBackendId, routeForModel, validateProvider, writeConnections, writeModelsCache, writeProviderList,
};
