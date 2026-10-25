'use strict';

// Quota exhaustion on a registered provider. Claude Code retries a plain 429 for minutes, burning what is
// left of a per-minute budget, and says "not your usage limit". A quota rejection is answered instead the
// way Anthropic answers a subscription limit (x-should-retry: false plus the unified rate-limit headers), so
// Claude Code stops at once, shows "You've hit your usage limit · resets <time>" and keeps the conversation.
// The model stays blocked here until its reset, and the interrupted session is recorded so the next session
// start can say the quota is back and how to resume it.

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomically } = require('./atomic-file.js');
const { STATE } = require('./providers.js');

const QUOTA_PATH = path.join(STATE, 'provider-quota.json');
// A quota 429 that names no reset still blocks briefly, so a burst of agent requests fails fast.
const UNKNOWN_RESET_BLOCK_MS = 5 * 60_000;
// A 429 whose wait is shorter than this is ordinary throttling: Claude Code's own retry handles it.
const QUOTA_MIN_WAIT_MS = 60_000;
const MAX_INTERRUPTIONS = 20;
const TASK_CHARS = 160;
const QUOTA_TEXT = /quota|exhausted|usage.?limit|limit (?:reached|exceeded)|insufficient|balance|credits?\b|billing|cooling down|RESOURCE_EXHAUSTED/i;

function retryAfterMs(value, now) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : null;
}

// "1h2m3.5s", "20ms", "37s": OpenAI-style reset durations and Google RetryInfo delays.
function durationMs(text) {
  const match = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(String(text).trim());
  if (!match || !match.slice(1).some(Boolean)) return null;
  const [, h = 0, m = 0, s = 0, ms = 0] = match;
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
}

function epochMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number > 1e12 ? number : number * 1000;
}

function resetFromHeaders(headers, now) {
  const header = (name) => (typeof headers[name] === 'string' ? headers[name] : null);
  const candidates = [
    retryAfterMs(header('retry-after'), now),
    epochMs(header('anthropic-ratelimit-unified-reset')),
    ...['anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-reset', 'anthropic-ratelimit-input-tokens-reset']
      .map((name) => (header(name) ? Date.parse(header(name)) : null)),
    ...['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens'].map((name) => {
      const wait = header(name) && durationMs(header(name));
      return wait == null ? null : now + wait;
    }),
    epochMs(header('x-ratelimit-reset')),
  ].filter((value) => Number.isFinite(value) && value > now);
  return candidates.length ? Math.max(...candidates) : null;
}

function resetFromBody(text, now) {
  // CLIProxyAPI: "Individual quota reached. ... Resets in 51h41m21s."
  const delay = /"retryDelay"\s*:\s*"([^"]+)"/.exec(text) || /(?:retry|try again|reset)s?\s+(?:in|after)\s+(\d[\d.hms]*[hms])\b/i.exec(text);
  const wait = delay && durationMs(delay[1]);
  if (wait) return now + wait;
  const at = /resets?\s+at\s+"?([0-9T:.\-+Z ]{10,})/i.exec(text);
  const date = at && Date.parse(at[1]);
  return Number.isFinite(date) && date > now ? date : null;
}

function errorDetail(text) {
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message || parsed?.message;
    if (typeof message === 'string') return message.replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {}
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 300);
}

// null for anything that is not a quota rejection; a short 429 stays Claude Code's to retry.
function classifyQuota({ status, headers = {}, body = '', now = Date.now() }) {
  if (status !== 429 && status !== 402) return null;
  const text = String(body);
  const resetAtMs = resetFromHeaders(headers, now) ?? resetFromBody(text, now);
  const quotaWords = QUOTA_TEXT.test(text);
  if (status === 429 && !quotaWords && !(resetAtMs && resetAtMs - now >= QUOTA_MIN_WAIT_MS)) return null;
  return { status, resetAtMs, detail: errorDetail(text) };
}

function readState(file = QUOTA_PATH) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { blocks: state.blocks || {}, interruptions: Array.isArray(state.interruptions) ? state.interruptions : [] };
  } catch { return { blocks: {}, interruptions: [] }; }
}

function writeState(state, file = QUOTA_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomically(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

function blockKey(providerId, model) {
  return `${providerId}/${model}`;
}

function activeBlock(providerId, model, { now = Date.now(), file = QUOTA_PATH } = {}) {
  const block = readState(file).blocks[blockKey(providerId, model)];
  return block && block.untilMs > now ? block : null;
}

// The last real user text in the request: what the model was asked to do when the quota ran out.
function currentTask(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    const text = (Array.isArray(parts) ? parts : [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string' && !part.text.startsWith('<system-reminder>'))
      .map((part) => part.text).join(' ').replace(/\s+/g, ' ').trim();
    if (text) return text.length > TASK_CHARS ? `${text.slice(0, TASK_CHARS - 1)}…` : text;
  }
  return null;
}

function recordQuota({ provider, model, pickerModel, quota, sessionId = null, payload = null, now = Date.now(), file = QUOTA_PATH }) {
  const state = readState(file);
  const untilMs = quota.resetAtMs || now + UNKNOWN_RESET_BLOCK_MS;
  const block = {
    provider: provider.id, providerName: provider.name, model, pickerModel, status: quota.status,
    observedAt: new Date(now).toISOString(), untilMs, resetKnown: Boolean(quota.resetAtMs), detail: quota.detail,
  };
  state.blocks[blockKey(provider.id, model)] = block;
  if (sessionId) {
    const previous = state.interruptions.find((entry) => entry.sessionId === sessionId);
    const interruption = {
      sessionId, provider: provider.id, providerName: provider.name, model, pickerModel,
      interruptedAt: previous?.interruptedAt || block.observedAt, untilMs, resetKnown: block.resetKnown,
      task: currentTask(payload) || previous?.task || null,
    };
    state.interruptions = [interruption, ...state.interruptions.filter((entry) => entry.sessionId !== sessionId)].slice(0, MAX_INTERRUPTIONS);
  }
  writeState(state, file);
  return block;
}

// A completed request proves the quota is back for that model, and resumes that session's record.
function clearQuota({ providerId, model, sessionId = null, file = QUOTA_PATH }) {
  const state = readState(file);
  const key = blockKey(providerId, model);
  const hadBlock = key in state.blocks;
  delete state.blocks[key];
  const before = state.interruptions.length;
  if (sessionId) state.interruptions = state.interruptions.filter((entry) => entry.sessionId !== sessionId);
  if (hadBlock || state.interruptions.length !== before) writeState(state, file);
}

function dismissInterruptions({ sessionId = null, file = QUOTA_PATH } = {}) {
  const state = readState(file);
  const before = state.interruptions.length;
  state.interruptions = sessionId ? state.interruptions.filter((entry) => entry.sessionId !== sessionId) : [];
  writeState(state, file);
  return before - state.interruptions.length;
}

function clockTime(ms) {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function quotaMessage(block) {
  const until = block.resetKnown ? `until ${clockTime(block.untilMs)}` : 'and the provider did not say when it resets';
  return `Code Team: the ${block.providerName} quota for ${block.model} is exhausted ${until}. `
    + `Your conversation is saved: pick another model with /model, or come back ${block.resetKnown ? 'then' : 'later'} and say "continue".`
    + (block.detail ? ` Provider said: ${block.detail}` : '');
}

// Anthropic's subscription-limit shape. Claude Code shows its native limit line only when the reset is known;
// without one it shows this message after "API Error", and either way it does not retry.
function sendQuotaResponse(res, block) {
  const body = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: quotaMessage(block) } });
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-should-retry': 'false',
    'x-code-team-quota': block.provider,
  };
  if (block.resetKnown) {
    Object.assign(headers, {
      'retry-after': String(Math.max(1, Math.ceil((block.untilMs - Date.now()) / 1000))),
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': String(Math.ceil(block.untilMs / 1000)),
      'anthropic-ratelimit-unified-representative-claim': 'overage',
    });
  }
  res.writeHead(429, headers);
  res.end(body);
}

// Session-start lines: models still blocked, and sessions whose quota is back with the command to resume them.
function quotaNotices({ now = Date.now(), file = QUOTA_PATH, belongsHere = () => true } = {}) {
  const state = readState(file);
  const lines = [];
  for (const block of Object.values(state.blocks)) {
    if (block.untilMs > now && block.resetKnown) lines.push(`${block.pickerModel || block.model} (${block.providerName}) is out of quota until ${clockTime(block.untilMs)}.`);
  }
  for (const entry of state.interruptions) {
    if (entry.untilMs > now || !belongsHere(entry.sessionId)) continue;
    const task = entry.task ? ` while working on "${entry.task}"` : '';
    lines.push(`The ${entry.providerName} quota for ${entry.model} is back. A session stopped at ${clockTime(Date.parse(entry.interruptedAt))}${task}: run \`claude --resume ${entry.sessionId}\` and say "continue".`);
  }
  return lines;
}

module.exports = {
  QUOTA_PATH, activeBlock, classifyQuota, clearQuota, currentTask, dismissInterruptions, durationMs, quotaMessage,
  quotaNotices, readState, recordQuota, sendQuotaResponse,
};
