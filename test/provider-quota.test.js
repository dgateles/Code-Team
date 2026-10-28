'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const quota = require('../lib/provider-quota.js');
const { forwardProvider } = require('../lib/provider-backend.js');
const { EXIT, quotaCommand } = require('../lib/provider-commands.js');

const NOW = Date.parse('2026-10-25T20:00:00.000Z');
const PROVIDER = { id: 'agy', name: 'Antigravity', baseUrl: 'http://127.0.0.1:1', authStyle: 'x-api-key', headers: {} };

function tempQuotaFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-team-quota-'));
  return path.join(directory, 'provider-quota.json');
}

test('quota rejections are told apart from ordinary throttling, with the reset wherever the provider puts it', () => {
  // CLIProxyAPI with an exhausted Antigravity group: no headers, the reset only in the text.
  const cliproxy = quota.classifyQuota({
    status: 429, now: NOW,
    body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 51h41m21s.' } }),
  });
  assert.equal(cliproxy.resetAtMs, NOW + ((51 * 60 + 41) * 60 + 21) * 1000);
  assert.match(cliproxy.detail, /^Individual quota reached/);

  assert.equal(quota.classifyQuota({ status: 429, headers: { 'retry-after': '7200' }, body: '{}', now: NOW }).resetAtMs, NOW + 7200_000);
  assert.equal(quota.classifyQuota({ status: 429, headers: { 'x-ratelimit-reset-tokens': '6m0s' }, body: '{}', now: NOW }).resetAtMs, NOW + 360_000);
  assert.equal(quota.classifyQuota({ status: 429, body: '{"error":{"details":[{"retryDelay":"90s"}],"message":"RESOURCE_EXHAUSTED"}}', now: NOW }).resetAtMs, NOW + 90_000);
  const unknownReset = quota.classifyQuota({ status: 429, body: '{"error":{"message":"Resource has been exhausted (e.g. check quota)."}}', now: NOW });
  assert.equal(unknownReset.resetAtMs, null);
  assert.equal(quota.classifyQuota({ status: 402, body: '{"error":{"message":"Insufficient Balance"}}', now: NOW }).status, 402);

  // A short, wordless 429 stays Claude Code's to retry.
  assert.equal(quota.classifyQuota({ status: 429, headers: { 'retry-after': '5' }, body: '{"error":{"message":"slow down"}}', now: NOW }), null);
  // Google's per-minute limit also says RESOURCE_EXHAUSTED; a reset under a minute is throttling, not a quota.
  assert.equal(quota.classifyQuota({ status: 429, body: '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"30s"}],"message":"Quota exceeded for quota metric Requests per minute"}}', now: NOW }), null);
  // CLIProxyAPI's scheduler refusing on its own cooldown state is relayed, never recorded as this model's quota.
  assert.equal(quota.classifyQuota({ status: 429, headers: { 'retry-after': '172800' }, body: '{"error":{"message":"All credentials for model claude-opus-5-5 are cooling down via provider antigravity","reset_seconds":172800}}', now: NOW }), null);
  assert.equal(quota.classifyQuota({ status: 500, body: 'quota', now: NOW }), null);
});

test('a quota block records what the session was doing, clears on success, and announces the quota coming back', () => {
  const file = tempQuotaFile();
  const payload = { messages: [
    { role: 'user', content: 'first task' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>noise</system-reminder>' }, { type: 'text', text: 'Refactor the  login\nscreen' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }] },
  ] };
  const reset = NOW + 3600_000;
  quota.recordQuota({ provider: PROVIDER, model: 'claude-opus-5-5-high', pickerModel: 'claude-agy-claude-opus-5-5-high', quota: { status: 429, resetAtMs: reset, detail: 'Individual quota reached.' }, sessionId: 's-1', payload, now: NOW, file });

  assert.equal(quota.activeBlock('agy', 'claude-opus-5-5-high', { now: NOW + 1000, file }).untilMs, reset);
  assert.equal(quota.activeBlock('agy', 'claude-opus-5-5-high', { now: reset, file }), null);
  assert.equal(quota.activeBlock('agy', 'gemini-3-flash', { now: NOW, file }), null);
  const [interruption] = quota.readState(file).interruptions;
  assert.equal(interruption.task, 'Refactor the login screen');

  assert.equal(quota.quotaNotices({ now: NOW + 1000, file }).length, 1);
  assert.match(quota.quotaNotices({ now: NOW + 1000, file })[0], /claude-agy-claude-opus-5-5-high \(Antigravity\) is out of quota until/);
  const back = quota.quotaNotices({ now: reset + 1, file });
  assert.equal(back.length, 1);
  assert.match(back[0], /quota for claude-opus-5-5-high is back\. A session stopped at .* while working on "Refactor the login screen": run `claude --resume s-1` and say "continue"/);
  assert.deepEqual(quota.quotaNotices({ now: reset + 1, file, belongsHere: () => false }), []);

  quota.clearQuota({ providerId: 'agy', model: 'claude-opus-5-5-high', sessionId: 's-1', file });
  assert.deepEqual(quota.readState(file), { blocks: {}, interruptions: [] });
});

test('quota lists blocks and stopped sessions, and clear forgets the records', () => {
  const file = tempQuotaFile();
  quota.recordQuota({ provider: PROVIDER, model: 'm1', pickerModel: 'claude-agy-m1', quota: { status: 429, resetAtMs: NOW + 60_000, detail: '' }, sessionId: 's-9', payload: { messages: [{ role: 'user', content: 'write tests' }] }, now: NOW, file });
  const lines = [];
  const context = { quotaFile: file, out: (line) => lines.push(line), now: () => NOW };
  assert.equal(quotaCommand([], context), EXIT.ok);
  const text = lines.join('\n');
  assert.match(text, /Out of quota:\n {2}claude-agy-m1 \(Antigravity\) until/);
  assert.match(text, /s-9 {2}m1 \(Antigravity\), stopped .*; quota back at/);
  assert.match(text, /task: "write tests"/);
  assert.match(text, /resume: claude --resume s-9, then say "continue"/);
  lines.length = 0;
  quotaCommand(['clear', 'other-session'], context);
  assert.match(lines[0], /^cleared 0 interrupted session records$/);
  assert.equal(Object.keys(quota.readState(file).blocks).length, 1, 'a session clear leaves blocks alone');
  lines.length = 0;
  quotaCommand(['clear'], context);
  assert.match(lines[0], /cleared 1 interrupted session record and lifted 1 quota block/);
  assert.deepEqual(quota.readState(file), { blocks: {}, interruptions: [] });
});

test('the gateway answers a provider quota as a usage limit and stops calling the provider until the reset', async (t) => {
  t.after(() => fs.rmSync(quota.QUOTA_PATH, { force: true }));
  let calls = 0;
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls += 1;
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Individual quota reached. Resets in 2h0m0s.' } }));
    });
  });
  const providerPort = await new Promise((resolve) => provider.listen(0, '127.0.0.1', () => resolve(provider.address().port)));
  t.after(() => provider.close());
  const route = { provider: { ...PROVIDER, baseUrl: `http://127.0.0.1:${providerPort}` }, model: 'claude-opus-5-5-high' };
  const finished = [];
  const gateway = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => forwardProvider({
      clientReq: req, clientRes: res, pathOnly: '/v1/messages', payload: JSON.parse(Buffer.concat(chunks).toString()),
      route, sessionId: 'sess-42', env: {}, onFinish: (status, code) => finished.push([status, code]),
    }));
  });
  const gatewayPort = await new Promise((resolve) => gateway.listen(0, '127.0.0.1', () => resolve(gateway.address().port)));
  t.after(() => gateway.close());
  const send = () => fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-agy-claude-opus-5-5-high', max_tokens: 5, messages: [{ role: 'user', content: 'ship the release' }] }),
  });

  const before = Date.now();
  const first = await send();
  const body = await first.json();
  assert.equal(first.status, 429);
  assert.equal(first.headers.get('x-should-retry'), 'false');
  assert.equal(first.headers.get('anthropic-ratelimit-unified-status'), 'rejected');
  assert.equal(first.headers.get('anthropic-ratelimit-unified-representative-claim'), 'overage');
  const reset = Number(first.headers.get('anthropic-ratelimit-unified-reset')) * 1000;
  assert.ok(reset >= before + 7_199_000 && reset <= Date.now() + 7_201_000);
  assert.equal(body.error.type, 'rate_limit_error');
  assert.match(body.error.message, /the Antigravity quota for claude-opus-5-5-high is exhausted until .*Your conversation is saved/);

  const second = await send();
  assert.equal(second.status, 429);
  assert.equal(calls, 1, 'a blocked model is answered without calling the provider');
  assert.deepEqual(finished.map(([, code]) => code), ['provider_quota', 'provider_quota_blocked']);
  assert.equal(quota.readState().interruptions[0].task, 'ship the release');
});
