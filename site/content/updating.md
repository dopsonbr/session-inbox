---
title: Updating
description: How Session Inbox updates itself from GitHub Releases, when it is safe to install, how to update by hand with session-inbox update, where the log is, and how to roll back to a specific version.
order: 5
section: Guides
---

# Updating

Session Inbox keeps itself up to date from [GitHub Releases](https://github.com/dopsonbr/session-inbox/releases). You can leave it alone, update on demand, or turn automatic updates off. Updates apply to the everyday (GA) install. A [beta install](channels.md) never updates from releases.

## Automatic updates

The daemon checks for a new release about a minute after it starts, and then about every 6 hours. When a newer version exists it installs it by itself, but only when that can't disturb a session. All of these must be true:

- No tool call is being held, so Claude isn't waiting on you.
- No reply is being sent to a session.
- No Claude session has sent an event in the last 30 seconds, so nothing is mid-turn.

If any of them is false, the daemon waits and installs as soon as all three hold. A session is never interrupted for an update. An install that came from source only shows the update; it doesn't install it by itself.

When an update is available, the inbox shows a banner under its header: "Session Inbox <version> is available". It has an **Update now** button, a **Release notes** link and **Not now**, which hides the banner until you reload the window. The popover shows a one-line version of it with an **Update** button. Click the button when you want the update right away: it doesn't wait for the quiet conditions above.

While it installs, the banner reads "Updating to <version>…" and names the step: downloading, verifying, installing, restarting. If it fails, the banner says "Couldn't update to <version>", gives the reason and offers **Try again**. A version that failed is never retried automatically, only by hand.

The daemon restarts as part of an update, and the menu-bar app reconnects by itself. If a call was being held at that moment, it falls back to Claude's own prompt, which is harmless. Claude's hooks keep failing open during the swap, so a session never stalls on it. The header shows the version you're on, with a **Check for updates** link, and a **What's new** link right after an update. **Check for Updates…** in the menu-bar menu opens the same check.

This was tested end to end under launchd against a local release server: a held call blocked the automatic update, it applied after 30 seconds of quiet, and a corrupted download was refused. It hasn't yet run against a real GitHub Release, because none has been published.

### Turn automatic updates off

Open [Settings](settings.md) and, in the **Updates** group, switch off **Install updates automatically**. Session Inbox then still checks, and shows the **Update now** banner, but you decide when to install. (The daemon will move forward on its own again if you switch it back on.)

To stop the checks too, switch off **Check for new versions**. The daemon then never contacts GitHub by itself. **Check for updates** in the header still works when you click it.

## Update from the command line

Check whether a newer version exists without installing anything:

```bash
session-inbox update --check
```

Without `--yes`, `session-inbox update` is a dry run: it says what it would do and changes nothing.

```bash
session-inbox update
```

Install the latest version:

```bash
session-inbox update --yes
```

`session-inbox status` shows what's installed and running. On a source install, `update --yes` replaces it with the release build.

## What an update replaces

An update downloads the release, checks its SHA-256, and runs the new version's own installer with the choices your install was made with (kept in `install.json`). That swaps in the new `inbox-hook`, `inboxd` and `session-inbox` binaries and the UI under `~/Library/Application Support/SessionInbox/`, re-merges the hooks, reloads the launchd agent and, if you installed the menu-bar app, replaces it. The app is reopened only if it was running. It keeps your data: the database, your settings, your session history and your token stay as they were.

The only network traffic Session Inbox makes is the update check and the download, both to GitHub. See [privacy](how-it-works.md#privacy).

## The update log

Each update attempt is recorded in `update.log` in the same folder, and `update-state.json` holds the progress of the last one:

```bash
tail -n 40 ~/Library/Application\ Support/SessionInbox/update.log
```

If an update didn't happen when you expected, start there.

## Roll back to a specific version

Run the installer again and name the version you want. Each release is kept on GitHub. The `v` is optional:

```bash
curl -fsSL https://raw.githubusercontent.com/dopsonbr/session-inbox/main/install.sh | SESSION_INBOX_VERSION=v0.2.0 sh
```

This replaces the installed binaries with that version and leaves your data alone. Database changes between versions only add tables and columns, but going back across one hasn't been tested. If you want to stay on the older version, turn off **Install updates automatically** first, or the daemon will move forward again at its next check.

Browse the available versions on the [releases page](https://github.com/dopsonbr/session-inbox/releases), and read what changed in the [Changelog](changelog.md).

## Install and update from a mirror

To install and update from somewhere other than GitHub, point the installer at your own copy of the releases. Set `SESSION_INBOX_RELEASES_URL` to a GitHub-style releases API (`<url>/latest` and `<url>/tags/v<version>` must answer). If the files live somewhere else, also set `SESSION_INBOX_ASSET_URL`, the download base. `{tag}` and `{version}` in it are filled in, so `https://mirror.example/session-inbox/{tag}` works, and a flat directory needs neither:

```bash
curl -fsSL https://raw.githubusercontent.com/dopsonbr/session-inbox/main/install.sh | SESSION_INBOX_RELEASES_URL=https://mirror.example/releases sh
```

The installer records these in `install.json` and in the launchd agent's environment, so the daemon's update checks and every later `session-inbox update` use the same mirror, and an update keeps them. Without them, releases come from GitHub.
