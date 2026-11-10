---
title: Using Session Inbox
description: How to use Session Inbox day to day: notification actions, the menu bar and popover, the inbox window queues, answering questions, approving tool calls, replies, snooze, mute and keyboard shortcuts.
nav: Using it
order: 2
section: Get started
---

# Using Session Inbox

Session Inbox has three places you interact with it: notifications, the menu-bar popover and the inbox window. They all show the same items. Each item is one thing a session needs from you: a question, a permission request, a failure, or finished work to look at.

## Notifications

A notification appears when a session needs you. What you can do from it depends on what it's about.

| Notification | Buttons | Notes |
| --- | --- | --- |
| Permission request | **Allow**, **Deny**, **Open** | Only while the request is live, meaning Claude's prompt is open and the inbox can still answer it. These notifications are marked critical, so **Pause notifications** doesn't silence them. |
| Still waiting in Claude | **Open** | Replaces a permission notification when the inbox stops answering: "Still waiting in Claude: …". |
| Question | **Answer**, **Open** | **Answer** opens the item with the form ready. |
| Failure | **Open** | The session stopped with an error or ended abnormally. |
| Ready to review | **Open** | Quiet, and grouped: sessions finishing within 30 seconds of each other come as one "N sessions ready to review" notification. |

Clicking the notification body opens the item in the inbox window. Allow and Deny act at once and open nothing.

When the menu-bar app isn't allowed to show notifications, or isn't running, Session Inbox posts a plain macOS notification instead, with no buttons, so you're still told. Open the item in the inbox to answer it. A Focus mode on your Mac hides banners whatever Session Inbox does. If notifications aren't arriving, see [Troubleshooting](troubleshooting.md#notifications).

> **Note** Nobody has clicked the app's own notification buttons on a real desktop yet. See [what hasn't been verified](troubleshooting.md#not-yet-verified-by-a-person). Allow and Deny from the inbox window itself have been checked live.

## Menu bar and popover

The menu-bar icon carries a badge with the number of items that **need you**. Click it for the popover:

- a header with the counts ("2 need you", "1 working · 3 to review");
- the items that need you, one row each. Click a row to open it in the inbox window;
- when nothing needs you, up to five **Ready to review** rows with a one-line summary of what was done;
- a banner row when an update is ready, and a **Setup** row when the setup check has something for you;
- an **Open inbox** button. The shortcut <kbd>⌘</kbd><kbd>⇧</kbd><kbd>I</kbd> opens the main window from anywhere.

[[screenshot popover.png 380x520 The menu-bar popover: a header with the count of items that need you, a Setup row saying how many checks need attention, rows for each item with its title, the kind of request and the project, and an Open inbox button at the bottom.]]

Right-click the icon for its menu:

- **Open inbox**
- **Pause notifications**, a switch that silences everything except permission requests until you turn it off
- **Notifications are off — Open Settings…**, shown only while macOS isn't allowing the app's notifications
- the daemon's state, and the app's version
- **Check for Updates…**
- **Quit Session Inbox**

The popover closes when you click away. Closing the main window only hides it; the app keeps running. Quit from the menu.

## The inbox window

The window has a tree on the left (project, then session, then subagent), a queue in the middle and the selected item on the right. The queues are:

- **Needs you:** questions, permission requests and failures. This is the list that drives the badge.
- **Working:** sessions that are running right now. Nothing for you to do, but handy to see what's in flight.
- **Ready to review:** sessions that stopped cleanly. Open one when you're ready to look at the result.
- **Snoozed:** items you've put off. They come back at the time you chose and notify once.

The inbox never decides which queue an item belongs in. The daemon does, and the window shows its answer.

The selected item shows when and where the session runs (the desktop app or the CLI, its worktree or branch, its state and its last activity). For a finished or failed session it also shows **Claude's last message**, in full and formatted as Markdown, so you can review the result without opening Claude. A long message is collapsed; use **Show all** to expand it.

Session titles come from the Claude desktop app's own title for the session when there is one. Otherwise they start as your first prompt and are replaced a moment later by a short title written by Claude, which needs the `claude` CLI to be logged in. Turn that off with **Generate short session titles** in [Settings](settings.md).

The left side also has a **Setup check** entry that opens the [Setup page](troubleshooting.md#the-setup-check-in-the-app).

## Answering questions

When Claude asks a question with `AskUserQuestion`, the item shows every question in one form. Pick an option for each, or type your own answer under **Other**. Several questions go back together when you choose **Send answers**.

If Claude is waiting right now, the answers go straight back, and the session continues, while the question stays open in Claude until it takes them. This has been checked live against a desktop session in both modes. If the question isn't live any more (the session was idle when it asked), the inbox sends your answer as a new message to the session instead, which needs the `claude` CLI to be logged in.

Your in-progress answers are saved as you type. Close the window and come back, and they're still there.

## Approving a tool call

A permission item shows what Claude wants to do, so you can decide without opening Claude:

- **For Edit, MultiEdit, Write and NotebookEdit:** the diff of the change, with line numbers, the file's path, how many lines were added and removed, and a note when it's a new file. A diff of more than 40 lines starts collapsed; choose **Show all** to expand it.
- **For Bash:** the full command, its description, and the folder it runs in.
- **For WebFetch:** the URL and what Claude wants from it.
- **Above all of these:** what Claude said just before it asked, so you can see why.

[[screenshot approval-diff.png 1440x900 The inbox window with a permission request for a file edit selected: the text Claude wrote before asking, the file path with the number of added and removed lines, a diff with old and new line numbers and green and red rows, and the Allow once, Always allow and Deny buttons.]]

You have three choices:

- **Allow once** lets this call run.
- **Always allow** lets it run and adds the rule Claude itself suggests for that request, so Claude doesn't ask again for this kind of call. When Claude suggests none, or in the classic mode, it adds a rule to the project's `.claude/settings.local.json`, the same place Claude's own "don't ask again for this project" writes to.
- **Deny** stops the call. Claude is told "Denied by the user in Session Inbox." and carries on.

In the default mode, Claude's own prompt stays on screen in Claude while you decide here, and whichever you answer first wins. Allow and answers took effect about 30 ms after the decision in testing. In the classic mode, where the call is held, an allow ran it half a second later, and the very first Bash call of a Claude session takes Claude itself about ten seconds to start, however long it was held.

When the inbox stops answering (the wait ran out, or this install only observes), the card shows "Claude is asking in its own window. Answer there." with **Open in Claude**, and the item is marked **Waiting in Claude** in the queue. See [How approvals work](holds.md) for the two modes and what each does when you don't answer.

## Replies

You can send a free-text reply to a session from its item. How it travels depends on the session:

- If Claude is paused on a held call (classic mode), the reply goes back through that call and is shown to Claude as "The user replied: …". A reply to an item that's Claude's own prompt, or waiting in Claude, is refused: answer in Claude.
- If the session is idle, the reply is sent as a new message to that same session. This needs the `claude` CLI to be logged in. When it isn't, the reply box is replaced by a sentence saying so and an **Open in Claude** button. See [Troubleshooting](troubleshooting.md#replies-dont-send-or-titles-dont-change).
- Replies are never sent into a session that's in the middle of a turn.

A reply shows as pending, then delivered once the session's next activity confirms it arrived. If nothing confirms it within five minutes, the item is flagged as unconfirmed so you know to check.

## Snooze, dismiss and mute

Each item has a **Snooze** menu for putting it aside:

- **Snooze 15 minutes**, **Snooze 1 hour** or **Snooze until tomorrow 9:00**. The item leaves **Needs you** and comes back, with one notification, when the time is up.
- **Dismiss** closes the item without answering it.
- **Mute** the project stops that project's items from notifying and from being answered here. Claude behaves as if Session Inbox weren't there for that project. The same menu says **Unmute** once it's muted, and [Settings](settings.md) lists muted projects with an **Unmute** button.

**Pause notifications** in the menu-bar menu silences everything except permission requests, until you turn it off.

## Open in Claude

Choose **Open in Claude** when something needs real work. It opens the exact session:

- Desktop sessions open in the Claude desktop app, on that session. This has been checked live.
- CLI sessions open through Claude's `claude://resume` link, and a ready-to-paste command is copied to your clipboard as well: `cd <dir> && claude --resume <id>`. The link for CLI sessions hasn't been checked on a real session yet.

If Claude is paused on a held call (classic mode), **Open in Claude** releases it first, so Claude's own prompt is on screen when you arrive and nothing is frozen. Each item's activity list also has a **Full transcript in Claude** link that does the same.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>I</kbd> | Open the inbox window from anywhere |
| <kbd>⌘</kbd><kbd>K</kbd> | Jump to a session or project by name |
| <kbd>⌘</kbd><kbd>↵</kbd> | Send answers, allow once, or send the reply: whichever is the main action of the selected item |
| <kbd>⌘</kbd><kbd>⌫</kbd> | Deny the permission request on screen. Ignored while you're typing, so it still deletes text. |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move through the session tree |
| <kbd>⌘</kbd><kbd>,</kbd> | Open [Settings](settings.md) |

<kbd>⌘</kbd><kbd>↵</kbd>, <kbd>⌘</kbd><kbd>⌫</kbd>, <kbd>⌘</kbd><kbd>K</kbd> and <kbd>⌘</kbd><kbd>,</kbd> work in the inbox window, not in the popover.
