---
description: "Show Code Team connections (GPT, Grok, Antigravity, DeepSeek, Kimi, GLM, MiniMax, OpenRouter, custom) and their status"
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/code-team.js" connect` with the Bash tool. If `${CLAUDE_PLUGIN_ROOT}` is not set, use `node ~/.claude/code-team/code-team.js` instead; both run the same CLI.

Show the user the table it prints. For anything not connected, name its slash command (for example `/connect-deepseek`). For an endpoint that is not listed, offer to add it as a custom provider (see the code-team skill).
