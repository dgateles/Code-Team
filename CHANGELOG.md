# Code Team changelog

Code Team is a fork of Model Gateway 0.55.3 by Eigenwise (MIT). For the history
before the fork, see the upstream changelog:
https://github.com/Eigenwise/eigenwise-toolshed/blob/main/plugins/model-gateway/CHANGELOG.md

## 0.1.1

Fixes from the first ChatGPT and Antigravity connections on Linux (CachyOS,
Claude Code opened through `headroom wrap claude`).

### Fixed

- `/connect-gpt` run from Claude's Bash tool never showed the ChatGPT sign-in
  link until the OAuth timeout. The sign-in now runs detached: without a
  terminal the command prints the link, saves it to `logs/login-url.txt` and
  exits 4; the next run waits for the sign-in and wires the project. `login`
  gained `--start`, `--wait` and `--reset`; a leftover proxy holding port 1455
  is ended before a new sign-in, and a signal or timeout ends the pending one.
- A process-env `ANTHROPIC_BASE_URL` (for example from `headroom wrap claude`)
  silently bypassed the wiring. The connect commands now warn and say how to
  restart; `upstream set|show|reset` persists another proxy as the Anthropic
  upstream (`~/.claude/code-team/upstream.json`), shown by `status`, `doctor`
  and `/healthz`, with the `CODEX_GATEWAY_ANTHROPIC_UPSTREAM` variable documented.
- The gateway discovery cache (`~/.claude/cache/gateway-models.json`) was
  skipped in silence when a connect ran under a wrapper that exports
  `ANTHROPIC_BASE_URL`, so the first wired session showed no gateway rows in
  `/model`. The cache now follows the wiring a settings file holds, and a skip
  is logged.
- `connect antigravity` declared the model list empty one second after the
  sign-in, before CLIProxyAPI had loaded the credential it just wrote. The list
  is retried up to 5 times, 1 s apart. Without a graphical session on Linux the
  sign-in runs with `-no-browser` from the start.
- `doctor` and the SessionStart notice read the Claude Code process's own
  environment (via `CLAUDE_PID`) instead of the tool subprocess environment,
  which Claude Code fills from the settings file, so "process env: wired" is no
  longer a false positive inside a session.

## 0.1.0

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
