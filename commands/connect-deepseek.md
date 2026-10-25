---
description: "Connect DeepSeek models to /model through Code Team (API key)"
argument-hint: "[--model id[:contextWindow]]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Connect DeepSeek in one step.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/code-team.js" connect deepseek $ARGUMENTS` with the Bash tool. If `${CLAUDE_PLUGIN_ROOT}` is not set, use `node ~/.claude/code-team/code-team.js` instead; both run the same CLI.
2. Exit 0: the key was found (`DEEPSEEK_API_KEY` is preferred), validated with `provider test` without spending tokens where the provider allows it, and the provider was enabled. Tell the user to fully restart Claude Code, then open `/model`.
3. Exit 3 with "needs an API key": nothing was changed. Ask the user which they prefer:
   - set `DEEPSEEK_API_KEY` in their environment (the key then never touches disk), restart Claude Code, and run `/connect-deepseek` again; or
   - paste the key now. Then run the same command with `--api-key-stdin`, sending the key on stdin with a quoted heredoc (never as a command-line argument), and do not repeat the key in your reply. It is stored in `~/.claude/code-team/providers.json`, readable only by the user.
4. Exit 3 after a test: the provider refused the key; providers.json was left unchanged. Ask for a corrected key.
5. Exit 1: report the error (for example the provider is unreachable).

Relay what the command printed in a few plain lines, ending with its "Next:" step. Never print, repeat, or log an API key or token.
