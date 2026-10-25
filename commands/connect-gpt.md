---
description: "Connect your ChatGPT/Codex subscription models to /model (browser sign-in)"
argument-hint: "[--device]"
allowed-tools: Bash(node:*)
---

Connect ChatGPT/Codex in one step.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/code-team.js" connect gpt $ARGUMENTS` with the Bash tool and a 10-minute timeout. If `${CLAUDE_PLUGIN_ROOT}` is not set, use `node ~/.claude/code-team/code-team.js` instead; both run the same CLI.
   It downloads claude-code-proxy (checksum-verified), opens the ChatGPT sign-in in the browser when needed, and wires this project.
   On a machine without a browser, run it with `--device` for the device-code sign-in.
2. Exit 0: tell the user it is connected and that they must fully restart Claude Code, then open `/model`.
3. Exit 3: the sign-in did not finish. Tell the user, and offer to run it again.
4. Any other failure: report the error and offer to run `node "${CLAUDE_PLUGIN_ROOT}/bin/code-team.js" doctor`.

Relay what the command printed in a few plain lines, ending with its "Next:" step. Never print, repeat, or log an API key or token.
