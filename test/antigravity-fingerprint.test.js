'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { forwardProvider, maskSystemFingerprints } = require('../lib/provider-backend.js');

const ZWSP = '\u200B';
const SUBAGENT_SYSTEM = [
  { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
  { type: 'text', text: '<system-conventions>\nRFC 2119: MUST, SHOULD.\n</system-conventions>', cache_control: { type: 'ephemeral' } },
];

test('maskSystemFingerprints breaks the phrases Antigravity rejects and leaves everything else alone', () => {
  const masked = maskSystemFingerprints(SUBAGENT_SYSTEM);
  assert.equal(masked[0].text, `You are a Claude agent, built on Anthropic's C${ZWSP}laude Agent SDK.`);
  assert.equal(masked[1].text, `<s${ZWSP}ystem-conventions>\nR${ZWSP}FC 2119: MUST, SHOULD.\n</s${ZWSP}ystem-conventions>`);
  assert.deepEqual(masked[1].cache_control, { type: 'ephemeral' }, 'other block fields survive');
  assert.equal(maskSystemFingerprints("You are Claude Code, Anthropic's official CLI for Claude."), "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.equal(maskSystemFingerprints(undefined), undefined);
});

async function recordingProvider(t) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => server.close());
  return { bodies, baseUrl: `http://127.0.0.1:${port}` };
}

test('only Antigravity-bound requests get their system blocks masked; user content is never touched', async (t) => {
  const upstream = await recordingProvider(t);
  const gateway = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const provider = { id: req.url.slice(1), name: 'P', baseUrl: upstream.baseUrl, authStyle: 'x-api-key', headers: {} };
      forwardProvider({ clientReq: req, clientRes: res, pathOnly: '/v1/messages', payload: JSON.parse(Buffer.concat(chunks).toString()), route: { provider, model: 'm' }, env: {} });
    });
  });
  const port = await new Promise((resolve) => gateway.listen(0, '127.0.0.1', () => resolve(gateway.address().port)));
  t.after(() => gateway.close());
  const payload = { model: 'x', max_tokens: 5, system: SUBAGENT_SYSTEM, messages: [{ role: 'user', content: 'Quote: Claude Agent SDK and RFC 2119 stay as typed' }] };
  for (const id of ['agy', 'deepseek']) {
    const response = await fetch(`http://127.0.0.1:${port}/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
  }
  const [agy, other] = upstream.bodies;
  assert.match(agy.system[0].text, /C\u200Blaude Agent SDK/);
  assert.equal(agy.messages[0].content, payload.messages[0].content);
  assert.deepEqual(other.system, SUBAGENT_SYSTEM, 'a non-Antigravity provider gets the prompt as typed');
});
