---
description: "Remove Antigravity models from /model (Code Team)"
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/code-team.js" disconnect antigravity` with the Bash tool. If `${CLAUDE_PLUGIN_ROOT}` is not set, use `node ~/.claude/code-team/code-team.js` instead; both run the same CLI.

It is idempotent. Tell the user what it removed and that they must fully restart Claude Code for `/model` to drop the rows. Logins held outside Code Team (ChatGPT, Grok CLI, a CLIProxyAPI) and environment variables are left in place; say so if they ask.
