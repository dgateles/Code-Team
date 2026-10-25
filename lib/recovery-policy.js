'use strict';

function recoverySettings() {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  return [
    path.join(process.cwd(), '.claude', 'settings.local.json'),
    path.join(process.cwd(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ].map((file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return {}; }
  });
}

// Any marketplace: the fork is published under its own marketplace id.
function pluginEnabledValue(setting) {
  const plugins = setting.enabledPlugins;
  if (!plugins || typeof plugins !== 'object') return undefined;
  const key = Object.keys(plugins).find((name) => name.startsWith('code-team@') && typeof plugins[name] === 'boolean');
  return key ? plugins[key] : undefined;
}

function effectivePluginEnabled(settings = recoverySettings()) {
  const definition = settings.find((setting) => pluginEnabledValue(setting) !== undefined);
  return definition ? pluginEnabledValue(definition) : undefined;
}

function recoveryEndpoint(settings) {
  if (typeof process.env.ANTHROPIC_BASE_URL === 'string') return process.env.ANTHROPIC_BASE_URL;
  return settings.find((setting) => typeof setting.env?.ANTHROPIC_BASE_URL === 'string')?.env.ANTHROPIC_BASE_URL;
}

function recoveryPolicy() {
  const settings = recoverySettings();
  const endpoints = ['http://127.0.0.1:' + (process.env.CODEX_GATEWAY_PORT || 18774), 'http://api.anthropic.com'];
  if (!endpoints.includes(recoveryEndpoint(settings))) return 'unwired';
  return effectivePluginEnabled(settings) === false ? 'disabled' : 'recover';
}

function pluginDisabledNotice() {
  return 'Code Team recovery is explicitly disabled; re-enable the code-team plugin in enabledPlugins or unwire with env --remove.';
}

module.exports = { effectivePluginEnabled, pluginDisabledNotice, recoveryPolicy };
