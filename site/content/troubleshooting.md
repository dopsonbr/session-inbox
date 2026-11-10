---
title: Troubleshooting
description: Fix common Session Inbox problems with session-inbox doctor and the Setup check in the app: daemon offline, nothing showing up, notifications that never appear, replies that don't send, logs, and what hasn't been verified by a person yet.
order: 7
section: Guides
---

# Troubleshooting

Start with the setup check. It looks at the things that go wrong most often and tells you which one it found. There are two ways to run it, and they print the same thing.

## Run the setup check

In a terminal:

```bash
session-inbox doctor
```

Each line starts with a mark: `✓` fine, `!` needs attention, `✗` a problem, `·` information. A line that has a fix ends with it, as `→ run:` (a command to copy) or `→ open:` (a page to open). The last line sums up: "Everything looks good", or how many checks failed or need attention. The command exits with 0 only when nothing failed, so you can use it in a script. For the raw report, add `--json`:

```bash
session-inbox doctor --json
```

The checks, in order:

- **Session Inbox is running**: the daemon's version and build, and how long it has been up.
- **Claude Code hooks**: whether `~/.claude/settings.json` registers every hook event and points at this install's `inbox-hook`.
- **Hook events**: whether any session has reported yet. If not, restart the sessions that were already open.
- **Approvals**: whether this install holds tool calls, or only observes. If a [second channel](channels.md) is installed, it says so.
- **claude command-line tool**: whether `claude` is on the path the daemon uses, and logged in.
- **Menu-bar app**: whether the app is connected, and whether its version matches the daemon's.
- **Notifications**: whether macOS lets the app show them, which style, and whether the plain fallback is covering for it.
- **Updates**: the version, when it last checked and whether auto-update is on.
- **Storage**: the database's size and how long history is kept.

If the daemon doesn't answer within 3 seconds, `doctor` says so and checks what it can from the outside instead: the install folder, the binaries, the launchd agent, the hooks in your settings file and the last lines of `inboxd.log`. It then suggests the command to restart the daemon.

## The Setup check in the app

The inbox window has the same check as a page. Open it from **Setup check** in the left column, from the link at the bottom of [Settings](settings.md), from the **Setup** row in the popover (shown when something needs attention), or at `#/setup`.

[[screenshot setup.png 1440x900 The Setup page in the inbox window: a summary line saying how many checks need attention, then one row per check (Session Inbox is running, Claude Code hooks, Hook events, Approvals, claude command-line tool, Menu-bar app, Notifications, Updates, Storage), each with a status mark, a sentence of detail and, where there is one, a fix button. Re-check and Send test notification buttons sit at the top right.]]

The first time, before any session has reported, it opens with a short **Welcome** that lists three steps: allow notifications, restart Claude sessions that were already open, and ask Claude for something that needs approval. A fix is either a button that opens a page (such as System Settings) or a command with a **Copy** button.

**Re-check** runs it again. **Send test notification** sends one through the normal path and tells you where it went:

- "Test notification sent": the menu-bar app posted it. Look for a banner at the top right of the screen. Clicking it opens Setup.
- "Sent as a plain macOS notification": the app couldn't post it, so the daemon used the fallback. macOS shows that one as coming from Script Editor, and clicking it won't open the inbox.
- "No notification was sent": neither the app nor the fallback can post one right now. The checks say why.

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

The menu-bar app reconnects by itself, even if the daemon comes back on a different port, and asks launchd to start an offline daemon without killing one that's running. A call that was held when you restarted falls back to Claude's own prompt.

## Nothing shows up for a session

Claude reads hooks when a session starts. **Restart the session**, and it will report in. If it still doesn't, check that `~/.claude/settings.json` lists `inbox-hook` under `hooks`:

```bash
grep -c inbox-hook ~/.claude/settings.json
```

A count of zero means the hooks aren't installed. Run `session-inbox doctor`, or run the installer again; it's safe to repeat:

```bash
session-inbox install --yes
```

## Claude pauses before running a command

That's a held approval waiting for you: Session Inbox is holding the call so you can allow it from a notification. It falls back to Claude's own prompt after 120 seconds, or at once when you click **Open in Claude**. See [When it holds a tool call](holds.md).

If you'd rather it never paused Claude, turn off **Hold tool calls for approval in the inbox** in [Settings](settings.md).

## Notifications

If you get no notifications, or no buttons on them, go through these in order.

**macOS has the app set to "denied".** The menu-bar app asks for permission the first time it starts. That prompt appears once. If you miss it, or the app quits before you answer, macOS records "denied" and never asks again, and from then on it says "denied" even though you were never asked. The only way back is the switch in System Settings: Notifications, Session Inbox, Allow. The Notifications check on the Setup page has a button that opens that pane. Until you do, the daemon posts plain fallback notifications with no buttons, so you're still told; they show as coming from Script Editor.

**A Focus mode is on.** Focus hides banners from every app, however Session Inbox is set up, and the setup check can't see it. Turn Focus off, or allow Session Inbox in it.

**The style is Banners.** Banners disappear after a few seconds. In System Settings, Notifications, Session Inbox, choose **Alerts** to keep Allow and Deny on screen until you answer.

**The menu-bar app isn't running.** Without it there are no buttons at all, only the fallback. The Menu-bar app check says whether it's connected. Open **Session Inbox** from `~/Applications`.

**The fallback is off.** If **Notify even when the menu-bar app isn't running** is switched off in [Settings](settings.md), nothing is posted while the app can't show notifications. The Notifications check says so.

Use **Send test notification** on the Setup page to see which route a notification takes.

## Replies don't send, or titles don't change

Replies to a session that is sitting idle, and titles generated by Claude, both call the `claude` CLI. Run `session-inbox doctor` to see whether `claude` is on the path the daemon uses and whether it's logged in. The Claude desktop app's sign-in isn't shared with the CLI, so log the CLI in once by running `claude` in a terminal.

Until then, the reply box on an idle session is replaced by a sentence saying why, with an **Open in Claude** button. Replies to a call Claude is holding still work, because they go back through the hook. Titles still come from the desktop app's own title where there is one.

## Where the logs are

Everything is under `~/Library/Application Support/SessionInbox/`:

| File | What's in it |
| --- | --- |
| `inboxd.log` | The daemon's log: launchd's stdout and stderr. |
| `update.log` | Update attempts. See [Updating](updating.md#the-update-log). |

For a second channel, use `SessionInbox-beta` in place of `SessionInbox`.

## Start from a clean slate

If an install is in a bad state, run the installer again. It repairs missing pieces and doesn't duplicate anything. To remove Session Inbox completely, see [Uninstall](install.md#uninstall).

If you think you've found a bug, [open an issue](https://github.com/dopsonbr/session-inbox/issues) with the output of `session-inbox doctor` and the last lines of `inboxd.log`.

## Not yet verified by a person

Most of Session Inbox has been checked on a real install with real Claude sessions: answers sent from the inbox reach a waiting question, Allow and Deny from the inbox release a held call, **Open in Claude** lands on the exact desktop session, and the daemon-driven update works end to end. A few things haven't been seen by a person yet:

- **The app's own notification banners.** Nobody has yet seen the menu-bar app's banners with their **Allow**, **Deny**, **Answer** and **Open** buttons, or clicked through from one. While it was being built, nobody was at the screen to see them or click **Allow**. macOS's own log shows the plain fallback notifications being displayed, but that isn't the same as someone seeing them.
- **Alerts versus Banners.** The setup check says the Alerts style keeps Allow and Deny on screen until you answer. A person hasn't looked at that yet.
- **A published release.** No GitHub Release exists yet, so the one-line installer hasn't been run end to end, and no second Mac has installed from one.
- **Opening a CLI session.** **Open in Claude** for sessions started from the `claude` CLI uses the `claude://resume` link, which hasn't been checked on a real session. Desktop sessions have.
- **A real "needs your input" notification.** The idle-session prompt Claude sends as a `Notification` hook event hasn't been recorded from a real session yet.
- **Gatekeeper on a copied tarball.** The app is signed ad hoc and not notarized. The installer clears the quarantine flag on what it copies, but running it from a tarball that you downloaded with a browser hasn't been tried.
