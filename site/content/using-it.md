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
| Permission request | **Allow**, **Deny**, **Open** | Only while Claude is actually waiting on you. These notifications are marked critical, so **Pause notifications** doesn't silence them. |
| Question | **Answer**, **Open** | **Answer** opens the item with the form ready. |
| Failure | **Open** | The session stopped with an error or ended abnormally. |
| Ready to review | **Open** | Quiet, and grouped: several sessions finishing within 30 seconds come as one "N sessions ready to review" notification. |

Clicking the notification body opens the item in the inbox window. Allow and Deny act at once and open nothing.

If the buttons don't show up, set the alert style for Session Inbox to **Alerts** in System Settings, then Notifications. See [Install](install.md#first-run-checklist).

## Menu bar and popover

The menu-bar icon carries a badge with the number of items that **need you**. Click it for the popover, a compact list of those items. Click a row to open it in the inbox window, or choose **Open inbox**. The shortcut <kbd>⌘</kbd><kbd>⇧</kbd><kbd>I</kbd> opens the main window from anywhere.

The popover closes when you click away. Closing the main window only hides it; the app keeps running. Quit from the menu-bar icon.

[[screenshot popover.png 420x560 The menu-bar popover listing the items that need you, each with the project, the session title and a one-line summary.]]

## The inbox window

The window has a tree on the left (project, then session, then subagent), a queue in the middle and the selected item on the right. The queues are:

- **Needs you:** questions, permission requests and failures. This is the list that drives the badge.
- **Working:** sessions that are running right now. Nothing for you to do, but handy to see what's in flight.
- **Ready to review:** sessions that stopped cleanly. Open one when you're ready to look at the result.
- **Snoozed:** items you've put off. They come back at the time you chose and notify once.

The inbox never decides which queue an item belongs in. The daemon does, and the window shows its answer.

Session titles start as your first prompt and are replaced a moment later by a short title written by Claude. Turn that off with `titles.generate` in [Settings](settings.md).

## Answering questions

When Claude asks a question with `AskUserQuestion`, the item shows every question in one form. Pick an option for each, or type your own answer under **Other**. Several questions go back together when you choose **Send answers**.

If Claude is waiting right now, the answers go straight back to the call it's paused on, and the session continues. If the question isn't live any more (the session was idle when it asked), the inbox sends your answer as a new message to the session instead.

Your in-progress answers are saved as you type. Close the window and come back, and they're still there.

## Approving a tool call

A permission item shows what Claude wants to do, so you can decide without opening Claude:

- **For an edit or write:** the diff of the change.
- **For Bash:** the full command, not a shortened version.
- **Above both:** what Claude said just before it asked, so you can see why.

[[screenshot approval-diff.png 1200x760 A permission request for a file edit, showing the diff of the change, the text Claude wrote before asking, and the Allow once, Always allow and Deny buttons.]]

You have three choices:

- **Allow once** lets this call run.
- **Always allow** lets it run and adds a rule to the project's `.claude/settings.local.json`, so Claude doesn't ask again for this kind of call. This is the same place Claude's own "don't ask again for this project" writes to.
- **Deny** stops the call. Claude is told you said no and carries on.

The call is only paused while the session is in a state where Claude would have asked you anyway. See [When it holds a tool call](holds.md) for the rules and the 120 second fallback.

## Replies

You can send a free-text reply to a session from its item. How it travels depends on the session:

- If Claude is paused on a held call, the reply goes back through that call and is shown to Claude as "The user replied: …".
- If the session is idle, the reply is sent as a new message to that same session. This needs the `claude` CLI to be logged in. See [Troubleshooting](troubleshooting.md).
- Replies are never sent into a session that's in the middle of a turn.

A reply shows as pending, then delivered once the session's next activity confirms it arrived. If nothing confirms it within five minutes, the item is flagged as unconfirmed so you know to check.

## Snooze, dismiss and mute

Each item has a menu for putting it aside:

- **Snooze** for 15 minutes, 1 hour, or until tomorrow at 9:00. The item leaves **Needs you** and comes back, with one notification, when the time is up.
- **Dismiss** closes the item without answering it.
- **Mute project** stops that project's items from notifying and from holding tool calls. Claude behaves as if Session Inbox weren't there for that project. Un-mute it from the same menu.

**Pause notifications** in the menu-bar app silences everything except permission requests, until you turn it off.

## Open in Claude

Choose **Open in Claude** when something needs real work. It opens the exact session:

- Desktop sessions open in the Claude desktop app, on that session.
- CLI sessions open through Claude's `claude://resume` link, and a ready-to-paste command is copied to your clipboard as well: `cd <dir> && claude --resume <id>`.

If Claude is paused on a held call, **Open in Claude** releases it first, so Claude's own prompt is on screen when you arrive and nothing is frozen.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>I</kbd> | Open the inbox window from anywhere |
| <kbd>⌘</kbd><kbd>K</kbd> | Jump to a session by name |
| <kbd>⌘</kbd><kbd>↵</kbd> | Send answers, allow once, or send the reply: whichever is the main action of the selected item |
| <kbd>⌘</kbd><kbd>⌫</kbd> | Deny the permission request on screen. Ignored while you're typing, so it still deletes text. |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move through the session tree |
| <kbd>⌘</kbd><kbd>,</kbd> | Open [Settings](settings.md) |
