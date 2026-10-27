'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { gatewayAgentName, syncGatewayAgentDefinitions } = require('../lib/commands.js');

test('gatewayAgentName turns a picker id into a plain agent name', () => {
  assert.equal(gatewayAgentName('claude-gpt-5.6-terra[1m]'), 'gpt-5-6-terra');
  assert.equal(gatewayAgentName('claude-grok-4.5'), 'grok-4-5');
});

test('syncGatewayAgentDefinitions writes one owned definition per model and prunes stale ones', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-team-agents-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'mine.md'), '---\nname: mine\ndescription: user agent\n---\nkeep me\n');
  fs.writeFileSync(path.join(dir, 'gpt-5-6-luna.md'), '---\nname: gpt-5-6-luna\ndescription: user-owned twin\n---\nnot ours\n');

  let result = syncGatewayAgentDefinitions(['claude-gpt-5.6-terra[1m]', 'claude-gpt-5.6-luna[1m]', 'claude-grok-4.5'], dir);
  assert.deepEqual([result.count, result.changed], [3, 2]);
  const terra = fs.readFileSync(path.join(dir, 'gpt-5-6-terra.md'), 'utf8');
  assert.match(terra, /^---\nname: gpt-5-6-terra\n/);
  assert.match(terra, /\nmodel: claude-gpt-5\.6-terra\[1m\]\n/);
  assert.match(terra, /\ndescription: "Runs the task on GPT-5\.6 Terra through/);
  assert.match(terra, /GPT-5\.6 Terra/);
  assert.match(terra, /code-team-gateway-agent/);
  assert.match(fs.readFileSync(path.join(dir, 'grok-4-5.md'), 'utf8'), /\nmodel: claude-grok-4\.5\[1m\]\n/);
  assert.equal(fs.readFileSync(path.join(dir, 'gpt-5-6-luna.md'), 'utf8').includes('not ours'), true, 'a user agent with the same name wins');

  result = syncGatewayAgentDefinitions(['claude-gpt-5.6-terra[1m]', 'claude-gpt-5.6-luna[1m]', 'claude-grok-4.5'], dir);
  assert.equal(result.changed, 0, 'unchanged list rewrites nothing');

  syncGatewayAgentDefinitions(['claude-gpt-5.6-terra[1m]'], dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['gpt-5-6-luna.md', 'gpt-5-6-terra.md', 'mine.md'],
    'owned grok file removed, user files kept');
});

test('syncGatewayAgentDefinitions refuses ids that could escape the frontmatter', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-team-agents-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = syncGatewayAgentDefinitions(['claude-gpt-5.6-terra[1m]', 'claude-evil\ntools: Bash', 'claude-has space'], dir);
  assert.equal(result.count, 1);
  assert.deepEqual(fs.readdirSync(dir), ['gpt-5-6-terra.md']);
});
