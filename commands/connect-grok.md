---
description: "Connect Grok models to /model using your existing Grok CLI login"
allowed-tools: Bash(node:*)
---

Connect Grok in one step.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/code-team.js" connect grok` with the Bash tool. If `${CLAUDE_PLUGIN_ROOT}` is not set, use `node ~/.claude/code-team/code-team.js` instead; both run the same CLI.
2. Exit 0: tell the user Grok is connected and that they must fully restart Claude Code, then open `/model`.
3. Exit 3: there is no Grok CLI login yet. Tell the user to run `grok` in their own terminal and finish its login (it is interactive, so you cannot do it for them), then run `/connect-grok` again.

Relay what the command printed in a few plain lines, ending with its "Next:" step. Never print, repeat, or log an API key or token.
