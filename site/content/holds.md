---
title: When it holds a tool call
description: Exactly when Session Inbox pauses a Claude Code tool call for your decision, what happens after 120 seconds, what Always allow writes, and why Claude is never blocked when the daemon is down.
nav: When it holds a call
order: 3
section: Guides
---

# When it holds a tool call

Session Inbox can pause a tool call in a Claude session until you decide, from a notification or the inbox window. That changes how every session on your machine feels, so the rule is deliberately narrow: **it only holds a call when Claude itself would have asked you.**

## The hold rule

A call is held only when all of these are true:

1. **The session is in the default permission mode.** Sessions in other modes, such as auto or accept-edits, are never held.
2. **The tool is in the held set.** By default that's Bash, Write, Edit, MultiEdit, NotebookEdit and WebFetch. Change it with `holds.tools` in [Settings](settings.md).
3. **No allow rule matches.** If your user, project or local Claude settings already allow the call, Claude wouldn't ask, so neither does Session Inbox. A deny rule wins over an allow rule, as it does in Claude.
4. **The project isn't muted.**

Two more cases are never held. Read-only Bash commands from the safe list (`ls`, `pwd`, `git status`, `git diff` and similar, with no shell operators in them) run without a pause. And if holding is switched off with `holds.enabled`, nothing is held.

`AskUserQuestion` is the exception to rule 1 to 3: it is always routed through the inbox, so you can answer from a notification. Muting the project still applies.

Everything else is left alone. Claude shows its own permission prompt exactly as it would without Session Inbox, and Session Inbox only records that it happened.

## What you see while a call is held

The item appears in **Needs you** with a notification that offers **Allow**, **Deny** and **Open**. Claude shows its working state and waits. When you decide, the answer goes straight back and Claude continues in the same turn.

Clicking **Open in Claude** on a held item releases the hold at once, so Claude's own permission prompt appears. You're never looking at a frozen session.

## The 120 second fallback

A held call waits up to **120 seconds** for your decision. If you haven't answered by then, Session Inbox lets go and Claude shows its own permission prompt, as if the inbox hadn't been there. The item stays in the inbox, marked as no longer live, so you can still see what happened.

The wait is `holds.budgetMs` (default `120000`) in [Settings](settings.md). The registered hook has a longer timeout than the wait, so Claude never cuts the hook off before the fallback happens.

## Always allow

**Always allow** lets the call run and records a rule so Claude doesn't ask again. The rule is written to the project's `.claude/settings.local.json`, under `permissions.allow`. That's the same file and scope as Claude's own "don't ask again for this project", so the blast radius stays at one project.

Session Inbox adds to that file and keeps everything else in it. If the file isn't a JSON object, it's left alone and the call is still allowed once.

## Fail open

Session Inbox must never be the reason Claude is slow or stuck, so the hook is built to fail open:

- If the daemon isn't running, the hook exits immediately with no output, and Claude behaves as if no hooks were installed.
- If the daemon is slow to accept an event, the hook gives up after half a second.
- If anything inside the hook goes wrong, including a bad payload or a closed socket, it still exits cleanly with no output.
- The hook never exits with an error code that would block a call.
- If the daemon disappears while a call is held, the hook goes quiet rather than denying anything.

The only time the hook prints a decision on its own is when the 120 seconds run out, and then it says "ask", which hands the call back to Claude's own prompt.

## Two channels on one machine

If you run a GA and a beta install side by side, only one of them holds. The other observes: it shows the same items and notifies, but can't answer held calls. See [GA and beta channels](channels.md).
