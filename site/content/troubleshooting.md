---
title: Troubleshooting
description: Fix common Session Inbox problems with session-inbox doctor: daemon offline, nothing showing up, Claude pausing before a command, missing notification buttons, logs, and how to restart the daemon.
order: 7
section: Guides
---

# Troubleshooting

Start with the setup check. It looks at the things that go wrong most often and tells you which one it found.

## Run the setup check

```bash
session-inbox doctor
```

It reports:

- whether the daemon is running;
- whether the hooks are installed in `~/.claude/settings.json`;
- which channel holds tool calls, if you run [GA and beta](channels.md) together;
- whether `claude` is on your `PATH` and logged in;
- whether notifications are allowed.

If the check points at something, the sections below say how to fix it.

## The menu-bar app says "daemon offline"

The daemon isn't running or the app can't reach it. Ask launchd what state it's in:

```bash
launchctl print gui/$(id -u)/com.sessioninbox.inboxd
```

Then read the end of the daemon log, which usually names the problem:

```bash
tail -n 50 ~/Library/Application\ Support/SessionInbox/inboxd.log
```

To restart the daemon:

```bash
launchctl kickstart -k gui/$(id -u)/com.sessioninbox.inboxd
```

The menu-bar app reconnects by itself, even if the daemon comes back on a different port. A call that was held when you restarted falls back to Claude's own prompt.

## Nothing shows up for a session

Claude reads hooks when a session starts. **Restart the session**, and it will report in. If it still doesn't, check that `~/.claude/settings.json` lists `inbox-hook` under `hooks`:

```bash
grep -c inbox-hook ~/.claude/settings.json
```

A count of zero means the hooks aren't installed. Run `session-inbox doctor`, or re-run the [installer](install.md); it's safe to repeat.

## Claude pauses before running a command

That's a held approval waiting for you: Session Inbox is holding the call so you can allow it from a notification. It falls back to Claude's own prompt after 120 seconds, or at once when you click **Open in Claude**. See [When it holds a tool call](holds.md).

If you'd rather it never paused Claude, turn off `holds.enabled` in [Settings](settings.md).

## There are no buttons on notifications

macOS only shows action buttons on notifications whose style is **Alerts**. Open System Settings, then Notifications, then Session Inbox, and change the alert style from Banners to Alerts. If Session Inbox isn't listed there, nothing has been posted yet, or notifications were denied; allow them from the same pane once it appears.

## Session titles don't change, or replies don't send

Both call the `claude` CLI. Run `session-inbox doctor` to see whether `claude` is on the path the daemon uses and whether it's logged in. The Claude desktop app's sign-in isn't shared with the CLI, so log the CLI in once by running `claude` in a terminal.

## Where the logs are

Everything is under `~/Library/Application Support/SessionInbox/`:

| File | What's in it |
| --- | --- |
| `inboxd.log` | The daemon's log: launchd's stdout and stderr. |
| `update.log` | Update attempts. See [Updating](updating.md#the-update-log). |

For a second channel, use `SessionInbox-beta` in place of `SessionInbox`.

## Start from a clean slate

If an install is in a bad state, run the installer again. It repairs missing pieces and changes nothing that's already right. To remove Session Inbox completely, see [Uninstall](install.md#uninstall).

If you think you've found a bug, [open an issue](https://github.com/dopsonbr/session-inbox/issues) with the output of `session-inbox doctor` and the last lines of `inboxd.log`.
