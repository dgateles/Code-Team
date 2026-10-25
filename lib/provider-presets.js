'use strict';

// Presets for providers whose official documentation publishes an Anthropic
// Messages-compatible endpoint. Each base URL was checked against the doc page
// named above it (2026-10-25). Keys come from the environment variable named in
// apiKeyEnv unless the user stores one explicitly.

const os = require('node:os');
const path = require('node:path');

const ANTIGRAVITY_CONNECTION_FILE = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'cpa-connection.json');

const PRESETS = Object.freeze({
  // https://api-docs.deepseek.com/guides/anthropic_api
  // Context windows: https://api-docs.deepseek.com/api/list-models/
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    authStyle: 'x-api-key',
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1048576 },
      { id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 1048576 },
    ],
  },
  // https://platform.kimi.ai/docs/guide/claude-code-kimi.md (China: https://platform.kimi.com/docs/guide/claude-code-kimi.md)
  kimi: {
    id: 'kimi',
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    authStyle: 'bearer',
    models: [
      { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1000000 },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
    ],
    regions: { cn: { baseUrl: 'https://api.moonshot.cn/anthropic' } },
  },
  // https://docs.z.ai/devpack/tool/claude (China: https://docs.bigmodel.cn/cn/coding-plan/tool/claude)
  // Context windows: https://docs.z.ai/guides/llm/glm-5.3
  glm: {
    id: 'glm',
    name: 'Z.ai GLM',
    baseUrl: 'https://api.z.ai/api/anthropic',
    apiKeyEnv: 'ZAI_API_KEY',
    authStyle: 'bearer',
    models: [
      { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000 },
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 1000000 },
    ],
    regions: { cn: { name: 'Zhipu GLM', baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKeyEnv: 'ZHIPU_API_KEY' } },
  },
  // https://platform.minimax.io/docs/api-reference/text-anthropic-api.md (China: https://platform.minimax.cn/docs/api-reference/text-anthropic-api)
  // The docs show both x-api-key and Bearer, so both are sent.
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic',
    apiKeyEnv: 'MINIMAX_API_KEY',
    authStyle: 'both',
    models: [
      { id: 'MiniMax-M3.1-Flash', name: 'MiniMax M3.1 Flash', contextWindow: 1000000 },
      { id: 'MiniMax-M3', name: 'MiniMax M3', contextWindow: 1000000 },
    ],
    regions: { cn: { baseUrl: 'https://api.minimax.cn/anthropic' } },
  },
  // https://openrouter.ai/docs/guides/guides/claude-code-integration
  // API reference: https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message.md
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    authStyle: 'bearer',
    models: [{ id: 'openrouter/auto', name: 'OpenRouter Auto' }],
  },
  // Antigravity through a local CLIProxyAPI (https://github.com/router-for-me/CLIProxyAPI) that holds the
  // Antigravity login and speaks the Anthropic Messages format. Using that login outside Google's own
  // product violates Google's terms, so adding it requires an explicit, recorded acceptance.
  antigravity: {
    id: 'agy',
    name: 'Antigravity',
    baseUrl: 'http://127.0.0.1:8317',
    apiKeyFile: ANTIGRAVITY_CONNECTION_FILE,
    authStyle: 'both',
    modelsFrom: 'list',
    ownedBy: 'antigravity',
    requiresTerms: 'google',
  },
});

const GOOGLE_TERMS_VERSION = '2026-10-25';
const GOOGLE_TERMS_WARNING = [
  'WARNING: Antigravity is Google\'s product. Using your Antigravity/Google login outside Google\'s own',
  'product (here, through a local CLIProxyAPI proxy) violates Google\'s terms of service and can get your',
  'Google account suspended. Code Team does not hold or read your Google tokens, but it cannot make this',
  'use permitted. Continue only if you accept that risk for this account.',
].join('\n');

function presetNames() {
  return Object.keys(PRESETS);
}

function presetByName(name) {
  return Object.hasOwn(PRESETS, name) ? PRESETS[name] : null;
}

function presetById(id) {
  return Object.values(PRESETS).find((preset) => preset.id === id) || null;
}

// The provider entry a preset writes; regions and requiresTerms stay preset-only metadata.
function providerFromPreset(name, { region = null } = {}) {
  const preset = presetByName(name);
  if (!preset) throw new Error(`unknown preset ${name}; presets: ${presetNames().join(', ')}`);
  if (region && !preset.regions?.[region]) throw new Error(`preset ${name} has no region ${region}${preset.regions ? `; regions: ${Object.keys(preset.regions).join(', ')}` : ''}`);
  const { regions, requiresTerms, ...entry } = preset;
  return { ...structuredClone(entry), ...(region ? regions[region] : {}), preset: region ? `${name}:${region}` : name };
}

module.exports = {
  ANTIGRAVITY_CONNECTION_FILE, GOOGLE_TERMS_VERSION, GOOGLE_TERMS_WARNING, PRESETS,
  presetById, presetByName, presetNames, providerFromPreset,
};
