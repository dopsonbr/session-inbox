---
title: Changelog
description: What changed in each Session Inbox release, newest first.
order: 11
section: Reference
---

# Changelog

What changed in each release, newest first. Versions are tagged on [GitHub Releases](https://github.com/dopsonbr/session-inbox/releases), where you can download them.

## 0.2.0

The first packaged release. Before this, Session Inbox was installed from a source checkout.

<!-- REMOVE AFTER FIRST RELEASE -->
This release hasn't been published yet. See [Install](install.md) for how to install it meanwhile.
<!-- /REMOVE AFTER FIRST RELEASE -->

### Install and update

- **One-line installer.** `curl … | sh` downloads the latest release (Apple silicon only, about 125 MB), verifies its SHA-256 and installs it. No Bun or Rust needed. Intel Macs install from source. See [Install](install.md).
- **The `session-inbox` command.** `install`, `uninstall`, `update`, `status`, `doctor`, `holds` and `open`, linked into `~/.local/bin`. Anything that changes your Mac is a dry run until you add `--yes`.
- **Install from a tarball.** `bun scripts/release.ts` builds `session-inbox-<version>-macos-arm64.tar.gz`; copy it to another Mac, unpack it and run its `bin/session-inbox install --yes`. It also works from a mirror of the releases, set with `SESSION_INBOX_RELEASES_URL`.
- **Automatic updates.** The daemon checks GitHub Releases a minute after it starts and about every 6 hours, and installs a new version by itself only when no tool call is held, no reply is in flight and no session has sent an event in 30 seconds. A version that failed to install isn't retried automatically. See [Updating](updating.md).
- **Update banner and command.** An **Update now** banner in the inbox and the popover, a **Check for Updates…** item in the menu-bar menu, and `session-inbox update --check` and `session-inbox update --yes`. Updating keeps your database, settings and history, re-merges the hooks, and doesn't stall Claude: the hooks keep failing open while the daemon restarts.
- **Corrupted downloads are refused.** The update checks the SHA-256 before it installs anything.
- **Quarantine flag cleared.** A tarball downloaded in a browser still installs and runs.
- **Beta has its own app.** The beta channel installs `Session Inbox Beta.app` with its own bundle id, `sessioninbox-beta://` links and <kbd>⌘</kbd><kbd>⌥</kbd><kbd>⇧</kbd><kbd>I</kbd> shortcut, beside the everyday one. It never updates from releases. See [GA and beta channels](channels.md).

### Approvals

- **Answer Claude's own prompt, by default.** Session Inbox now uses Claude Code's `PermissionRequest` hook. When Claude asks for permission, its own prompt appears in Claude as usual and the same request appears in the inbox at once; whichever you answer first wins, and nothing is frozen. It covers every tool Claude asks about, not only Bash, edits and web fetches, and Claude's questions work the same way. The inbox keeps the request answerable for 10 minutes by default (1 to 55). The previous behaviour, holding Bash, edits and web fetches for up to 120 seconds before Claude asks, is still there as **Hold the tool call before Claude asks (classic)**. See [How approvals work](holds.md).
- **Nothing vanishes when you don't answer.** A request or hold that runs out stays in **Needs you** as **Waiting in Claude**, with **Open in Claude** only, and its notification becomes "Still waiting in Claude: …". It clears when Claude moves on.
- **Always allow follows Claude.** It echoes the rule Claude itself suggests for that request, and writes `.claude/settings.local.json` only when Claude suggests none. A plain Deny tells Claude "Denied by the user in Session Inbox."
- **Existing installs need the hook.** Install or update again to register `PermissionRequest`; the setup check says when it's missing.
- **A permission prompt right after another was approved is no longer missed.**
- **Approval preview.** A permission request shows a real diff for Edit, MultiEdit, Write and NotebookEdit (with line numbers, the path and added and removed counts), the full command and its folder for Bash, the URL for WebFetch, and what Claude said just before it asked. A diff of more than 40 lines starts collapsed. See [Using it](using-it.md#approving-a-tool-call).
- **Answers and decisions reach the session.** An answer sent from the inbox to a waiting `AskUserQuestion` lands as the answer. In the default mode a Read outside the project, a question, an Edit and a Bash command were each answered from the inbox about 30 ms before Claude carried on, with Claude's own prompt still on screen. In the classic mode, Allow and Deny release a held call about half a second later.
- **Claude's last message.** Finished and failed items show it in full, formatted as Markdown, collapsed when long.
- **Turning holding off releases held calls.** Nothing stays frozen waiting on an inbox that no longer holds.

### Notifications

- **Current macOS notification API.** The menu-bar app asks for permission on first launch. If the prompt is missed or the app restarts before it's answered, macOS records "denied": the fix is System Settings, Notifications, Session Inbox, Allow. The menu-bar menu then shows **Notifications are off — Open Settings…**, and it also has **Settings…** and **Setup Check…** next to **Check for Updates…**.
- **No silent failures.** While the app isn't allowed to show notifications, the daemon posts plain notifications without buttons instead, and doesn't post both when the app is allowed.
- **Tidier banners.** A decided or dismissed item's notifications are withdrawn from Notification Center.
- **The popover** lists up to five **Ready to review** rows when nothing needs you.

### Settings

- **Settings pane.** Open it with <kbd>⌘</kbd><kbd>,</kbd> or the gear button. Approvals, Notifications, Sessions, Storage and Updates, applied live, with defaults and **Reset**. See [Settings](settings.md).
- **History is pruned.** Finished history older than 14 days is deleted daily. **Keep history for** sets it, from 1 to 365 days.
- **Muted projects** are listed in Settings with an **Unmute** button.

### Setup check

- **`session-inbox doctor`** checks the daemon, the hooks, whether the inbox holds, `claude`, the menu-bar app, notifications, updates and storage, and says what to fix. It still checks what it can when the daemon is down. See [Troubleshooting](troubleshooting.md).
- **Setup page in the app**, with the same checks, a first-run welcome, **Re-check** and **Send test notification**. The popover shows a **Setup** row when something needs attention.
- **Quieter and more specific.** A missing or logged-out `claude` is information, not a badge, since it only affects replies to idle sessions and generated titles. The hooks line names any missing events, and the Approvals line says which mode is active.

### Fixes

- **Session titles** come from the Claude desktop app's own title for the session, so they no longer need the `claude` CLI to be logged in. Prompts that begin with markup get a readable title, or "Untitled session".
- **Replies that can't be sent** say so. Without a logged-in `claude`, the reply box explains why and offers **Open in Claude**, instead of failing three times in the background.
- **What Claude said before asking** is filled in when you open an item, if it wasn't ready when the call was held.
- **The app no longer kills a running daemon** when it asks launchd to start one.
- **A window left open across an update** reloads itself onto the new version.
- **File paths** in activity lines are shown relative to the project, such as "Edited src/window.ts".
- **Times** read "2 min ago" instead of a bare number.
- **Layout.** The item's context strip no longer clips on narrow panes, and the header's version never wraps.
