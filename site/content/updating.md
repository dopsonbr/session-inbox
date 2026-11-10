---
title: Updating
description: How Session Inbox updates itself from GitHub Releases, when it is safe to install, how to update by hand with session-inbox update, where the log is, and how to roll back to a specific version.
order: 5
section: Guides
---

# Updating

Session Inbox keeps itself up to date from [GitHub Releases](https://github.com/dopsonbr/session-inbox/releases). You can leave it alone, update on demand, or turn automatic updates off.

## Automatic updates

The daemon checks GitHub Releases every few hours. When a newer version exists, it installs it by itself, but only when that can't disturb anything:

- No tool call is being held, so Claude isn't waiting on you.
- Nothing is in flight, such as a reply being sent to a session.

If either is true when a new version turns up, the daemon waits and tries again later. A session is never interrupted for an update.

When an update is ready but hasn't installed yet, the inbox shows a banner with an **Update now** button. Click it when you want the update right away instead of waiting for the next check.

The daemon restarts as part of an update, and the menu-bar app reconnects by itself. If a call was being held at that moment, it falls back to Claude's own prompt, which is harmless.

### Turn automatic updates off

Open [Settings](settings.md) with <kbd>⌘</kbd><kbd>,</kbd> and switch off automatic updates in the **Updates** group. Session Inbox then only tells you when a new version is available, and you decide when to install it.

## Update from the command line

Check whether a newer version exists without installing anything:

```bash
session-inbox update --check
```

Install the latest version:

```bash
session-inbox update
```

## What an update replaces

An update swaps in the new `inbox-hook` and `inboxd` binaries and the UI under `~/Library/Application Support/SessionInbox/`, then restarts the daemon. It keeps your data: the database, your settings, your session history and your token stay as they were.

The only network traffic Session Inbox makes is the update check and the download, both to GitHub. See [privacy](how-it-works.md#privacy).

## The update log

Each update attempt is recorded in `update.log` in the same folder:

```bash
tail -n 40 ~/Library/Application\ Support/SessionInbox/update.log
```

If an update didn't happen when you expected, start there.

## Roll back to a specific version

Run the installer again and name the version you want. Each release is kept on GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/dopsonbr/session-inbox/main/install.sh | SESSION_INBOX_VERSION=v0.2.0 sh
```

This replaces the installed binaries with that version and leaves your data alone. If you want to stay on it, turn off automatic updates first, or the daemon will move forward again at its next check.

Browse the available versions on the [releases page](https://github.com/dopsonbr/session-inbox/releases), and read what changed in the [Changelog](changelog.md).
