---
title: Install
description: Install Session Inbox on Apple silicon with one command, see what it changes on your Mac, and learn how to install from source, try it in one project, or uninstall.
order: 1
section: Get started
---

# Install

Session Inbox installs with one command on Apple silicon Macs. You need macOS and either the Claude desktop app or the `claude` CLI. You don't need Bun or Rust.

## One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/dopsonbr/session-inbox/main/install.sh | sh
```

The script downloads the latest [GitHub release](https://github.com/dopsonbr/session-inbox/releases), verifies its SHA-256 checksum, and runs the `session-inbox install` command bundled inside it. That command does the actual setup, and you can re-run it safely: a second run changes nothing.

If you'd rather read the script before piping it to a shell, it is [`install.sh`](https://github.com/dopsonbr/session-inbox/blob/main/install.sh) in the repository.

To install a specific version instead of the latest, set `SESSION_INBOX_VERSION`:

```bash
curl -fsSL https://raw.githubusercontent.com/dopsonbr/session-inbox/main/install.sh | SESSION_INBOX_VERSION=v0.2.0 sh
```

## What it changes on your Mac

The installer touches these places and nothing else:

| Where | What |
| --- | --- |
| `~/Library/Application Support/SessionInbox/` | The `inbox-hook` and `inboxd` binaries, the UI, the SQLite database, the daemon's socket and token files, and its log. |
| `~/Library/LaunchAgents/com.sessioninbox.inboxd.plist` | A launchd agent named `com.sessioninbox.inboxd` that keeps the daemon running and starts it at login. |
| `~/.claude/settings.json` | Hooks for Session Inbox are merged in. The file is backed up first (`settings.json.bak-<timestamp>` beside it), everything else in it is kept, and only entries for `inbox-hook` are ever touched. |
| `~/Applications/Session Inbox.app` | The menu-bar app. It is opened after install and registers itself to launch at login. |
| `~/.local/bin/session-inbox` | A symlink to the `session-inbox` command. Make sure `~/.local/bin` is on your `PATH`. |

Because the hooks live in your user-level Claude settings, they apply to every Claude session on the machine. That is the point, and it is why the hook is built to [fail open](holds.md#fail-open).

## First-run checklist

1. **Allow notifications.** macOS asks the first time Session Inbox posts one. If you missed the prompt, open System Settings, then Notifications, then Session Inbox.
2. **Set the alert style to Alerts.** The app is ad-hoc signed, and macOS only shows the Allow, Deny and Answer buttons on notifications whose style is **Alerts**, not Banners.
3. **Restart any Claude session that's already open.** Claude reads hooks when a session starts. New sessions pick them up on their own.
4. **Run the setup check:**

   ```bash
   session-inbox doctor
   ```

   It tells you whether the daemon is running, the hooks are installed, `claude` is on your path and logged in, and notifications are set up. See [Troubleshooting](troubleshooting.md).

Session titles and free-text replies call the `claude` CLI. If you only use the desktop app, log the CLI in once by running `claude` in a terminal. Desktop-app sign-in isn't shared with the CLI.

## Install from source

Use this on Intel Macs, or when you want to work on Session Inbox itself. You need [Bun](https://bun.sh) 1.4 or later, Rust (`brew install rust`) for the menu-bar app, and the Claude desktop app or the `claude` CLI.

```bash
git clone https://github.com/dopsonbr/session-inbox && cd session-inbox
```

```bash
bun install
```

The install script is a dry run by default. It prints every file, launchd and `settings.json` change, including a diff of your Claude settings, and applies nothing:

```bash
bun scripts/install.ts
```

Review the output, then apply it. `--app` also builds the menu-bar app, installs it into `~/Applications` and opens it. The first Rust build takes a few minutes:

```bash
bun scripts/install.ts --yes --app
```

Without `--app` you get the daemon, the hook and the browser UI, but no menu-bar badge or native notifications.

## Try it in one project first

To leave your global Claude settings alone, install the hooks into a single repository and run the daemon in a terminal. This works from a source checkout:

```bash
bun scripts/install.ts --yes --no-launchd --settings /path/to/repo/.claude/settings.local.json
```

```bash
bun apps/daemon/src/main.ts
```

The daemon logs the inbox URL. Press Ctrl-C to stop it. Only sessions started in that repository will report to it.

## Uninstall

Remove everything Session Inbox added:

```bash
session-inbox uninstall
```

If you installed from source, there's a dry run first, then the real thing. It removes only Session Inbox's hooks and launchd agent; add `--app` to remove the app too:

```bash
bun scripts/uninstall.ts
```

```bash
bun scripts/uninstall.ts --yes --app
```

Your data stays in `~/Library/Application Support/SessionInbox/` until you delete that folder. To undo the hooks by hand, restore the `settings.json.bak-<timestamp>` file the installer left next to your Claude settings, or delete the entries that run `inbox-hook`.
