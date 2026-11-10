---
title: Settings
description: Every Session Inbox setting, what it does and its default: approvals, notifications, sessions and updates. Change them in the Settings pane with Cmd-comma; changes apply live.
order: 4
section: Guides
---

# Settings

Open the Settings pane from the inbox window with <kbd>⌘</kbd><kbd>,</kbd>. Settings are grouped as **Approvals**, **Notifications**, **Sessions** and **Updates**. A change applies right away: you don't restart the daemon or your Claude sessions.

[[screenshot settings.png 1100x760 The Settings pane with groups for Approvals, Notifications, Sessions and Updates.]]

Behind the pane, each setting is a row in the daemon's `settings` table. Rows you haven't set use the defaults below. The table is also how you change a setting when the pane isn't available. See [Without the pane](#without-the-pane).

## Approvals

These control [when Session Inbox holds a tool call](holds.md).

| Setting | Default | What it does |
| --- | --- | --- |
| `holds.enabled` | on | Hold tool calls at all. Turn it off and Session Inbox only observes: it still shows and notifies, but never pauses Claude. A second channel installed beside another starts with this off. |
| `holds.tools` | Bash, Write, Edit, MultiEdit, NotebookEdit, WebFetch | The tools that can be held when Claude would ask. |
| `holds.budgetMs` | `120000` | How long, in milliseconds, a held call waits for you before Claude's own prompt takes over. |
| `holds.safeBashPrefixes` | `ls`, `pwd`, `echo`, `cat`, `head`, `tail`, `wc`, `which`, `git status`, `git diff`, `git log` | Read-only Bash commands that are never held. Commands containing shell operators don't count as safe. |
| `questions.answerMode` | `updatedInput` | How your answers to a waiting question travel back. `denyWithReason` is the fallback. The daemon switches to it by itself, per runtime, if answers don't land. |

## Notifications

| Setting | Default | What it does |
| --- | --- | --- |
| `notifications.fallback` | on | Post a plain macOS notification (no buttons) when the menu-bar app isn't running. |
| `notifications.reviewGroupMs` | `30000` | How long, in milliseconds, "ready to review" notifications are collected into one. |

## Sessions

| Setting | Default | What it does |
| --- | --- | --- |
| `titles.generate` | on | Ask Claude for a short title for each session. Off keeps the first prompt as the title. |
| `items.confirmWindowMs` | `300000` | How long, in milliseconds, after you answer before an item with no follow-up from the session is flagged as unconfirmed. |
| `outbox.maxAttempts` | `3` | How many times a reply to an idle session is tried before it's marked failed. |
| `outbox.backoffMs` | `5000` | The wait before the first retry, in milliseconds. Each later retry waits twice as long. |

## Updates

The Updates group holds the automatic-update switch: whether Session Inbox installs a new version by itself when it's safe. The default is on. See [Updating](updating.md) for what that means and how it behaves.

## Without the pane

Settings live in the SQLite database at `~/Library/Application Support/SessionInbox/inbox.db`, in a table named `settings` with a key and a JSON value. This sets `titles.generate` to off:

```bash
sqlite3 ~/Library/Application\ Support/SessionInbox/inbox.db \
  "insert or replace into settings values ('titles.generate', 'false')"
```

Then restart the daemon so it picks the change up:

```bash
launchctl kickstart -k gui/$(id -u)/com.sessioninbox.inboxd
```

Values are JSON, so a number is `120000` and a list is `'["Bash","Write"]'`. A row the daemon can't parse is ignored and the default stands.

## Environment overrides

These are mostly for development and testing:

| Variable | Effect |
| --- | --- |
| `SESSION_INBOX_HOME` | Moves the whole data directory. |
| `SESSION_INBOX_UI_DIR` | Where the daemon serves the UI from. |
| `SESSION_INBOX_CLAUDE` | Path to the `claude` binary. |
| `CLAUDE_CONFIG_DIR` | Where Claude's settings are read from, for allow rules. |
| `SESSION_INBOX_HOLD_SECONDS` | The hook's hold budget, in seconds. |
