'use strict';

// CLI for connections: `provider list|add|remove|test`, plus the one-step `connect`, `disconnect`
// and `connections` commands the /connect-* slash commands wrap. Exit codes: 0 done, 1 failed,
// 2 usage error, 3 the user has to act first (accept terms, supply a key, sign in).

const fs = require('node:fs');
const readline = require('node:readline');
const registry = require('./providers.js');
const presets = require('./provider-presets.js');

const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, action: 3 });
const VALUE_OPTIONS = new Set([
  '--region', '--api-key-env', '--model', '--base-url', '--id', '--name', '--auth-style', '--models-from',
  '--owned-by', '--context-window', '--header', '--autostart-command', '--autostart-arg', '--autostart-cwd',
]);
const BUILTINS = Object.freeze({
  gpt: { name: 'ChatGPT/Codex', command: '/connect-gpt' },
  grok: { name: 'Grok', command: '/connect-grok' },
});

function parseArgs(argv) {
  const positionals = [];
  const options = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const [name, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    if (VALUE_OPTIONS.has(name)) {
      const value = inline ?? argv[++index];
      if (value === undefined) throw usageError(`${name} needs a value`);
      options.set(name, [...(options.get(name) || []), value]);
    } else {
      flags.add(name);
    }
  }
  return { positionals, flags, option: (name) => options.get(name)?.at(-1), options: (name) => options.get(name) || [] };
}

function usageError(message) {
  return Object.assign(new Error(message), { exitCode: EXIT.usage });
}

function redact(text, key) {
  return key ? String(text).split(key).join('[redacted]') : String(text);
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function askYes(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => prompt.question(question, (answer) => {
    prompt.close();
    resolve(/^y(es)?$/i.test(answer.trim()));
  }));
}

function parseModelOption(value) {
  const match = /^(.+?)(?::(\d+))?$/.exec(value);
  return match[2] ? { id: match[1], contextWindow: Number(match[2]) } : { id: match[1] };
}

function parseHeaderOption(value) {
  const colon = value.indexOf(':');
  if (colon <= 0) throw usageError(`--header takes "Name: value", got ${JSON.stringify(value)}`);
  return [value.slice(0, colon).trim(), value.slice(colon + 1).trim()];
}

function customEntry(parsed) {
  const entry = {
    id: parsed.option('--id'),
    name: parsed.option('--name'),
    baseUrl: parsed.option('--base-url'),
  };
  if (!entry.id || !entry.baseUrl) throw usageError('provider add --custom needs --id and --base-url');
  if (parsed.option('--auth-style')) entry.authStyle = parsed.option('--auth-style');
  if (parsed.option('--models-from')) entry.modelsFrom = parsed.option('--models-from');
  if (parsed.option('--owned-by')) entry.ownedBy = parsed.option('--owned-by');
  if (parsed.option('--context-window')) entry.contextWindow = Number(parsed.option('--context-window'));
  const headers = parsed.options('--header').map(parseHeaderOption);
  if (headers.length) entry.headers = Object.fromEntries(headers);
  if (parsed.option('--autostart-command')) {
    entry.autostart = { command: parsed.option('--autostart-command'), args: parsed.options('--autostart-arg') };
    if (parsed.option('--autostart-cwd')) entry.autostart.cwd = parsed.option('--autostart-cwd');
  }
  if (!entry.name) delete entry.name;
  return entry;
}

function applyCommonOptions(entry, parsed, stdinKey) {
  if (parsed.option('--api-key-env')) entry.apiKeyEnv = parsed.option('--api-key-env');
  if (parsed.option('--base-url') && !parsed.flags.has('--custom')) entry.baseUrl = parsed.option('--base-url');
  const models = parsed.options('--model').map(parseModelOption);
  if (models.length) {
    const known = new Map((entry.models || []).map((model) => [model.id, model]));
    for (const model of models) known.set(model.id, { ...known.get(model.id), ...model });
    entry.models = [...known.values()];
  }
  if (stdinKey) entry.apiKey = stdinKey;
  return entry;
}

function readKeyFromStdin(parsed, { readInput = readStdin } = {}) {
  if (!parsed.flags.has('--api-key-stdin')) return null;
  const key = readInput().trim();
  if (!key || /\s/.test(key)) throw usageError('--api-key-stdin read no single-line key from stdin');
  return key;
}

function upsert(list, entry) {
  const index = list.findIndex((existing) => existing?.id === entry.id);
  if (index === -1) return [...list, entry];
  return list.map((existing, position) => (position === index ? entry : existing));
}

// The Antigravity gate: a recorded acceptance or an explicit one now, never a silent default.
async function acceptGoogleTerms(parsed, previous, { out, ask = askYes, now = () => new Date() }) {
  out(presets.GOOGLE_TERMS_WARNING);
  if (previous?.termsAccepted?.google?.acceptedAt) {
    out(`Acceptance already recorded on ${previous.termsAccepted.google.acceptedAt}.`);
    return previous.termsAccepted;
  }
  const accepted = parsed.flags.has('--accept-google-terms') || await ask('Type "yes" to accept this risk and continue: ');
  if (!accepted) return null;
  return { google: { acceptedAt: now().toISOString(), version: presets.GOOGLE_TERMS_VERSION, via: parsed.flags.has('--accept-google-terms') ? 'flag' : 'prompt' } };
}

function antigravityEntry(parsed, { cliproxy }) {
  const entry = presets.providerFromPreset('antigravity');
  const external = readJson(presets.ANTIGRAVITY_CONNECTION_FILE);
  if (external) {
    if (typeof external.baseUrl === 'string' && external.baseUrl) entry.baseUrl = external.baseUrl.replace(/\/+$/, '');
  } else if (cliproxy.installed()) {
    const managed = cliproxy.writeManagedConfig();
    entry.baseUrl = managed.baseUrl;
    entry.apiKeyFile = managed.connectionFile;
    entry.autostart = cliproxy.autostartEntry();
  }
  return entry;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function buildEntry(name, parsed, context) {
  const { list } = context;
  if (parsed.flags.has('--custom')) return applyCommonOptions(customEntry(parsed), parsed, readKeyFromStdin(parsed, context));
  if (!name) throw usageError(`provider add needs a preset (${presets.presetNames().join(', ')}) or --custom`);
  const preset = presets.presetByName(name);
  if (!preset) throw usageError(`unknown preset ${name}; presets: ${presets.presetNames().join(', ')}; or use --custom`);
  const entry = name === 'antigravity'
    ? antigravityEntry(parsed, context)
    : presets.providerFromPreset(name, { region: parsed.option('--region') || null });
  applyCommonOptions(entry, parsed, readKeyFromStdin(parsed, context));
  if (preset.requiresTerms === 'google') {
    const previous = list.find((existing) => existing?.id === entry.id);
    const termsAccepted = context.termsAccepted || await acceptGoogleTerms(parsed, previous, context);
    if (!termsAccepted) {
      throw Object.assign(new Error('Antigravity was not added: the Google terms risk was not accepted. Re-run with --accept-google-terms to accept it.'), { exitCode: EXIT.action });
    }
    entry.termsAccepted = termsAccepted;
  }
  return entry;
}

function keyStatus(provider, env) {
  const { source } = registry.resolveApiKey(provider, { env });
  if (source) return `key from ${source}`;
  if (!provider.apiKey && !provider.apiKeyEnv && !provider.apiKeyFile) return 'no key configured (local endpoint)';
  return `key MISSING (${provider.apiKeyEnv ? `set ${provider.apiKeyEnv}` : provider.apiKeyFile ? `expected in ${provider.apiKeyFile}` : 'none stored'})`;
}

function pickerIds(provider) {
  const { gatewayClientModelId } = require('./runtime.js');
  return registry.providerCatalogEntries(provider).map((entry) => gatewayClientModelId(`claude-${entry.backendId}`));
}

async function addProvider(parsed, context) {
  const config = registry.readProviderConfig({ file: context.file });
  if (config.errors.length && config.exists && !config.raw.length) throw new Error(`${config.errors[0]}; fix or remove it first`);
  const entry = await buildEntry(parsed.positionals[1], parsed, { ...context, list: config.raw });
  const provider = registry.validateProvider(entry);
  const replaced = config.raw.some((existing) => existing?.id === provider.id);
  registry.writeProviderList(upsert(config.raw, entry), { file: context.file });
  context.out(`${replaced ? 'updated' : 'added'} provider ${provider.id} (${provider.name}) at ${provider.baseUrl}; ${keyStatus(provider, context.env)}`);
  const ids = pickerIds(provider);
  context.out(ids.length ? `picker ids: ${ids.join(', ')}` : 'models: listed from the provider once it answers /v1/models');
  return { provider, replaced, previous: replaced ? config.raw : null, previousList: config.raw };
}

function removeProvider(id, context) {
  const config = registry.readProviderConfig({ file: context.file });
  if (!config.raw.some((entry) => entry?.id === id)) {
    context.out(`no provider ${id}; nothing to remove`);
    return false;
  }
  registry.writeProviderList(config.raw.filter((entry) => entry?.id !== id), { file: context.file });
  const provider = config.providers.find((entry) => entry.id === id);
  if (provider) registry.removeModelsCache(provider);
  context.out(`removed provider ${id}`);
  return true;
}

function listProviders(parsed, context) {
  const config = registry.readProviderConfig({ file: context.file });
  if (parsed.flags.has('--json')) {
    context.out(JSON.stringify({
      file: config.file,
      errors: config.errors,
      providers: config.providers.map((provider) => ({
        id: provider.id, name: provider.name, baseUrl: provider.baseUrl, preset: provider.preset || null,
        key: keyStatus(provider, context.env), pickerIds: pickerIds(provider),
      })),
    }, null, 2));
    return;
  }
  if (!config.providers.length && !config.errors.length) context.out(`no providers configured (${config.file})`);
  for (const provider of config.providers) {
    context.out(`${provider.id}  ${provider.name}  ${provider.baseUrl}  ${keyStatus(provider, context.env)}`);
    const ids = pickerIds(provider);
    context.out(`  models: ${ids.length ? ids.join(', ') : 'not listed yet (run provider test)'}`);
  }
  for (const error of config.errors) context.out(`invalid: ${error}`);
}

function authFailed(status) {
  return status === 401 || status === 403;
}

function detailOf(response, key) {
  try {
    const parsed = JSON.parse(response.body.toString());
    return redact(parsed?.error?.message || parsed?.message || '', key).slice(0, 300);
  } catch { return redact(response.body.toString(), key).replace(/\s+/g, ' ').slice(0, 200); }
}

async function waitForAnswer(provider, request, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    const result = await registry.fetchProviderModels(provider, { request, timeout: 1500 });
    if (!result.unreachable) return result;
  }
  return null;
}

// Connectivity and key check that spends no tokens: the model list, then count_tokens. Only --live sends
// a 1-token message.
async function testProvider(provider, { request = registry.requestProvider, env = process.env, live = false, autostart = null } = {}) {
  const { key } = registry.resolveApiKey(provider, { env });
  const headers = { 'anthropic-version': '2023-06-01', ...registry.providerAuthHeaders(provider, key) };
  const result = { id: provider.id, ok: false, reachable: false, auth: 'unchecked', models: null, detail: '' };
  if ((provider.apiKey || provider.apiKeyEnv || provider.apiKeyFile) && !key) {
    return { ...result, detail: registry.missingKeyHint(provider) };
  }
  let listed = await registry.fetchProviderModels(provider, { request, env });
  if (listed.unreachable && provider.autostart && autostart) {
    const started = autostart(provider);
    if (started.started) listed = (await waitForAnswer(provider, request)) || listed;
  }
  if (listed.unreachable) return { ...result, detail: `not answering at ${provider.baseUrl} (${listed.error}).${registry.autostartHint(provider, null)}` };
  result.reachable = true;
  if (listed.ok) {
    result.models = listed.models.length;
    if (provider.modelsFrom === 'list') registry.writeModelsCache(provider, listed.models);
    if (provider.modelsFrom === 'list' && !listed.models.length) {
      return { ...result, auth: 'ok', detail: `the model list is empty${provider.ownedBy ? ` for owned_by "${provider.ownedBy}"` : ''}; is the account signed in?` };
    }
    return { ...result, ok: true, auth: 'ok', detail: `${listed.models.length} models listed` };
  }
  if (authFailed(listed.status)) return { ...result, auth: 'failed', detail: `the provider refused the key (HTTP ${listed.status})` };
  const model = registry.providerModels(provider)[0]?.id;
  if (!model) return { ...result, detail: `GET /v1/models returned HTTP ${listed.status} and no model is configured` };
  const message = { model, messages: [{ role: 'user', content: 'ping' }] };
  const counted = await request(`${provider.baseUrl}/v1/messages/count_tokens`, { method: 'POST', headers, body: JSON.stringify(message) }).catch((error) => ({ error }));
  if (counted.status === 200) return { ...result, ok: true, auth: 'ok', detail: 'key accepted (count_tokens)' };
  if (authFailed(counted.status)) return { ...result, auth: 'failed', detail: `the provider refused the key (HTTP ${counted.status}): ${detailOf(counted, key)}` };
  if (!live) return { ...result, ok: true, detail: 'reachable; the key cannot be checked without spending tokens (re-run with --live to send a 1-token request)' };
  const sent = await request(`${provider.baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ ...message, max_tokens: 1 }), timeout: 60000 }).catch((error) => ({ error }));
  if (sent.status === 200) return { ...result, ok: true, auth: 'ok', detail: `key accepted (1-token request to ${model})` };
  if (authFailed(sent.status)) return { ...result, auth: 'failed', detail: `the provider refused the key (HTTP ${sent.status}): ${detailOf(sent, key)}` };
  return { ...result, detail: `test request failed: ${sent.error ? sent.error.message : `HTTP ${sent.status}: ${detailOf(sent, key)}`}` };
}

function findProvider(id, context) {
  const config = registry.readProviderConfig({ file: context.file });
  const provider = config.providers.find((entry) => entry.id === id);
  if (!provider) {
    const invalid = config.errors.find((error) => error.includes(`provider ${id}`));
    throw new Error(invalid ? `provider ${id} is invalid: ${invalid}` : `no provider ${id}; see provider list`);
  }
  return provider;
}

function reportTest(result, context, json = false) {
  if (json) context.out(JSON.stringify(result));
  else context.out(`${result.id}: ${result.ok ? 'OK' : 'FAILED'}: ${result.detail}`);
}

async function providerCommand(argv, context) {
  const parsed = parseArgs(argv);
  const [sub, target] = parsed.positionals;
  if (sub === 'list' || !sub) return listProviders(parsed, context);
  if (sub === 'add') {
    await addProvider(parsed, context);
    if (context.refreshGateway) await context.refreshGateway({ wire: false });
    return EXIT.ok;
  }
  if (sub === 'remove') {
    if (!target) throw usageError('provider remove needs an id');
    if (removeProvider(target, context) && context.refreshGateway) await context.refreshGateway({ wire: false });
    return EXIT.ok;
  }
  if (sub === 'test') {
    if (!target) throw usageError('provider test needs an id');
    const result = await testProvider(findProvider(target, context), { ...context, live: parsed.flags.has('--live') });
    reportTest(result, context, parsed.flags.has('--json'));
    return result.ok ? EXIT.ok : EXIT.failed;
  }
  throw usageError(`unknown provider subcommand ${sub}; use list, add, remove or test`);
}

// ------------------------------------------------------------- connect

function presetForConnection(name) {
  return presets.presetByName(name) ? name : null;
}

function providerIdForConnection(name) {
  return presets.presetByName(name)?.id || name;
}

function needKeyMessage(entry) {
  return [
    `${entry.name} needs an API key. Either:`,
    `  - set ${entry.apiKeyEnv} in your environment (preferred; the key is never written to disk), restart Claude Code, and run this again; or`,
    '  - pass it on stdin with --api-key-stdin; it is stored in providers.json (readable only by you).',
  ].join('\n');
}

async function connectApiKeyPreset(name, parsed, context) {
  const preview = presets.providerFromPreset(name, { region: parsed.option('--region') || null });
  if (parsed.option('--api-key-env')) preview.apiKeyEnv = parsed.option('--api-key-env');
  if (!parsed.flags.has('--api-key-stdin') && !context.env[preview.apiKeyEnv] && !hasStoredKey(preview.id, context)) {
    context.out(needKeyMessage(preview));
    return EXIT.action;
  }
  const added = await addProvider({ ...parsed, positionals: ['add', name] }, context);
  const result = await testProvider(added.provider, context);
  reportTest(result, context);
  if (!result.ok) {
    registry.writeProviderList(added.previousList, { file: context.file });
    context.out(`${added.provider.name} was not enabled; providers.json is unchanged.`);
    return result.auth === 'failed' ? EXIT.action : EXIT.failed;
  }
  return finishConnect(added.provider, context);
}

function hasStoredKey(id, context) {
  const existing = registry.readProviderConfig({ file: context.file }).providers.find((provider) => provider.id === id);
  return Boolean(existing?.apiKey);
}

async function connectAntigravity(parsed, context) {
  const { cliproxy } = context;
  const config = registry.readProviderConfig({ file: context.file });
  const previous = config.raw.find((entry) => entry?.id === 'agy');
  const terms = await acceptGoogleTerms(parsed, previous, context);
  if (!terms) {
    context.out('Antigravity was not connected: the Google terms risk was not accepted. Re-run with --accept-google-terms to accept it.');
    return EXIT.action;
  }
  const external = fs.existsSync(presets.ANTIGRAVITY_CONNECTION_FILE);
  if (!external) {
    if (!cliproxy.installed()) {
      if (parsed.flags.has('--no-install')) {
        context.out(`CLIProxyAPI is not installed. Re-run without --no-install to download it from github.com/${cliproxy.REPO} (checksum-verified).`);
        return EXIT.action;
      }
      context.out(`downloading CLIProxyAPI from github.com/${cliproxy.REPO}...`);
      await cliproxy.install({ fetchUrl: context.fetchUrl, log: context.out });
    }
    cliproxy.writeManagedConfig();
    if (!cliproxy.hasAntigravityLogin()) {
      context.out('Opening the Antigravity sign-in in your browser (CLIProxyAPI -antigravity-login). Finish it there; this waits for the callback.');
      const login = cliproxy.login({ noBrowser: parsed.flags.has('--no-browser') });
      if (!login.ok || !cliproxy.hasAntigravityLogin()) {
        context.out('The Antigravity sign-in did not finish. Run /connect-antigravity again to retry.');
        return EXIT.action;
      }
    }
  }
  const { provider } = await addProvider({ ...parsed, positionals: ['add', 'antigravity'] }, { ...context, termsAccepted: terms });
  context.out(`Google terms risk acceptance recorded on ${terms.google.acceptedAt}.`);
  const answering = !(await registry.fetchProviderModels(provider, { request: context.request, timeout: 1500 })).unreachable;
  if (!external && provider.autostart && !answering) {
    context.out('starting the local CLIProxyAPI...');
    try { cliproxy.launch(); } catch (error) { context.out(`could not start CLIProxyAPI: ${error.message}`); }
  }
  const request = external ? context.request : retryingRequest(context.request);
  const result = await testProvider(provider, { ...context, request });
  reportTest(result, context);
  if (!result.ok) {
    context.out(external
      ? `Your existing CLIProxyAPI at ${provider.baseUrl} did not list Antigravity models. Start it and sign in to Antigravity there, then run /connect-antigravity again.`
      : `The local CLIProxyAPI did not answer as expected. See ${cliproxy.LOG}, then run /connect-antigravity again.`);
    return EXIT.failed;
  }
  return finishConnect(provider, context);
}

// The proxy needs a few seconds after launch before it answers.
function retryingRequest(request = registry.requestProvider) {
  return async (url, options) => {
    let lastError;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { return await request(url, options); } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
    throw lastError;
  };
}

async function finishConnect(provider, context) {
  const gateway = context.refreshGateway ? await context.refreshGateway({ wire: true, providerId: provider.id }) : null;
  const ids = pickerIds(provider);
  context.out(`Connected ${provider.name}${ids.length ? `: ${ids.length} model${ids.length === 1 ? '' : 's'} (${ids.join(', ')})` : ''}.`);
  if (gateway && !gateway.ok) {
    context.out(`The gateway is not running yet: ${gateway.reason}. Run /connect to check, or the doctor command.`);
    return EXIT.failed;
  }
  context.out('Next: fully restart Claude Code, then open /model and pick a row marked "From gateway".');
  return EXIT.ok;
}

async function connectBuiltin(name, parsed, context) {
  if (name === 'gpt') return context.connectGpt(parsed);
  const grok = context.grokReadiness();
  if (!grok.ready) {
    context.out(`Grok is not signed in (${grok.message}). Run \`grok\` in a terminal and complete its login, then run /connect-grok again.`);
    return EXIT.action;
  }
  setBuiltin('grok', { connectedAt: new Date().toISOString() });
  const gateway = context.refreshGateway ? await context.refreshGateway({ wire: true }) : null;
  context.out('Connected Grok (claude-grok-* models).');
  if (gateway && !gateway.ok) {
    context.out(`The gateway is not running yet: ${gateway.reason}.`);
    return EXIT.failed;
  }
  context.out('Next: fully restart Claude Code, then open /model.');
  return EXIT.ok;
}

function setBuiltin(name, value) {
  registry.writeConnections({ ...registry.readConnections(), [name]: value });
}

async function connectCommand(argv, context) {
  const parsed = parseArgs(argv);
  const name = parsed.positionals[0];
  if (!name) return connectionsCommand(argv, context);
  if (BUILTINS[name]) return connectBuiltin(name, parsed, context);
  if (name === 'antigravity') return connectAntigravity(parsed, context);
  if (presetForConnection(name)) return connectApiKeyPreset(name, parsed, context);
  throw usageError(`unknown connection ${name}; available: ${[...Object.keys(BUILTINS), ...presets.presetNames()].join(', ')} (custom endpoints: provider add --custom)`);
}

async function disconnectCommand(argv, context) {
  const parsed = parseArgs(argv);
  const name = parsed.positionals[0];
  if (!name) throw usageError('disconnect needs a connection name; run connect to list them');
  if (BUILTINS[name]) {
    setBuiltin(name, { disabled: true, disconnectedAt: new Date().toISOString() });
    context.out(`Disconnected ${BUILTINS[name].name}: its rows leave /model. Your ${name === 'gpt' ? 'ChatGPT' : 'Grok'} login was left in place.`);
  } else if (!removeProvider(providerIdForConnection(name), context)) {
    return EXIT.ok;
  }
  if (name === 'antigravity') context.out('A Code Team-managed CLIProxyAPI keeps its Antigravity login; delete ~/.claude/code-team/cliproxyapi to remove it.');
  if (context.refreshGateway) await context.refreshGateway({ wire: false });
  context.out('Next: fully restart Claude Code so /model drops the rows.');
  return EXIT.ok;
}

function providerConnectionStatus(provider, env) {
  if (!provider) return 'not connected';
  return `connected; ${keyStatus(provider, env)}`;
}

async function connectionsCommand(argv, context) {
  const config = registry.readProviderConfig({ file: context.file });
  const byId = new Map(config.providers.map((provider) => [provider.id, provider]));
  const rows = [
    ['gpt', BUILTINS.gpt.name, context.gptStatus(), BUILTINS.gpt.command],
    ['grok', BUILTINS.grok.name, context.grokStatus(), BUILTINS.grok.command],
    ...presets.presetNames().map((name) => {
      const preset = presets.presetByName(name);
      return [name, preset.name, providerConnectionStatus(byId.get(preset.id), context.env), `/connect-${name}`];
    }),
    ...config.providers.filter((provider) => !presets.presetById(provider.id)).map((provider) => [provider.id, provider.name, `connected (custom); ${keyStatus(provider, context.env)}`, 'provider test ' + provider.id]),
  ];
  const width = Math.max(...rows.map((row) => row[0].length));
  const nameWidth = Math.max(...rows.map((row) => row[1].length));
  context.out('Code Team connections:');
  for (const [id, name, status, command] of rows) context.out(`  ${id.padEnd(width)}  ${name.padEnd(nameWidth)}  ${status}   (${command})`);
  for (const error of config.errors) context.out(`  invalid providers.json entry: ${error}`);
  if (context.gatewayStatus) context.out(await context.gatewayStatus());
  return EXIT.ok;
}

module.exports = {
  EXIT, acceptGoogleTerms, connectCommand, connectionsCommand, disconnectCommand, parseArgs, providerCommand, testProvider,
};
