'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { configText } = require('../lib/cliproxyapi.js');

test('the managed CLIProxyAPI config is loopback-only and never cools a credential', () => {
  const text = configText({ port: 18776, apiKey: 'k', authDir: 'C:\\auths' });
  assert.match(text, /^server:\n {2}host: "127\.0\.0\.1"\n {2}port: 18776$/m);
  assert.match(text, /^management:\n {2}allow-remote: false$/m);
  assert.match(text, /^oauth:\n {2}auth-dir: "C:\/auths"$/m);
  // One Google login has nothing to fail over to; stock cooldown blacked out every model for days (CLIProxyAPI#5843).
  assert.match(text, /^routing:\n {2}cooldown:\n {4}disable-cooling: true$/m);
});
