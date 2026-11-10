---
title: Changelog
description: What changed in each Session Inbox release, newest first.
order: 11
section: Reference
---

# Changelog

What changed in each release, newest first. Versions are tagged on [GitHub Releases](https://github.com/dopsonbr/session-inbox/releases), where you can download them.

## 0.4.1

Published 2026-11-10: [v0.4.1 on GitHub](https://github.com/dopsonbr/session-inbox/releases/tag/v0.4.1). An install of 0.4.0 updates to it by itself, or with **Update now**.

- **The window's place survives an update.** Fixed: when 0.4.0 arrived as an update, the restarted app saved the window's place where the next launch didn't look, and left its login item unchanged. The place was forgotten once, and the window opened at the next login.

## 0.4.0

Published 2026-11-10: [v0.4.0 on GitHub](https://github.com/dopsonbr/session-inbox/releases/tag/v0.4.0). An install of 0.3.1 updates to it by itself, or with **Update now**. Known problem: after that update the window's place is forgotten once, and the window opens at your next login; both settle after that login. Fixed in 0.4.1.

- **A Dock icon and a normal window.** Session Inbox is a regular Mac app as well as a menu-bar app: it is in the Dock and in <kbd>⌘</kbd><kbd>Tab</kbd>, and the Dock icon carries the same count as the menu bar. Launching the app, clicking its Dock icon or switching to it with <kbd>⌘</kbd><kbd>Tab</kbd> opens the inbox window. Closing the window hides it; <kbd>⌘</kbd><kbd>Q</kbd> quits the menu-bar app while the daemon keeps running. See [The window is an app too](using-it.md#the-window-is-an-app-too).
- **The window stays where you put it.** Its position, size and whether it was open are kept across restarts and updates, on another monitor too. At login or after an update the app starts in the background and brings the window back only if it was open.
- **Choose where clicks go.** **Notification clicks and the menu-bar icon**, in the new **Window and menu bar** group of Settings: notifications open the window (the default), both open the popover with the item's row marked, or both use the window while it's open. See [Settings](settings.md#window-and-menu-bar).
- **The count is there from the start.** The menu-bar icon (and now the Dock icon) shows how many items need you as soon as the app starts; before, it stayed blank until the count next changed.
- **A popover row opens its item.** Clicking a row in the popover now opens that item in the inbox window in the menu-bar app; before, it did nothing useful there.

## 0.3.1

Published 2026-11-10: [v0.3.1 on GitHub](https://github.com/dopsonbr/session-inbox/releases/tag/v0.3.1).

- **A lapsed request says so again.** Fixed in the detail pane: a request that had passed to Claude's own prompt read "Decided here: Left to Claude's own prompt" in 0.3.0. It reads "Claude is asking in its own window. Answer there." with **Open in Claude**, as before.
- **Told when a command hangs.** A tool call that has been running for more than 5 minutes (a hung command, a dev server started in the foreground) shows up in **Review** as "Running npm run dev for 12 min", with one notification. **Done** if it's meant to run, **Open in Claude** to stop it. Session Inbox now also registers Claude's `PostToolUseFailure` hook, so a command that failed or timed out isn't mistaken for one that is still running. See [Using it](using-it.md#when-a-command-hangs).

## 0.3.0

Published 2026-11-10: [v0.3.0 on GitHub](https://github.com/dopsonbr/session-inbox/releases/tag/v0.3.0). An install of 0.2.0 updates to it by itself, or with **Update now**.

- **Shortcuts you can change.** A **Shortcuts** group in Settings lets you change or turn off every shortcut, including the system-wide one that opens the inbox.
- **Fewer steps.** After you answer or decide, the next item is selected. <kbd>J</kbd> and <kbd>K</kbd> move through the list, <kbd>E</kbd> or a **Done** button clears a review item, and <kbd>?</kbd> lists the shortcuts.
- **Answer from the popover.** Popover rows say what is being asked, and a waiting tool call has **Allow** and **Deny** on its row.
- **Deny with a note.** Type in **Tell Claude why (optional)** before denying and Claude gets your reason.
- **Easier to read.** No text under 11px, larger icons, the queue tabs on one row, one line of session facts under the title, and titles that say what is asked ("Claude wants to edit src/window.ts"). Settings says that changes apply as you make them and hides the classic-only settings in the recommended mode.
- **History and search.** A **History** view in the inbox window lists finished items, newest first, with how each ended (allowed, denied, answered, handled in Claude and so on), and searches what the inbox showed you and what you answered. It is not a transcript search. See [Using it](using-it.md#history).

## 0.2.0

Published 2026-11-10: [v0.2.0 on GitHub](https://github.com/dopsonbr/session-inbox/releases/tag/v0.2.0). The first packaged release. Before this, Session Inbox was installed from a source checkout.

### Install and update

- **One-line installer.** `curl … | sh` downloads the latest release (Apple silicon only, about 125 MB), verifies its SHA-256 and installs it. No Bun or Rust needed. Intel Macs install from source. See [Install](install.md).
- **The `session-inbox` command.** `install`, `uninstall`, `update`, `status`, `doctor`, `holds` and `open`, linked into `~/.local/bin`. Anything that changes your Mac is a dry run until you add `--yes`.
- **Install from a tarball.** `bun scripts/release.ts` builds `session-inbox-<version>-macos-arm64.tar.gz`; copy it to another Mac, unpack it and run its `bin/session-inbox install --yes`. It also works from a mirror of the releases, set with `SESSION_INBOX_RELEASES_URL`.
- **Automatic updates.** The daemon checks GitHub Releases a minute after it starts and about every 6 hours, and installs a new version by itself only when no tool call is held, no reply is in flight and no session has sent an event in 30 seconds. A version that failed to install isn't retried automatically. See [Updating](updating.md).
- **Update banner and command.** An **Update now** banner in the inbox and the popover, a **Check for Updates…** item in the menu-bar menu, and `session-inbox update --check` and `session-inbox update --yes`. Updating keeps your database, settings and history, re-merges the hooks, and doesn't stall Claude: the hooks keep failing open while the daemon restarts.
- **Clearer installer messages.** With no release it says "no release has been published yet"; when GitHub can't be reached or rate-limits, it says so and suggests `SESSION_INBOX_VERSION=vX.Y.Z`; when `~/.local/bin` isn't on your `PATH`, the closing lines give the full path to the command and the one line that adds it to `PATH` for zsh.
- **Uninstall is tidier and safer.** It quits the menu-bar app and removes its login item (only when it points at the app being removed). `--channel beta` always means the beta install, whichever copy of the command you run, and `--purge` refuses a home that belongs to the other channel.
- **Safer publishing.** `bun scripts/release.ts --publish` refuses before building unless the checkout is clean and equals `origin/main`, and tags exactly the commit it built. The Release workflow runs only from the default branch and pushes the commit and tag together. Pre-release tags are never offered as updates.
- **Update banner and notice.** The banner's terminal hint is `session-inbox update --yes`, and the "Updated to <version>" notice now appears reliably after an update.
- **Corrupted downloads are refused.** The update checks the SHA-256 before it installs anything.
- **Quarantine flag cleared.** A tarball downloaded in a browser still installs and runs.
- **Beta has its own app.** The beta channel installs `Session Inbox Beta.app` with its own bundle id, `sessioninbox-beta://` links and <kbd>⌘</kbd><kbd>⌥</kbd><kbd>⇧</kbd><kbd>I</kbd> shortcut, beside the everyday one. It never updates from releases. See [GA and beta channels](channels.md).

### Security

- **The inbox page needs the token to load.** Opening `http://127.0.0.1:<port>/` by hand now shows a short notice. The menu-bar app and `session-inbox open` open the page properly, with a one-time `?k=` that the page removes from the address bar; a cookie keeps reloads working. Before, anything that could reach the port, such as another macOS account or a Docker container, could read the token from the page and approve tool calls. `session-inbox status` prints the address with "(open it with: session-inbox open)". See [How it works](how-it-works.md#security).
- **Always allow says exactly what it adds, and is only offered when it can be scoped.** The card reads "Always allow adds <rule> <where>." A file tool gets that one file, WebFetch the host, Bash the exact command, an MCP tool that tool; Claude's own suggested rule is used when there is one. There is no button when no narrow rule exists, and it never writes a bare tool name such as `Edit`. See [How approvals work](holds.md#what-each-answer-does).

### Approvals

- **Answer Claude's own prompt, by default.** Session Inbox now uses Claude Code's `PermissionRequest` hook. When Claude asks for permission, its own prompt appears in Claude as usual and the same request appears in the inbox at once; whichever you answer first wins, and nothing is frozen. It covers every tool Claude asks about, not only Bash, edits and web fetches, and Claude's questions work the same way. The inbox keeps the request answerable for 10 minutes by default (1 to 55). The previous behaviour, holding Bash, edits and web fetches for up to 120 seconds before Claude asks, is still there as **Hold the tool call before Claude asks (classic)**. See [How approvals work](holds.md).
- **Nothing vanishes when you don't answer.** A request or hold that runs out stays in **Needs you** as **Waiting in Claude**, with **Open in Claude** only, and its notification becomes "Still waiting in Claude: …". It clears when Claude moves on.
- **Always allow follows Claude.** It uses the rule Claude itself suggests for that request, and otherwise a narrow rule for the call that it writes to `.claude/settings.local.json` (see Security above). A plain Deny tells Claude "Denied by the user in Session Inbox."
- **Existing installs need the hook.** Install or update again to register `PermissionRequest`; the setup check says when it's missing.
- **A permission prompt right after another was approved is no longer missed.**
- **Approval preview.** A permission request shows a real diff for Edit, MultiEdit, Write and NotebookEdit (with line numbers, the path and added and removed counts), the full command and its folder for Bash, the URL for WebFetch, and what Claude said just before it asked. A diff of more than 40 lines starts collapsed. See [Using it](using-it.md#approving-a-tool-call).
- **Answers and decisions reach the session.** An answer sent from the inbox to a waiting `AskUserQuestion` lands as the answer. In the default mode a Read outside the project, a question, an Edit and a Bash command were each answered from the inbox about 30 ms before Claude carried on, with Claude's own prompt still on screen. In the classic mode, Allow and Deny release a held call about half a second later.
- **Claude's last message.** Finished and failed items show it in full, formatted as Markdown, collapsed when long.
- **Turning holding off releases held calls.** Nothing stays frozen waiting on an inbox that no longer holds.
- **Requests survive a daemon restart or update.** A waiting hook retries for up to 15 seconds when the daemon goes away, so an update or reinstall no longer drops a pending request. If the daemon stays away, Claude's own prompt is all that remains, and when it returns the item shows as **Waiting in Claude**.
- **No answers that go nowhere.** A request nobody is listening for (20 seconds without its hook) becomes **Waiting in Claude**, and answering it says "Claude is asking in its own window. Answer there."
- **Items clear when Claude is gone.** If the Claude process behind a session exits without saying so (killed, terminal closed, reboot), its waiting items are resolved within about ten seconds.
- **Shortcuts stay in their place.** <kbd>⌘</kbd><kbd>↵</kbd> and <kbd>⌘</kbd><kbd>⌫</kbd> act only on the inbox view with no dialog or menu open, so they can't approve an item hidden behind Settings. While typing, <kbd>⌘</kbd><kbd>↵</kbd> works only from the reply box or a question's **Other** field.

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
- **The login item is repaired.** If the app's login item points at an old copy of the app, it is rewritten to the running copy.
- **The app no longer kills a running daemon** when it asks launchd to start one.
- **A window left open across an update** reloads itself onto the new version.
- **File paths** in activity lines are shown relative to the project, such as "Edited src/window.ts".
- **Times** read "2 min ago" instead of a bare number.
- **Layout.** The item's context strip no longer clips on narrow panes, and the header's version never wraps.
