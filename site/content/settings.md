---
title: Settings
description: Every Session Inbox setting, what it does and its default: approvals, notifications, sessions, storage and updates. Change them in the Settings pane with Cmd-comma; changes apply live.
order: 4
section: Guides
---

# Settings

Open the Settings pane from the inbox window with <kbd>⌘</kbd><kbd>,</kbd>, or with the gear button in the header. It is a dialog with five groups: **Approvals**, **Notifications**, **Sessions**, **Storage** and **Updates**. The title shows which install you're looking at (`Settings · ga`, or `beta`).

Each control saves on its own, and the daemon applies the change at once: you don't restart anything, and Claude sessions that are already running pick it up on their next event. Switches save when you click them. Number boxes save when you press <kbd>Enter</kbd> or click away. A row shows "Saving…" and then "Saved", or the daemon's error if it refused the value.

When a value differs from its default, the row shows the default and a **Reset** link. **Reset all to defaults** is at the bottom, next to a link to the [Setup check](troubleshooting.md#the-setup-check-in-the-app). Closing the pane with <kbd>Esc</kbd> throws away text you typed but didn't commit.

[[screenshot settings.png 1100x760 The Settings dialog over the inbox window, showing the Approvals group (a switch for holding tool calls, the tools that can be held, the wait for an answer and the Bash commands never held) and the start of the Notifications group.]]

## Approvals

These control [when Session Inbox holds a tool call](holds.md). The three rows under the first switch are greyed out while it's off.

| Setting | Default | What it does |
| --- | --- | --- |
| **Hold tool calls for approval in the inbox** | on | When off, the inbox only observes and notifies; Claude asks in its own window. Turning it off releases anything held right now. A second install beside another starts with this off. |
| **Tools that can be held** | Bash, Write, Edit, MultiEdit, NotebookEdit, WebFetch | Only when Claude itself would ask. Questions (`AskUserQuestion`) always come to the inbox. |
| **Wait for an answer** | 120 seconds | Then Claude shows its own prompt. 15 to 120 seconds. |
| **Bash commands never held** | `ls`, `pwd`, `echo`, `cat`, `head`, `tail`, `wc`, `which`, `git status`, `git diff`, `git log` | A command matches when it is the prefix or starts with it plus a space. A command with shell operators in it never counts as safe. |

If another install is on the same Mac, the first row adds a note: only one install should hold calls, because if both do, each waits for its own answer. See [GA and beta channels](channels.md).

## Notifications

| Setting | Default | What it does |
| --- | --- | --- |
| **Notify even when the menu-bar app isn't running** | on | Posts a plain macOS notification instead. It has no buttons. |
| **Group finished sessions** | 30 seconds | Sessions that finish within this window share one notification. 0 to 600 seconds. |

## Sessions

| Setting | Default | What it does |
| --- | --- | --- |
| **Generate short session titles** | on | Runs `claude -p` with Haiku once per session. Titles that the Claude desktop app already gives a session are used instead. |
| **Muted projects** | none | The projects you've muted from an item's **Snooze** menu, each with an **Unmute** button. |

## Storage

| Setting | Default | What it does |
| --- | --- | --- |
| **Keep history for** | 14 days | Finished items, sessions and their events older than this are deleted, once a day. 1 to 365 days. Open, snoozed and answered items, and replies still waiting to go out, are kept. |

## Updates

| Setting | Default | What it does |
| --- | --- | --- |
| **Check for new versions** | on | Asks GitHub for the latest release every few hours. Nothing else leaves this Mac. |
| **Install updates automatically** | on | Only while no tool call is held and nothing is being sent. Otherwise you get an **Update now** button. |

See [Updating](updating.md) for what each switch does in practice.

## Settings the pane doesn't show

A few internal settings have no control in the pane. They are rows in the `settings` table of the SQLite database at `~/Library/Application Support/SessionInbox/inbox.db`, with a key and a JSON value:

| Key | Default | What it does |
| --- | --- | --- |
| `questions.answerMode` | `"updatedInput"` | How your answers to a waiting question travel back. `"denyWithReason"` is the fallback; the daemon switches to it by itself, per runtime, if answers don't land. In testing on a desktop session, `updatedInput` landed. |
| `items.confirmWindowMs` | `300000` | How long, in milliseconds, after you answer before an item with no follow-up from the session is flagged as unconfirmed. |
| `outbox.maxAttempts` | `3` | How many times a reply to an idle session is tried before it's marked failed. |
| `outbox.backoffMs` | `5000` | The wait before the first retry, in milliseconds. Each later retry waits twice as long. |
| `updates.checkIntervalMs` | `21600000` | How often the daemon checks for a release, in milliseconds (6 hours, never less than a minute). |

For example, this lets a reply to an idle session be tried five times instead of three:

```bash
sqlite3 ~/Library/Application\ Support/SessionInbox/inbox.db \
  "insert or replace into settings values ('outbox.maxAttempts', '5')"
```

The daemon reads these rows only when it starts, so restart it afterwards:

```bash
launchctl kickstart -k gui/$(id -u)/com.sessioninbox.inboxd
```

Values are JSON, so a number is `120000` and a text value is `'"denyWithReason"'`. A row the daemon can't parse is ignored and the default stands. A change you make in the pane always wins from then on.

## Environment overrides

These are mostly for development and testing:

| Variable | Effect |
| --- | --- |
| `SESSION_INBOX_HOME` | Moves the whole data directory. |
| `SESSION_INBOX_UI_DIR` | Where the daemon serves the UI from. |
| `SESSION_INBOX_CLAUDE` | Path to the `claude` binary. |
| `CLAUDE_CONFIG_DIR` | Where Claude's settings are read from, for allow rules. |
| `SESSION_INBOX_HOLD_SECONDS` | The hook's hold budget, in seconds. |
