'use strict';

// Forwards an Anthropic Messages request to a registered provider. The body is
// passed through with only `model` replaced; outgoing headers are built from an
// allowlist, so the client's Anthropic/claude.ai credentials, cookies and
// anthropic-beta headers never reach a third party.

const http = require('node:http');
const https = require('node:https');
const { StringDecoder } = require('node:string_decoder');
const registry = require('./providers.js');
const quota = require('./provider-quota.js');

const HOP_BY_HOP = ['transfer-encoding', 'connection', 'keep-alive', 'content-length'];
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_JSON_USAGE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_SSE_BYTES = 1024 * 1024;
const RESTARTABLE_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET']);
const ERROR_TYPES = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 529: 'overloaded_error' };

function errorType(status) {
  return ERROR_TYPES[status] || (status >= 500 ? 'api_error' : 'invalid_request_error');
}

function sendError(res, status, type, message) {
  const body = JSON.stringify({ type: 'error', error: { type, message } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function hasConfiguredKey(provider) {
  return Boolean(provider.apiKey || provider.apiKeyEnv || provider.apiKeyFile);
}

// Google's Antigravity backend answers a system prompt carrying a known third-party coding-agent
// fingerprint with a false "429 Resource has been exhausted (e.g. check quota)" while the quota is
// untouched (router-for-me/CLIProxyAPI#7049, #5790, #4696). Claude Code's subagents open with "You are
// a Claude agent, built on Anthropic's Claude Agent SDK.", so every subagent on an Antigravity model
// failed that way and was then recorded here as an exhausted quota. The official Antigravity client never
// sends such phrases. A zero-width space after the first character defeats the exact-phrase check, the
// same technique as CLIProxyAPI's sensitive-words option; only system blocks are touched, never user or
// tool content. The list is limited to phrases with public reproduction evidence.
const ANTIGRAVITY_FINGERPRINTS = ['Claude Agent SDK', 'system-conventions', 'system_conventions', 'system-directive', 'system_directive', 'RFC 2119'];
const FINGERPRINT_RE = new RegExp(ANTIGRAVITY_FINGERPRINTS.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
const ZERO_WIDTH_SPACE = '\u200B';

function maskFingerprints(text) {
  return text.replace(FINGERPRINT_RE, (word) => word[0] + ZERO_WIDTH_SPACE + word.slice(1));
}

function maskSystemFingerprints(system) {
  if (typeof system === 'string') return maskFingerprints(system);
  if (!Array.isArray(system)) return system;
  return system.map((block) => (block?.type === 'text' && typeof block.text === 'string' ? { ...block, text: maskFingerprints(block.text) } : block));
}

function isAntigravity(provider) {
  return provider.id === 'agy' || String(provider.preset || '').startsWith('antigravity');
}

function upstreamHeaders(clientHeaders, provider, key, bodyLength) {
  return {
    'content-type': 'application/json',
    'content-length': bodyLength,
    accept: typeof clientHeaders.accept === 'string' ? clientHeaders.accept : 'application/json',
    'anthropic-version': typeof clientHeaders['anthropic-version'] === 'string' ? clientHeaders['anthropic-version'] : '2023-06-01',
    'user-agent': 'code-team',
    ...registry.providerAuthHeaders(provider, key),
  };
}

// Anthropic streams carry input usage on message_start and the final counts on message_delta;
// several compatible providers put input tokens only on the first, so the two are merged.
function createUsageObserver(onUsage) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let startUsage = null;
  function handle(data) {
    if (!data.includes('message_start') && !data.includes('message_delta')) return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (event.type === 'message_start') startUsage = event.message?.usage || null;
    else if (event.type === 'message_delta') onUsage({ ...startUsage, ...event.usage }, event.delta?.stop_reason ?? null);
  }
  return function observe(chunk) {
    pending += decoder.write(chunk);
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line.startsWith('data:')) handle(line.slice(5).trim());
    }
    if (pending.length > MAX_PENDING_SSE_BYTES) pending = '';
  };
}

function collect(stream, limit, done) {
  const chunks = [];
  let size = 0;
  stream.on('data', (chunk) => {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  });
  stream.once('end', () => done(Buffer.concat(chunks), size > limit));
  stream.once('error', () => done(Buffer.concat(chunks), true));
}

function isJson(headers) {
  return /json/i.test(String(headers['content-type'] || ''));
}

// Most compatible endpoints do not implement count_tokens; Claude Code only needs an estimate.
function answerTokenEstimate(clientRes, body) {
  const estimate = JSON.stringify({ input_tokens: Math.ceil(Buffer.byteLength(body) / 4) });
  clientRes.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(estimate), 'x-code-team-estimate': '1' });
  clientRes.end(estimate);
}

function wrapNonJsonError(clientRes, provider, status, text) {
  const detail = text.replace(/\s+/g, ' ').trim().slice(0, 500);
  sendError(clientRes, status, errorType(status), `Code Team: ${provider.name} returned HTTP ${status}${detail ? `: ${detail}` : ' with an empty body'}`);
}

function relayResponse(upstream, clientRes, { onUsage }) {
  const headers = { ...upstream.headers };
  for (const header of HOP_BY_HOP) delete headers[header];
  clientRes.writeHead(upstream.statusCode, headers);
  if (onUsage && upstream.statusCode === 200) {
    if (/event-stream/i.test(String(upstream.headers['content-type'] || ''))) {
      const observe = createUsageObserver(onUsage);
      upstream.on('data', observe);
    } else if (isJson(upstream.headers)) {
      collect(upstream, MAX_JSON_USAGE_BYTES, (body, truncated) => {
        if (truncated) return;
        try {
          const message = JSON.parse(body.toString());
          if (message?.usage) onUsage(message.usage, message.stop_reason ?? null);
        } catch {}
      });
    }
  }
  upstream.pipe(clientRes);
  upstream.once('error', () => clientRes.destroy());
}

// A quota rejection is recorded and answered as a usage limit (see provider-quota.js); any other error is
// relayed as the provider sent it.
function relayErrorOrQuota(upstream, clientRes, { provider, model, pickerModel, sessionId, payload, onQuota }) {
  collect(upstream, MAX_ERROR_BODY_BYTES, (body) => {
    const status = upstream.statusCode;
    const text = body.toString();
    const verdict = quota.classifyQuota({ status, headers: upstream.headers, body: text });
    if (verdict) {
      onQuota();
      return quota.sendQuotaResponse(clientRes, quota.recordQuota({ provider, model, pickerModel, quota: verdict, sessionId, payload }));
    }
    if (!isJson(upstream.headers)) return wrapNonJsonError(clientRes, provider, status, text);
    const headers = { ...upstream.headers, 'content-length': body.length };
    for (const header of HOP_BY_HOP.filter((name) => name !== 'content-length')) delete headers[header];
    clientRes.writeHead(status, headers);
    clientRes.end(body);
  });
}

function forwardProvider({
  clientReq, clientRes, pathOnly, query = '', payload, route, sessionId = null,
  agents = {}, autostart = null, onUsage = null, onFinish = () => {}, env = process.env, timeoutMs = 3600000,
}) {
  const { provider, model } = route;
  const pickerModel = typeof payload.model === 'string' ? payload.model : null;
  const countTokens = pathOnly.endsWith('/count_tokens');
  const blocked = countTokens ? null : quota.activeBlock(provider.id, model);
  if (blocked) {
    onFinish(429, 'provider_quota_blocked');
    return quota.sendQuotaResponse(clientRes, quota.recordQuota({
      provider, model, pickerModel, sessionId, payload,
      quota: { status: blocked.status, resetAtMs: blocked.resetKnown ? blocked.untilMs : null, detail: blocked.detail },
    }));
  }
  const { key } = registry.resolveApiKey(provider, { env });
  if (hasConfiguredKey(provider) && !key) {
    onFinish(401, 'provider_key_missing');
    return sendError(clientRes, 401, 'authentication_error', `Code Team: ${registry.missingKeyHint(provider)}.`);
  }
  const system = isAntigravity(provider) && payload.system !== undefined ? { system: maskSystemFingerprints(payload.system) } : null;
  const body = JSON.stringify({ ...payload, ...system, model });
  const target = new URL(provider.baseUrl + pathOnly + query);
  const secure = target.protocol === 'https:';
  const request = (secure ? https : http).request(target, {
    method: 'POST',
    headers: upstreamHeaders(clientReq.headers, provider, key, Buffer.byteLength(body)),
    agent: secure ? agents.https : agents.http,
  }, (upstream) => {
    const status = upstream.statusCode;
    let quotaHit = false;
    // Deferred one tick: an error body is classified by an 'end' listener added after this one.
    upstream.once('end', () => setImmediate(() => onFinish(quotaHit ? 429 : status, quotaHit ? 'provider_quota' : undefined)));
    if (countTokens && [404, 405, 501].includes(status)) {
      upstream.resume();
      return answerTokenEstimate(clientRes, body);
    }
    if (!countTokens && (status === 429 || status === 402)) {
      return relayErrorOrQuota(upstream, clientRes, { provider, model, pickerModel, sessionId, payload, onQuota: () => { quotaHit = true; } });
    }
    if (status >= 400 && !isJson(upstream.headers)) {
      return collect(upstream, MAX_ERROR_BODY_BYTES, (text) => wrapNonJsonError(clientRes, provider, status, text.toString()));
    }
    if (status === 200 && !countTokens) quota.clearQuota({ providerId: provider.id, model, sessionId });
    relayResponse(upstream, clientRes, { onUsage: countTokens ? null : onUsage });
  });
  request.setTimeout(timeoutMs, () => request.destroy(new Error(`${provider.name} upstream timeout`)));
  clientRes.once('close', () => { if (!clientRes.writableFinished) request.destroy(); });
  request.on('error', (error) => {
    onFinish(502, 'upstream_error');
    if (clientRes.headersSent) return clientRes.destroy();
    const restartable = RESTARTABLE_ERRORS.has(error.code);
    const hint = restartable ? registry.autostartHint(provider, provider.autostart && autostart ? autostart(provider) : null) : '';
    const reason = restartable ? `is not answering at ${provider.baseUrl} (${error.code})` : `request failed (${error.code || error.message})`;
    sendError(clientRes, 502, 'api_error', `Code Team: ${provider.name} ${reason}.${hint}`);
  });
  request.end(body);
}

module.exports = { createUsageObserver, errorType, forwardProvider, maskSystemFingerprints, upstreamHeaders };
