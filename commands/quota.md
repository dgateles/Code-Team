---
description: "Show which Code Team models are out of quota, until when, and the sessions they stopped (with the resume command)"
argument-hint: "[clear [<session>]]"
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/code-team.js" quota $ARGUMENTS` with the Bash tool. If `${CLAUDE_PLUGIN_ROOT}` is not set, use `node ~/.claude/code-team/code-team.js` instead; both run the same CLI.

Relay it plainly: each model that is out of quota and when it resets, then each stopped session with what it was working on and its `claude --resume <id>` command. A stopped session continues where it left off: resume it once the quota is back and say "continue". If the user is in the stopped session right now, they can instead pick another model with `/model` and say "continue". `quota clear` forgets the stopped-session records; it does not lift a block, which ends by itself at the reset.
