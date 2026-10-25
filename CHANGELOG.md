# Code Team changelog

Code Team is a fork of Model Gateway 0.55.3 by Eigenwise (MIT). For the history
before the fork, see the upstream changelog:
https://github.com/Eigenwise/eigenwise-toolshed/blob/main/plugins/model-gateway/CHANGELOG.md

## 0.1.0 (unreleased)

First release as Code Team.

### New

- One-step slash commands: `/connect` lists every connection and its status;
  `/connect-gpt`, `/connect-grok`, `/connect-antigravity`, `/connect-deepseek`,
  `/connect-kimi`, `/connect-glm`, `/connect-minimax` and `/connect-openrouter`
  each connect one provider; `/disconnect-<name>` reverses it.
- A provider registry, `~/.claude/code-team/providers.json`, for any endpoint
  that already speaks the Anthropic Messages API. Requests pass straight
  through with only the model id and the provider's own auth headers changed.
  Picker ids are `claude-<provider id>-<model>`, routed by prefix.
- Per-provider `contextWindow` (provider or model) feeds the same window
  policy, `[1m]` alias and context sentry as the GPT rows.
- Models from a static list or from the provider's `GET /v1/models`, with an
  `ownedBy` filter and a per-provider cache.
- Optional `autostart` for a local proxy, launched at most once a minute when
  it does not answer.
- CLI: `provider list | add <preset> | add --custom | remove <id> | test <id>`,
  plus `connect`, `disconnect` and `connections`. `provider test` checks the
  model list, then `count_tokens`; it spends tokens only with `--live`.
- Presets verified against each provider's official documentation: DeepSeek,
  Kimi (global and China), Z.ai GLM (and Zhipu China), MiniMax (global and
  China), OpenRouter, and Antigravity.
- Antigravity through a local CLIProxyAPI, either the user's own (found through
  `~/.gemini/antigravity-cli/cpa-connection.json`) or one Code Team downloads
  with checksum verification, signs in with `-antigravity-login`, and starts.
  It requires an explicit, dated acceptance of the Google terms-of-service risk.

### Security

- Provider requests are built from a header allowlist: the client's
  Anthropic/claude.ai credentials, cookies and `anthropic-beta` headers never
  reach a third-party provider.
- Plain http is accepted only for loopback providers; provider requests never
  follow redirects; `providers.json` is written atomically and private to the user.
- An unconfigured gateway reads one missing file and probes nothing.

### Changed from Model Gateway

- Renamed to `code-team`, with its own state directory
  (`~/.claude/code-team/`), default ports 18774/18775, Windows pipe, hosts
  markers and launcher, so it runs side by side with an installed Model
  Gateway. The `CODEX_GATEWAY_*` environment variables still work.
- The gateway runs without claude-code-proxy when only other providers are
  connected, and leaves out the stand-in GPT rows in that case.
