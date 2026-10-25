# Code Team

Use Claude Code with Antigravity, GPT, Kimi, Grok and other models.

Code Team is a Claude Code plugin with a small local gateway. Models from other providers show up in Claude Code's `/model` picker next to the Claude models, and you can switch between them mid-session. Claude models keep going to Anthropic with your normal login. Only the rows you pick from another provider are routed to that provider.

Code Team is an independent community project. It is not affiliated with or endorsed by Anthropic or any of the providers it connects to. It is based on [Model Gateway by Eigenwise (MIT)](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/plugins/model-gateway).

## One command per provider

| Command | What it does |
| --- | --- |
| `/connect` | Lists every connection and whether it is connected. |
| `/connect-gpt` | Signs in to your ChatGPT/Codex subscription in the browser and adds the `claude-gpt-*` models. |
| `/connect-grok` | Uses your existing Grok CLI login to add the `claude-grok-*` models. |
| `/connect-antigravity` | Shows the Google terms warning, asks you to accept it, signs you in to Antigravity through a local CLIProxyAPI, and adds the `claude-agy-*` models. |
| `/connect-deepseek` | Adds DeepSeek with your API key. |
| `/connect-kimi` | Adds Kimi (Moonshot) with your API key. Add `--region cn` for the China platform. |
| `/connect-glm` | Adds Z.ai GLM with your API key. Add `--region cn` for Zhipu (bigmodel.cn). |
| `/connect-minimax` | Adds MiniMax with your API key. Add `--region cn` for the China platform. |
| `/connect-openrouter` | Adds OpenRouter with your API key. |
| `/disconnect-<name>` | Removes that connection's models from `/model`, for example `/disconnect-deepseek`. |
| `/disconnect <name>` | The same for any connection, including a [custom provider](#custom-provider). |

Each command is idempotent: running it again repairs or refreshes the connection. It always ends by telling you what happened and what to do next. Usually that is to **fully restart Claude Code**, because the picker only reloads its model list at startup.

Any other endpoint that speaks the Anthropic Messages API can be added as a [custom provider](#custom-provider). You can also just ask Claude, for example: "connect DeepSeek for me" or "add my local endpoint at http://127.0.0.1:4000 as a provider".

## Install

You need Claude Code v2.1.129 or newer, which can show gateway models in `/model`, and Node.js 22.5 or newer.

Run these in Claude Code:

```text
/plugin marketplace add dgateles/Code-Team
/plugin install code-team@code-team
```

Any install scope works. User scope makes the commands available in every project. Project and local scope keep them to the projects that opted in. After installing, run `/reload-plugins` or restart Claude Code.

## Connect a provider in 3 steps

1. **Get access.** For API-key providers, put the key in the environment variable the preset names, for example `DEEPSEEK_API_KEY`. Then restart Claude Code so it can see the variable. You can also paste the key when the command asks for it.
2. **Run the command**, for example `/connect-deepseek`. It checks the key without spending tokens when the provider allows it, adds the provider, starts the gateway, and wires the current project.
3. **Fully restart Claude Code**, then open `/model` and pick a row marked "From gateway".

The connect commands wire the project you run them in. That means they write `ANTHROPIC_BASE_URL=http://127.0.0.1:18774` and related settings into that project's `.claude/settings.local.json`, which is not committed. To wire every project instead, ask Claude to run `env --write-user`.

## Presets

Each preset's base URL was checked against the provider's official documentation.

| Preset | Base URL | Key variable | Models | Docs |
| --- | --- | --- | --- | --- |
| `deepseek` | `https://api.deepseek.com/anthropic` | `DEEPSEEK_API_KEY` | `deepseek-v4-pro`, `deepseek-flash` (1M) | [api-docs.deepseek.com](https://api-docs.deepseek.com/guides/anthropic_api) |
| `kimi` | `https://api.moonshot.ai/anthropic`, or `https://api.moonshot.cn/anthropic` with `--region cn` | `MOONSHOT_API_KEY` | `kimi-k3` (1M), `kimi-k2.7-code` | [platform.kimi.ai](https://platform.kimi.ai/docs/guide/claude-code-kimi.md) |
| `glm` | `https://api.z.ai/api/anthropic`, or `https://open.bigmodel.cn/api/anthropic` with `--region cn` | `ZAI_API_KEY`, or `ZHIPU_API_KEY` for cn | `glm-5.3`, `glm-5.3-flash` (1M) | [docs.z.ai](https://docs.z.ai/devpack/tool/claude) |
| `minimax` | `https://api.minimax.io/anthropic`, or `https://api.minimax.cn/anthropic` with `--region cn` | `MINIMAX_API_KEY` | `MiniMax-M3.1-Flash`, `MiniMax-M3` (1M) | [platform.minimax.io](https://platform.minimax.io/docs/api-reference/text-anthropic-api.md) |
| `openrouter` | `https://openrouter.ai/api` | `OPENROUTER_API_KEY` | `openrouter/auto`; add more with `--model` | [openrouter.ai](https://openrouter.ai/docs/guides/guides/claude-code-integration) |
| `antigravity` | local CLIProxyAPI | from CLIProxyAPI | listed by the proxy (`owned_by: antigravity`) | [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) |

Picker ids are `claude-<provider>-<model>`, for example `claude-deepseek-deepseek-flash[1m]`. Claude Code's discovery only accepts ids that start with `claude`, so every gateway row carries that prefix. The prefix does not mean the model is a Claude model. A `[1m]` suffix appears when the model's window is above Claude Code's 200k default. To add or override a model, pass `--model <id>[:<contextWindow>]` to the connect command, for example `/connect-openrouter --model anthropic/claude-sonnet-5:1000000`.

## Antigravity: read this first

> **Warning.** Using your Antigravity/Google login outside Google's own product violates Google's terms of service and can get your Google account suspended.

`/connect-antigravity` shows this warning and goes on only after you explicitly accept it. The acceptance is recorded with its date in `providers.json`. From the CLI, acceptance is the `--accept-google-terms` flag or an interactive "yes".

How it connects:

- If you already run CLIProxyAPI with an Antigravity login and have `~/.gemini/antigravity-cli/cpa-connection.json`, Code Team uses that proxy on `http://127.0.0.1:8317` and reads its key from that file.
- Otherwise it downloads CLIProxyAPI from the project's GitHub releases. The download is checked against the release's `checksums.txt`, and nothing is installed if the check fails. It then writes a loopback-only config with its own key and the management API disabled, and opens the Antigravity sign-in in your browser (`-antigravity-login`). Finally it starts the proxy on `127.0.0.1:18776`. The gateway restarts that proxy, at most once a minute, if it stops answering.

Code Team never reads or stores your Google tokens. They stay in CLIProxyAPI's own auth directory.

## Custom provider

Any endpoint where `POST <baseUrl>/v1/messages` speaks the Anthropic Messages format works. Ask Claude, or run the CLI yourself:

```text
node ~/.claude/code-team/code-team.js provider add --custom --id acme --name "Acme" \
  --base-url https://llm.acme.example/anthropic --api-key-env ACME_API_KEY \
  --model acme-large:400000 --model acme-small
node ~/.claude/code-team/code-team.js provider test acme
node ~/.claude/code-team/code-team.js connect acme
```

`connect <id>` tests the provider and wires the current project, as the preset commands do. `/disconnect acme` removes it.

The rules for a custom provider:

- **id:** lowercase letters and digits, starting with a letter, up to 20 characters. `gpt`, `grok`, `anthropic`, `claude`, `codex`, `opus`, `sonnet`, `haiku` and `fable` are reserved.
- **Base URL:** stop before `/v1`. Plain `http` is only allowed for loopback addresses.
- **Models:** give a static list with `--model`, or use `--models-from list` to read `GET <baseUrl>/v1/models`. With a list, `--owned-by <name>` keeps only the models whose `owned_by` matches.
- **Auth:** `--auth-style x-api-key | bearer | both`. The default is `x-api-key`. Use `--header "Name: value"` for extra headers.
- **Local proxy:** `--autostart-command <exe> --autostart-arg <arg>...` launches it when it does not answer.

Other commands: `provider list`, `provider remove <id>`, and `provider test <id> [--live]`. `test` reads the model list, then calls `count_tokens`. It only spends tokens with `--live`, which sends a 1-token request.

## Advanced: providers.json

The registry is `~/.claude/code-team/providers.json`, a JSON array. The CLI writes it atomically, readable only by you. You can also edit it by hand. The gateway picks up changes on its next model refresh, and right away when Claude Code asks for `/v1/models`.

```json
[
  {
    "id": "acme",
    "name": "Acme",
    "baseUrl": "https://llm.acme.example/anthropic",
    "apiKeyEnv": "ACME_API_KEY",
    "authStyle": "x-api-key",
    "headers": { "X-Team": "blue" },
    "models": [{ "id": "acme-large", "contextWindow": 400000 }, "acme-small"]
  },
  {
    "id": "local",
    "name": "My local proxy",
    "baseUrl": "http://127.0.0.1:4000",
    "modelsFrom": "list",
    "ownedBy": "me",
    "contextWindow": 200000,
    "autostart": { "command": "C:/tools/proxy.exe", "args": ["--port", "4000"], "cwd": "C:/tools" }
  }
]
```

| Field | Meaning |
| --- | --- |
| `id`, `name` | Picker prefix (`claude-<id>-…`) and display label. |
| `baseUrl` | Where `/v1/messages` and `/v1/models` live. |
| `apiKeyEnv`, `apiKey`, `apiKeyFile` | Where the key comes from. They are checked in that order: environment first, then the stored key, then a JSON file with an `apiKey` field. Leave all three out for a local endpoint without auth. |
| `authStyle` | `x-api-key` (default), `bearer`, or `both`. |
| `headers` | Extra headers to send. `Host`, `Cookie`, `Content-Length` and hop-by-hop headers are refused. |
| `models` / `modelsFrom: "list"` / `ownedBy` | A static catalog, or one listed from the provider. A listed catalog is cached in `provider-models/<id>.json` and refreshed at most every 5 minutes. |
| `contextWindow` | Per provider or per model. It sets the advertised window, the `[1m]` alias above 200k, and the context sentry. A model without a window stays at Claude Code's 200k default. |
| `autostart` | `{command, args, cwd}` for a local proxy, launched at most once a minute when it does not answer. |

An environment key only reaches the gateway if it was set when the gateway started. When a connect command sees the key but the running gateway does not, it restarts the gateway from that environment.

## Security notes

- **Your Anthropic credentials stay with Anthropic.** Requests to a provider are built from an allowlist of headers. Your claude.ai or Anthropic `authorization`, `x-api-key`, cookies and `anthropic-beta` headers are never sent to a third party. Only the provider's own configured key and headers go out.
- **Requests to a provider are left alone otherwise.** The body passes through with only `model` replaced. Provider requests never follow redirects, so a redirect cannot carry your key to another host.
- **Keys:** prefer environment variables. A key you paste is stored in `providers.json`, which only your user can read. The CLI never prints keys. `provider list` shows only where each key comes from.
- **Nothing is probed until you connect something.** An unconfigured gateway reads one missing file and contacts no provider.
- **Downloads are verified.** The claude-code-proxy (GPT) and CLIProxyAPI (Antigravity) downloads are checked against their releases' published SHA-256 checksums. A missing or mismatched checksum stops the install.
- **Local controls are protected.** The gateway listens on loopback only. Its restart and drain endpoints need a per-user token. Browser `Origin` headers and foreign `Host` headers are refused.
- **Provider terms still apply.** Your subscriptions and API keys are governed by each provider's own terms and limits.

## Running next to Model Gateway

Code Team has its own state directory (`~/.claude/code-team/`), ports (18774 for the gateway, 18775 for the Codex proxy, 18776 for its CLIProxyAPI), Windows pipe and launcher. It never stops processes it did not start. You can keep an installed Model Gateway: each project uses whichever gateway its `ANTHROPIC_BASE_URL` points at. Running a connect command in a project switches that project to Code Team. The upstream `CODEX_GATEWAY_*` environment variables still work, for example to change the ports.

## Troubleshooting

- **New models are missing from `/model`.** Fully restart Claude Code; `/reload-plugins` does not refresh the picker. Then run `/connect` and check that the gateway is running and the project is wired. Claude Code only shows gateway rows when the project's `ANTHROPIC_BASE_URL` points at the gateway.
- **A provider row answers "is not answering at …".** That provider's endpoint is down or unreachable. For a local proxy, the error says whether an autostart was just tried; otherwise start it yourself or add `autostart`.
- **"no API key for …".** The gateway cannot see the key. Set the variable named in the error and restart Claude Code, then run the connect command again so the gateway restarts with it.
- **`provider test` says the key cannot be checked without spending tokens.** The provider has neither a model list nor `count_tokens`. Run `provider test <id> --live` to send one 1-token request.
- **Antigravity lists no models.** The CLIProxyAPI is up but not signed in. Run `/connect-antigravity` again to repeat the sign-in. For a proxy you run yourself, sign in there.
- **GPT models fail but Claude works.** Ask Claude: "Code Team GPT models fail, diagnose it." The bundled skill runs `doctor`, which checks the proxy, the ChatGPT login, ports, the model list and settings precedence.
- **Something else.** Ask Claude to run `doctor`. Its log files are under `~/.claude/code-team/logs/`.

The gateway's recovery behaviour, context-window settings, request-route log, Claude model pins and Remote Control compatibility work as in Model Gateway. The bundled `code-team` skill describes them, and Claude uses it when you ask about them.

## Credits and license

Based on Model Gateway by Eigenwise (MIT). Code Team adds the provider registry, presets, the Antigravity connection and the one-step connect commands. See [NOTICE](NOTICE) for attribution and third-party software, and [CHANGELOG](CHANGELOG.md) for what changed.

MIT. See [LICENSE](LICENSE).
