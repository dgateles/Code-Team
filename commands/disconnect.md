---
description: "Remove any Code Team connection from /model, including a custom provider (Code Team)"
argument-hint: "<name>"
allowed-tools: Bash(node:*)
---

If `$ARGUMENTS` is empty, run `node "${CLAUDE_PLUGIN_ROOT}/bin/code-team.js" connect` with the Bash tool, show the table, and ask which connection to remove. Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/bin/code-team.js" disconnect $ARGUMENTS`. If `${CLAUDE_PLUGIN_ROOT}` is not set, use `node ~/.claude/code-team/code-team.js` instead; both run the same CLI.

It is idempotent. Tell the user what it removed and that they must fully restart Claude Code for `/model` to drop the rows. Logins held outside Code Team (ChatGPT, Grok CLI, a CLIProxyAPI) and environment variables are left in place; say so if they ask.
