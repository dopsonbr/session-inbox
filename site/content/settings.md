---
title: Settings
description: Every Session Inbox setting, what it does and its default: approvals, notifications, sessions, storage and updates. Change them in the Settings pane with Cmd-comma; changes apply live.
order: 4
section: Guides
---

# Settings

Open the Settings pane from the inbox window with <kbd>⌘</kbd><kbd>,</kbd>, with the gear button in the header, or with **Settings…** in the menu-bar menu. It is a dialog with five groups: **Approvals**, **Notifications**, **Sessions**, **Storage** and **Updates**. The title shows which install you're looking at (`Settings · ga`, or `beta`).

Each control saves on its own, and the daemon applies the change at once: you don't restart anything, and Claude sessions that are already running pick it up on their next event. Switches save when you click them. Number boxes save when you press <kbd>Enter</kbd> or click away. A row shows "Saving…" and then "Saved", or the daemon's error if it refused the value.

When a value differs from its default, the row shows the default and a **Reset** link. **Reset all to defaults** is at the bottom, next to a link to the [Setup check](troubleshooting.md#the-setup-check-in-the-app). Closing the pane with <kbd>Esc</kbd> throws away text you typed but didn't commit.

[[screenshot settings.png 1440x900 The Settings dialog over the inbox window, showing the Approvals group (the switch for holding tool calls, the choice of how approvals reach the inbox, the wait for an answer, and the settings that only apply to the classic mode) and the start of the Notifications group.]]

## Approvals

These control [how approvals work](holds.md). Rows that don't apply to the mode you chose are greyed out, with a note, or hidden. Everything under the first switch is greyed out while it's off.

| Setting | Default | What it does |
| --- | --- | --- |
| **Hold tool calls for approval in the inbox** | on | When off, the inbox only observes and notifies; Claude asks in its own window. Turning it off releases anything held right now. A second install beside another starts with this off. |
| **How approvals reach the inbox** | **Answer Claude's own prompt (recommended)** | The other choice is **Hold the tool call before Claude asks (classic)**. Recommended: Claude's prompt stays visible in Claude and the inbox answers it; whichever is answered first wins, for every tool Claude asks about. Classic: the inbox holds Bash, edits and web fetches for up to two minutes before Claude shows its own prompt. |
| **Wait for an answer** (minutes) | 10 minutes | Shown only in the recommended mode. Then the inbox stops answering and Claude's prompt stays open in Claude. 1 to 55 minutes. |
| **Tools that can be held** | Bash, Write, Edit, MultiEdit, NotebookEdit, WebFetch | Classic mode only. Only when Claude itself would ask. Questions (`AskUserQuestion`) always come to the inbox. In the recommended mode it's greyed out: "Not used while the inbox answers Claude's own prompt." |
| **Wait for an answer** (seconds) | 120 seconds | Classic mode only; hidden in the recommended mode. Then Claude shows its own prompt. 15 to 120 seconds. |
| **Bash commands never held** | `ls`, `pwd`, `echo`, `cat`, `head`, `tail`, `wc`, `which`, `git status`, `git diff`, `git log` | Classic mode only, with the same greyed-out note otherwise. A command matches when it is the prefix or starts with it plus a space. A command with shell operators in it never counts as safe. |

If another install is on the same Mac, the first row adds a note: only one install should answer approvals, because if both do, each waits for its own answer. See [GA and beta channels](channels.md).

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
| **Install updates automatically** | on | Only while no tool call is held and nothing is being sent. Otherwise you get an **Update now** button. (The daemon also waits for 30 seconds without any session activity.) |

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
