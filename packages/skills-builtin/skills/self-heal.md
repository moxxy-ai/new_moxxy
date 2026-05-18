---
name: self-heal
description: When a tool call fails or the system misbehaves, diagnose the root cause and propose ONE scoped fix that the user approves before it lands.
triggers:
  - "tool failed"
  - "permission denied"
  - "not found"
  - "doesn't work"
  - "broken"
  - "fix this"
  - "fix it"
  - "can't run"
  - "is hanging"
  - "is stuck"
  - "is failing"
  - "what's wrong"
  - "diagnose"
  - "self-heal"
  - "self heal"
  - "repair"
---

# Self-heal — diagnose then propose ONE fix

When a tool errored, a subagent hung, an install is missing, a permission was
denied, or "something just isn't working", follow this loop. Every concrete
change runs through an existing tool whose permission gate is `prompt`, so the
user explicitly approves each destructive action — there is no "allow always"
shortcut for fixes. **This is intentional.** Self-healing without a human in
the loop turns a one-line bug into a cascade.

## Loop

1. **Diagnose first, don't guess.** Use read-only tools to inspect actual
   state before forming a hypothesis:
   - `Read` / `Grep` / `Glob` for source / config / logs.
   - `bash` (read-only commands like `ls`, `cat`, `which`, `ps`, `git status`)
     for environment checks. Don't run mutating shell commands here.
   - `/info`, `/agents`, `/skills`, `/tools` — operator overlays that show
     live registry state.
   - `~/.moxxy/permissions.json`, `~/.moxxy/mcp.json`, `~/.moxxy/sessions/`
     for persistent state when relevant.

2. **State the root cause in one sentence.** "X failed because Y". If you
   don't have evidence for Y, gather more — don't move on.

3. **Propose ONE scoped fix.** Smallest change that addresses the diagnosed
   cause. Avoid "let me also tidy up while I'm here" — that turns a focused
   fix into an unreviewable diff.

4. **Pick the right tool for the fix.** All of these prompt for permission:
   - **Code / config edit**: `Edit` or `Write` for a specific file.
   - **Shell action**: `bash` (e.g. restart a service, clear a cache).
   - **Plugin missing**: `install_plugin` (if `@moxxy/plugin-plugins-admin`
     is enabled) — npm-installs into `~/.moxxy/plugins` + hot-reloads.
   - **MCP server broken/missing**: `mcp_add_server`, `mcp_remove_server`,
     `mcp_test_server`.
   - **Permission denied repeatedly**: tell the user how to add a permanent
     allow rule (`moxxy perms allow <tool>`) — do NOT silently bypass.
   - **Skill missing**: `synthesize_skill` to draft a new skill.

5. **Surface the proposed change BEFORE calling the tool.** Tell the user:
   - The diagnosis.
   - The exact change you're about to make.
   - What the user should look for in the next permission prompt to verify it.

6. **Verify after the fix lands.** Re-run the failing tool / command. If it
   still fails, do NOT loop on the same fix — go back to step 1 with the new
   information. Two failed attempts is the threshold to stop and escalate
   to the user with what you've learned.

## Don't

- **Don't propose `allow_always` as a fix.** If the user keeps seeing prompts
  for the same tool, the fix is `moxxy perms allow <tool>`, not a
  workaround. Suggest the command — don't run it for them.
- **Don't try to fix issues outside the obvious blast radius.** If a single
  subagent failed, don't reboot the whole session. If a config field was
  missing, don't rewrite the entire config.
- **Don't chain fixes without approval gates.** Each destructive step is its
  own permission prompt. Bundling N edits into a single `bash` heredoc to
  avoid the prompts defeats the safety design.
- **Don't self-heal silently when the user didn't ask.** This skill is for
  responding to a specific reported issue, not proactive cleanup. If you
  notice a problem the user hasn't mentioned, tell them — let them decide
  whether to repair.

## Templates

For a denied tool the user clearly wants:
```
Diagnosed: `web_fetch` was denied because the policy has no allow rule.
Proposal:  Add a permanent allow for `web_fetch` (you'll only be asked once).
Command:   `moxxy perms allow web_fetch`
```

For a missing plugin:
```
Diagnosed: `dispatch_agent` failed because `@moxxy/plugin-subagents` is not
           registered (the agent registry only lists `default`).
Proposal:  Install `@moxxy/plugin-subagents` via the install_plugin tool.
           You'll get one permission prompt for the npm install.
```

For a hung subagent:
```
Diagnosed: Subagent `<label>` is hung waiting on a `<tool>` call — the
           tool ran for <N>s with no result. Likely a network timeout on
           <url>.
Proposal:  Cancel the turn (Esc) and re-run with a more specific prompt
           that points the child at a faster source. No file/config
           changes needed.
```
