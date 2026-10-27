---
description: "Connect your ChatGPT/Codex subscription models to /model (browser sign-in)"
argument-hint: "[--device]"
allowed-tools: Bash(node:*)
---

Connect ChatGPT/Codex in one step.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/code-team.js" connect gpt $ARGUMENTS` with the Bash tool and a 10-minute timeout. If `${CLAUDE_PLUGIN_ROOT}` is not set, use `node ~/.claude/code-team/code-team.js` instead; both run the same CLI.
   It downloads claude-code-proxy (checksum-verified), starts the ChatGPT sign-in when needed, and wires this project.
   On a machine without a browser, run it with `--device` for the device-code sign-in.
2. Exit 4: a sign-in is pending. **Immediately** give the user the sign-in link the command printed (the line after "Sign-in link"), verbatim, and tell them to open it and finish the sign-in; the browser may not have opened on its own. Then run the same command again with a 10-minute timeout: it waits for the sign-in and finishes the wiring.
3. Exit 0: tell the user it is connected and relay the command's "Next:" lines. If it printed a WARNING about `ANTHROPIC_BASE_URL` in the process environment (for example from `headroom wrap claude`), relay it in full: restarting Claude Code the same way would keep bypassing Code Team.
4. Exit 3: the sign-in did not finish. Tell the user, and offer to run it again (`login --reset` discards a stuck sign-in).
5. Any other failure: report the error and offer to run `node "${CLAUDE_PLUGIN_ROOT}/bin/code-team.js" doctor`.

Relay what the command printed in a few plain lines, ending with its "Next:" step. Never print, repeat, or log an API key or token.
