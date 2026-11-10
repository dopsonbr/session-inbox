---
title: How approvals work
description: How Session Inbox answers Claude's permission prompts: the default that answers Claude's own prompt, the classic mode that holds a tool call, what Always allow writes, what happens when you don't answer, and why Claude is never blocked when the daemon is down.
nav: How approvals work
order: 3
section: Guides
---

# How approvals work

When Claude Code needs your permission to run a tool, Session Inbox can show the request and let you answer it from a notification or the inbox window. There are two ways it does that. The default answers Claude's own prompt and never pauses Claude. The classic mode holds the tool call before Claude asks. You choose in [Settings](settings.md), under **Approvals**, with **How approvals reach the inbox**.

## The default: answer Claude's own prompt

Claude Code runs a `PermissionRequest` hook whenever it is about to ask you for permission. Session Inbox registers for it. When Claude asks:

- **Claude's own prompt appears in Claude as usual.** Nothing is paused or frozen.
- **The same request appears in the inbox at once**, in **Needs you**, with a notification that offers **Allow**, **Deny** and **Open**. The card shows the diff or the full command, and what Claude said before it asked. See [Approving a tool call](using-it.md#approving-a-tool-call).
- **Whichever you answer first wins.** Answer in the inbox and the decision goes straight back to Claude, which carries on while its own prompt goes away. Answer in Claude and the inbox item clears within a second or two.
- **It covers every tool Claude asks about**, not a fixed list: a Read outside the project, an MCP tool, Bash, edits and web fetches alike.
- **Questions work the same way.** When Claude asks you something with `AskUserQuestion`, you can answer from the inbox form while the question stays open in Claude.

Because Claude isn't waiting on a hook, the inbox can offer the decision for a long time. **Wait for an answer** in Settings sets how long: 10 minutes by default, from 1 to 55 minutes. After that the inbox stops answering for Claude. The item doesn't vanish: it stays in **Needs you** as **Waiting in Claude**, with only **Open in Claude**, and its notification is replaced by "Still waiting in Claude: …" with **Open** only. It ends by itself when Claude moves on: the call runs or is denied in Claude, you type a new prompt, or the session stops or ends.

An item that is Claude's own prompt but isn't live (it ran out, or the project's install only observes) shows one quiet line, "Claude is asking in its own window. Answer there.", instead of the buttons. A reply or answer typed into it is refused, because sending one would collide with the prompt on screen.

### What each answer does

- **Allow once** lets this call run.
- **Always allow** echoes the rule Claude itself suggests for that request, as if you had chosen "always allow" in Claude's prompt. If Claude suggests none, Session Inbox writes an allow rule to the project's `.claude/settings.local.json` under `permissions.allow`, the same file and scope as Claude's own "don't ask again for this project". It adds to that file and keeps everything else in it; if the file isn't a JSON object it's left alone and the call is still allowed once.
- **Deny** tells Claude "Denied by the user in Session Inbox." The call doesn't run and Claude carries on.

### Checked live

On a real desktop-app session (Claude Code 2.1.321) in the default mode, a Read outside the project, a question, an Edit (with its diff preview and Claude's sentence before it) and a Bash `rm` were each answered from the inbox. Allow and answers took effect about 30 ms after the decision, while Claude's own prompt was still on screen. The denied command didn't run, and Claude reported the denial. Two things have not been seen yet: answering in Claude first while the inbox item is live, and terminal `claude` sessions. See [what hasn't been verified](troubleshooting.md#not-yet-verified-by-a-person).

## The classic mode: hold the tool call before Claude asks

The classic mode is how Session Inbox worked before. It pauses a tool call in a Claude session until you decide, so Claude shows nothing until you answer or the wait runs out. Because that changes how every session on your machine feels, the rule is deliberately narrow: **it only holds a call when Claude itself would have asked you.**

A call is held only when all of these are true:

1. **The session is in the default permission mode.** Sessions in other modes, such as auto or accept-edits, are never held.
2. **The tool is in the held set.** By default that's Bash, Write, Edit, MultiEdit, NotebookEdit and WebFetch. Change it with **Tools that can be held** in [Settings](settings.md).
3. **No allow rule matches.** If your user, project or local Claude settings already allow the call, Claude wouldn't ask, so neither does Session Inbox. A deny rule wins over an allow rule, as it does in Claude.
4. **The project isn't muted.**

Read-only Bash commands from the safe list (`ls`, `pwd`, `git status`, `git diff` and similar, with no shell operators in them) run without a pause. `AskUserQuestion` is always held, even when the other rules don't apply; muting the project still applies.

Session Inbox reads your allow and deny rules to decide rule 3. It understands `Tool`, `Tool(exact)`, `Tool(prefix:*)`, `Tool(prefix*)`, `Tool(dir/**)` and `WebFetch(domain:host)`, but not every pattern Claude supports. If it misreads a rule, the worst case is that it holds a call Claude wouldn't have asked about; the call is then released to Claude after the wait.

A held call waits up to **120 seconds** for your decision, set by **Wait for an answer** in seconds (15 to 120; the hook itself stops waiting at 120). If you haven't answered by then, Session Inbox lets go and Claude shows its own prompt. The item stays in **Needs you** as **Waiting in Claude**, the same as a prompt that ran out in the default mode. Clicking **Open in Claude** on a held item releases the hold at once, so Claude's own prompt appears and you're never looking at a frozen session.

**Always allow** in this mode writes the rule to the project's `.claude/settings.local.json` as described above. **Deny** tells Claude "Denied by the user in Session Inbox."

### Which settings apply to which mode

| Setting | Default mode | Classic mode |
| --- | --- | --- |
| **Hold tool calls for approval in the inbox** | applies | applies |
| **How approvals reach the inbox** | applies | applies |
| **Wait for an answer** (minutes) | shown, 1 to 55 | hidden |
| **Tools that can be held** | disabled: "Not used while the inbox answers Claude's own prompt." | applies |
| **Wait for an answer** (seconds) | hidden | applies, 15 to 120 |
| **Bash commands never held** | disabled with the same note | applies |

## When approvals aren't answerable from the inbox

- **Holding is switched off.** With **Hold tool calls for approval in the inbox** off, the inbox only observes. Claude's permission prompts still appear in **Needs you**, but with only **Open in Claude**. Turning it off also releases anything being held at that moment.
- **A second install is installed beside this one.** Only one install should answer approvals. The other observes: it shows the same items and notifies, but can't answer. See [GA and beta channels](channels.md).
- **The install is older than the `PermissionRequest` hook.** A reinstall adds it; until then, Claude's prompts reach the inbox only about 6 seconds late and can't be answered from it. The Setup check says so. See [Troubleshooting](troubleshooting.md#the-setup-check-says-the-permissionrequest-hook-is-missing).
- **The project is muted.** Muting a project stops its items from notifying and from being answered here; Claude behaves as if Session Inbox weren't there for it.

## Fail open

Session Inbox must never be the reason Claude is slow or stuck, so the hook is built to fail open:

- If the daemon isn't running, the hook exits immediately with no output, and Claude behaves as if no hooks were installed: its own prompt appears as usual.
- If the daemon is slow to accept an event, the hook gives up after half a second.
- If anything inside the hook goes wrong, including a bad payload or a closed socket, it still exits cleanly with no output.
- The hook never exits with an error code that would block a call.
- If the daemon disappears while a request is waiting, the hook goes quiet rather than denying anything.
- In the default mode the `PermissionRequest` hook prints a decision only when you answer in the inbox. When the wait runs out it prints nothing, which leaves Claude's own prompt on screen. In the classic mode, the only time the hook prints a decision on its own is when the 120 seconds run out, and then it says "ask", which hands the call back to Claude.

## Two channels on one machine

If you run a GA and a beta install side by side, only one of them answers approvals. The other observes: it shows the same items and notifies, but can't answer. See [GA and beta channels](channels.md).
