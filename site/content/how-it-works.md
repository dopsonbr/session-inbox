---
title: How it works
description: The architecture of Session Inbox: the four pieces, the flow of a hook event and a decision, the files on disk, the security model and what stays on your machine.
order: 8
section: Reference
---

# How it works

Claude Code runs a small program for each hook event. That program passes the event to a background daemon, and the daemon decides what, if anything, you should hear about. Everything else (the menu-bar app, the notifications, the inbox window) just shows what the daemon decided and sends back what you chose.

[[include flow]]

## The pieces

| Piece | What it does |
| --- | --- |
| **`inbox-hook`** | A compiled Bun binary that Claude runs for each hook event. It forwards the event to the daemon over a Unix socket. While you can answer a permission prompt or question from the inbox (or, in the classic mode, a held call), it waits for the daemon's decision and prints it for Claude; otherwise it exits at once. If the daemon is down or no decision comes, it prints nothing and Claude's own prompt stands. If the daemon goes away while a request is waiting, the hook keeps trying for up to 15 seconds, so a restart or an update doesn't drop the request. |
| **`inboxd`** | The daemon, and the only thing that decides anything. It classifies events, tracks session and item state, decides when to notify, dedupes, and routes replies. It runs as a launchd agent, keeps state in SQLite and serves an HTTP and server-sent-events API, and the UI, on `127.0.0.1`. |
| **`session-inbox`** | The command-line tool: `install`, `uninstall`, `update`, `status`, `doctor`, `holds` and `open`. Both the one-line installer and the in-app update run its install code, so every install goes through one path. |
| **Menu-bar app** | A thin Tauri shell: the tray badge with the "needs you" count, the popover, native notifications with action buttons (through macOS's current notification API), `sessioninbox://` deep links, <kbd>⌘</kbd><kbd>⇧</kbd><kbd>I</kbd> and launch at login. It posts notifications and forwards clicks, and tells the daemon whether macOS lets it show them. It decides nothing. |
| **Inbox UI** | A browser app, built with Foldkit and Effect, that the daemon serves. It renders the daemon's state (the project tree, queues, question form, approval card, activity timeline) and sends your intents back. |

The rule that holds this together: **the daemon decides; nothing else does.** The UI shows the queue an item is in; it never works out which queue that is. The menu-bar app posts a notification when told to; it never decides to.

## The data flow

1. **A hook fires.** Claude Code runs `inbox-hook <event>` with the event as JSON. The hook adds a little context only it can see (such as whether the session is from the desktop app or the CLI) and sends it to the daemon.
2. **The daemon records and classifies it.** Every event is stored as received, and the daemon updates its state. A question, a permission request, a stop or a failure becomes an *item* that needs attention. Routine activity only feeds the timeline.
3. **Permission prompts are offered to you.** By default, when Claude is about to ask for permission its `PermissionRequest` hook fires, and the daemon opens an item for the request and keeps the hook's request open while you decide. Claude's own prompt stays on screen, and `PreToolUse` is only recorded. In the classic mode the daemon instead holds a `PreToolUse` event that meets the [hold rule](holds.md) for up to 120 seconds, before Claude asks. See [How approvals work](holds.md).
4. **You're told.** The daemon pushes a notification command on its event stream. The menu-bar app posts it and updates the badge. The app reports whether macOS allows its notifications, and the daemon routes accordingly: to the app when it's allowed, to a plain macOS notification (no buttons) when the app isn't running or isn't allowed, and briefly to both while it's unsure.
5. **You decide.** Your Allow, Deny or answer goes to the daemon as an intent, from a notification button or the inbox window.
6. **The decision goes back.** For a waiting request or held call, the daemon answers the waiting hook, and the hook returns the decision to Claude. If you answered in Claude instead, the daemon notices from the transcript or the tool's result and clears the item. If the daemon restarts while a request is waiting, the hook retries for up to 15 seconds and picks the request up again. If the hook stays away for 20 seconds, the item becomes **Waiting in Claude** rather than accept an answer that would go nowhere. For an idle session, a reply is sent as `claude --resume <id> -p "<reply>"`, never while a turn is running.

Every state change, including your own intents, is appended to an event log with a sequence number. The UI resumes from the last number it saw, so a reconnect never loses or repeats anything.

## The hooks

Session Inbox registers 10 hook events in `~/.claude/settings.json`, each running `<home>/bin/inbox-hook <Event>`:

| Event | Matcher | Timeout |
| --- | --- | --- |
| `SessionStart`, `UserPromptSubmit`, `Notification` | none | 5 s |
| `PreToolUse` | the held tools and `AskUserQuestion` | 130 s |
| `PostToolUse` | `*` | 5 s |
| `PermissionRequest` | `*` | 3600 s |
| `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd` | none | 5 s |

In the default mode `PreToolUse` is only observed: the hook exits at once. `PermissionRequest` also exits at once when the inbox is only observing; when you can answer from the inbox it waits for your decision, and its timeout is above the longest wait (55 minutes) so Claude never cuts it off first.

## When Claude goes away

If the Claude process behind a session exits without saying so (it was killed, you closed the terminal, the Mac rebooted), no hook ever reports it. The daemon checks every ten seconds whether that process is still there, and when it isn't, the session's waiting items are resolved and the session ends.

## Files on disk

Everything lives in `~/Library/Application Support/SessionInbox/`:

| File | Purpose |
| --- | --- |
| `bin/inbox-hook`, `bin/inboxd`, `bin/session-inbox`, `ui/` | The installed binaries and UI. |
| `install.json` | The version, channel and choices this home was installed with. An update re-applies them. |
| `inbox.db` | SQLite in WAL mode: sessions, items, events, the reply outbox, notifications, drafts and settings. History older than 14 days is pruned daily (Storage in [Settings](settings.md)). |
| `inboxd.sock` | The Unix socket the hook talks to (mode 0600). |
| `connection.json`, `token` | The HTTP port and bearer token the app uses (mode 0600). |
| `inboxd.log` | The daemon's log. |
| `update.log`, `update-state.json`, `updates/` | Update attempts, the progress of the last one, and its download while it runs. See [Updating](updating.md). |

Outside that folder, Session Inbox adds a launchd plist in `~/Library/LaunchAgents/`, hooks in `~/.claude/settings.json`, and the app in `~/Applications`. [Install](install.md#what-it-changes-on-your-mac) lists them all.

## Security

Session Inbox is designed so that nothing outside your own account can reach it.

- **Localhost only.** The daemon listens on `127.0.0.1` on a random port. It isn't reachable from the network.
- **A bearer token.** The HTTP API requires a per-install token, kept in a file only you can read (mode 0600). The one unauthenticated route is a health check.
- **The page needs the token too.** Opening `http://127.0.0.1:<port>/` on its own shows a short notice, not the inbox. The menu-bar app and `session-inbox open` open the page with a one-time `?k=` in the address; the page removes it from the address bar, and a cookie keeps reloads working. The cookie only lets the page load: it never authorises the API. This matters because anything that can reach the port, such as another macOS account or a Docker container, could otherwise read the token from the page and approve tool calls. See [why](decisions.md#D-095).
- **A Host check.** Every request must carry a `Host` header of `127.0.0.1:<port>` or `localhost:<port>`, before anything else happens. This stops a web page from reaching the daemon through DNS rebinding.
- **A private socket.** Hooks talk to the daemon on a Unix socket with mode 0600. The hook routes exist only there, not on the TCP port.
- **No native permissions for the UI.** The menu-bar app loads the daemon's page and has no Tauri capabilities, so the page can't call into the shell.

The token is injected into the page the daemon serves, after the Host check passes and only when the request already shows the token. The UI uses only relative URLs.

### What's stored

The database holds what hooks send: session ids, project paths, prompts, tool inputs (including file contents and commands), Claude's summaries and your answers. Hook payloads are kept as received, and an approval's preview keeps the diff or command it showed you, which includes file contents. Finished history older than 14 days is deleted daily; **Keep history for** in [Settings](settings.md) changes that. It's all in a folder only your account can read, and nothing leaves the machine. Treat the folder like you'd treat your Claude transcripts.

## Privacy

Nothing leaves your machine, with one exception: the update check, and the download when you update, go to GitHub (`api.github.com` and the release assets). Switch off **Check for new versions** in [Settings](settings.md) and the daemon stops checking on its own. There's no telemetry, no analytics and no account. This documentation site loads no external resources either.

Two things run `claude` on your behalf: generating a session title when the desktop app hasn't given one (turn it off with **Generate short session titles** in [Settings](settings.md)) and sending a reply to an idle session. Those use your own Claude login, the same as if you ran `claude` yourself.

## Fail open

If the daemon is down or slow, `inbox-hook` exits at once with no output and Claude carries on as if no hooks existed. It never exits with an error that would block a call. See [When it holds a tool call](holds.md#fail-open).

## Why it was built this way

The reasoning behind each choice is in [Decisions](decisions.md). Good places to start are [G-002](decisions.md#G-002) (the daemon is the only place that decides), [G-014](decisions.md#G-014) (hold only when Claude would have asked) and [H-002](decisions.md#H-002) (fail open everywhere).
