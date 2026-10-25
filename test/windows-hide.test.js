'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// The window-visibility lint lives in the Eigenwise monorepo; standalone checkouts skip it.
const lintPath = path.join(__dirname, '..', '..', 'test-support', 'windows-hide.js');
const lint = fs.existsSync(lintPath) ? require(lintPath) : null;
const skip = lint ? false : 'Eigenwise monorepo test-support is not present';

const pluginRoot = path.join(__dirname, '..');

test('production child processes hide Windows command windows', { skip }, () => {
  const calls = lint.inspectPlugin(pluginRoot);
  assert.ok(calls.length > 0, 'expected at least one child_process call site');
  assert.deepEqual(lint.unhiddenCalls(calls), []);
});

test('window visibility lint catches an unhidden child process fixture', { skip }, () => {
  const calls = lint.inspectSource("const cp = require('node:child_process');\ncp.spawn('command', []);", 'fixture.js');
  assert.equal(lint.unhiddenCalls(calls).length, 1);
});
