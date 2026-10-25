---
description: "Connect Antigravity models to /model through a local CLIProxyAPI (shows a Google terms warning first)"
argument-hint: "[--no-browser]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Connect Antigravity in one step. The warning comes first and is not optional.

1. Show the user this warning, word for word:

   > Using your Antigravity/Google login outside Google's own product (here, through a local CLIProxyAPI proxy) violates Google's terms of service and can get your Google account suspended. Code Team does not hold or read your Google tokens, but it cannot make this use permitted.

2. Ask the user to explicitly accept or decline that risk (use AskUserQuestion if available). If they decline, or the answer is anything but a clear yes, stop and do not run anything.
3. Only after a clear yes, run `node "${CLAUDE_PLUGIN_ROOT}/bin/code-team.js" connect antigravity --accept-google-terms $ARGUMENTS` with the Bash tool and a 10-minute timeout. If `${CLAUDE_PLUGIN_ROOT}` is not set, use `node ~/.claude/code-team/code-team.js` instead; both run the same CLI.
   It records the acceptance with today's date, uses the user's own CLIProxyAPI if `~/.gemini/antigravity-cli/cpa-connection.json` exists, and otherwise downloads CLIProxyAPI (checksum-verified), opens the Antigravity sign-in in the browser, starts the proxy, and refreshes the model list.
4. Exit 0: tell the user Antigravity is connected (`claude-agy-*` models) and that they must fully restart Claude Code, then open `/model`.
5. Exit 3: the sign-in did not finish; offer to run the command again (`--no-browser` prints the sign-in URL instead of opening it).
6. Exit 1: report what it printed, including the log path it names.

Relay what the command printed in a few plain lines, ending with its "Next:" step. Never print, repeat, or log an API key or token.
