# Session Inbox

**A macOS menu-bar inbox for your local Claude Code sessions.** It tells you when a session needs you, lets you answer a question or approve a tool call without switching to Claude, and drops you into the exact session when there's real work to do.

- **Quiet by default.** You hear about questions, permission requests, stops and failures. Routine tool activity never notifies.
- **Answer in place.** Allow or Deny from the notification itself. Answer several of Claude's questions in one form and they reach the waiting session together.
- **Claude's own structure.** Project → session → subagent, grouped by repository, worktrees included.
- **Invisible when off.** If the daemon isn't running, every hook exits immediately with no output and Claude behaves exactly as if nothing were installed.

Scope for v1: sessions on **this Mac** only (the Claude desktop app's Code tab and the `claude` CLI). No cloud sessions, no sync, no transcript viewer.

## How it works

```
 Claude Code session                                   you
 ───────────────────                                   ───
 hook fires ──JSON──▶ inbox-hook ──unix socket──▶ inboxd ──SSE──▶ menu-bar app ──▶ notification
      ▲                   │ (holds PreToolUse        │  (Bun daemon,        │       │ Allow / Deny / Open
      │                   │  until you decide)       │   SQLite)            ▼       ▼
      └──── allow / deny / answers ◀─────────────────┴◀──── intents ◀── inbox window (Foldkit UI)
```

| Piece | What it does |
| --- | --- |
| **`inbox-hook`** | A compiled Bun binary that Claude runs for each hook event. It forwards the event to the daemon. For risky tools and `AskUserQuestion` it waits up to 120 s for your decision, then falls back to Claude's own prompt. |
| **`inboxd`** | The only thing that decides anything: it classifies events, tracks session and item state, decides when to notify, dedupes, and routes replies. It runs as a launchd agent, keeps state in SQLite, and serves an HTTP + SSE API and the UI on `127.0.0.1`. |
| **Menu-bar app** | A thin Tauri v2 shell: tray badge with the "needs you" count, a popover, native notifications with action buttons, `sessioninbox://` deep links, ⌘⇧I, launch at login. |
| **Inbox UI** | Foldkit + Effect, rendered from daemon state: project tree, queues, question form, approval card, activity timeline. |

**When does it interrupt a session?** It only holds a tool call when Claude itself would have asked you. That means the session is in the default permission mode, the tool is one of Bash, Write, Edit, MultiEdit, NotebookEdit or WebFetch, and none of your allow rules match. `AskUserQuestion` is always routed through the inbox. Clicking **Open in Claude** on a held item releases it at once, so Claude's own prompt appears.

**Replies.** Answers to a question Claude is waiting on go back through its held hook. Free-text replies to an idle session go out as `claude --resume <id> -p "<reply>"`, and never while a turn is running.

## Install

Requirements: macOS, [Bun](https://bun.sh) ≥ 1.4, Rust (`brew install rust`) for the menu-bar app, and the Claude desktop app or the `claude` CLI.

```bash
git clone https://github.com/dopsonbr/session-inbox && cd session-inbox
bun install
bun scripts/install.ts           # dry run: prints every file, launchd and settings.json change
```

Review the diff, then apply it:

```bash
bun scripts/install.ts --yes
```

That command does four things:

1. Builds `inbox-hook`, `inboxd` and the UI.
2. Copies them to `~/Library/Application Support/SessionInbox/`.
3. Loads the launchd agent `com.sessioninbox.inboxd`.
4. Merges the hooks into `~/.claude/settings.json`. It backs the file up first, keeps everything else in it, and re-running it changes nothing.

Add `--app` to also build the menu-bar app, install it as `~/Applications/Session Inbox.app` and open it (the first Rust build takes a few minutes):

```bash
bun scripts/install.ts --yes --app
```

New Claude sessions pick up the hooks. Restart any session that's already open.

### GA and beta side by side

Install a second, **beta** channel from a working branch to compare it with the GA install from `main`:

```bash
git switch my-branch
bun scripts/install.ts --channel beta --yes --app   # → ~/Applications/Session Inbox Beta.app
bun scripts/channels.ts                               # status of both: running, build, holds, URL
```

Beta has its own data (`~/Library/Application Support/SessionInbox-beta`), launchd agent (`com.sessioninbox.inboxd.beta`), port, app, `sessioninbox-beta://` links and ⌘⌥⇧I. Both channels see every session. Only one may **hold** tool calls (otherwise each would wait for its own answer), so a channel installed beside another starts as an observer: it shows the same items and notifies too, but never holds (its permission items aren't answerable; answer in the channel that holds). To swap roles:

```bash
bun scripts/channels.ts holds beta   # beta holds, GA observes (holds ga to switch back)
bun scripts/channels.ts open beta    # beta inbox in the browser
```

Remove beta with `bun scripts/uninstall.ts --channel beta --yes --app`. GA's hooks are left alone.

### Try it in one project first

To leave your global Claude settings untouched, install the hooks into a single repository and run the daemon in a terminal:

```bash
bun scripts/install.ts --yes --no-launchd --settings /path/to/repo/.claude/settings.local.json
bun apps/daemon/src/main.ts      # logs the inbox URL; Ctrl-C to stop
```

### Uninstall

```bash
bun scripts/uninstall.ts         # dry run
bun scripts/uninstall.ts --yes   # removes our hooks (only ours) and the launchd agent; --app also removes the app
```

## Using it

| Where | What you can do |
| --- | --- |
| Notification | **Allow** / **Deny** a permission request without opening a window; **Answer** or **Open** a question. A click opens the item. |
| Menu bar | Badge = items that need you. The popover lists them; **Open inbox** or ⌘⇧I opens the main window. |
| Inbox window | Queues: **Needs you**, **Working**, **Ready to review**, **Snoozed**. Snooze 15 m / 1 h / tomorrow, dismiss, mute a project. |
| Keyboard | ⌘K jump to a session · ⌘↵ send answers or allow · ⌘⌫ deny · arrow keys to move through the tree |
| Open in Claude | Desktop sessions open via `claude://code/continue?session=…`. CLI sessions open via `claude://resume?session=…`, and `cd <dir> && claude --resume <id>` is also copied to your clipboard. |

Session titles start as your first prompt and are replaced by a short Claude-written title a moment later (via `claude -p --model haiku`, with hooks disabled for that call).

## Files and configuration

Everything lives in `~/Library/Application Support/SessionInbox/`:

| File | Purpose |
| --- | --- |
| `bin/inbox-hook`, `bin/inboxd`, `ui/` | Installed binaries and UI |
| `inbox.db` | SQLite (WAL): sessions, items, events, outbox, notifications, drafts, settings |
| `inboxd.sock` | Unix socket for hooks (mode 0600) |
| `connection.json`, `token` | HTTP port and bearer token for the app (mode 0600) |
| `inboxd.log` | Daemon log (launchd stdout and stderr) |

Change settings in the app: the gear button in the header, or ⌘,. Each control saves on its own and the daemon applies it at once, no restart. The pane covers:

| Pane (group) | Key | Default | Meaning |
| --- | --- | --- | --- |
| Approvals | `holds.enabled` | `true` | Hold tool calls for approval in the inbox. Off: observe and notify only (an install beside another may default to off, H-016) |
| Approvals | `holds.tools` | Bash, Write, Edit, MultiEdit, NotebookEdit, WebFetch | Tools that may be held. AskUserQuestion always comes to the inbox |
| Approvals | `holds.budgetMs` | `120000` | How long a held call waits before Claude's own prompt appears (15–120 s; the hook gives up at 120 s) |
| Approvals | `holds.safeBashPrefixes` | `ls`, `git status`, … | Bash commands never held |
| Notifications | `notifications.fallback` | `true` | Use `osascript` notifications when the menu-bar app isn't running |
| Notifications | `notifications.reviewGroupMs` | `30000` | Window for grouping "ready to review" notifications (0–600 s) |
| Sessions | `titles.generate` | `true` | Ask Claude for a short session title |
| Sessions | (muted projects) | | Unmute a project muted from an item's menu |

Turning holds off releases any call being held, so Claude shows its own prompt. The same API is `GET`/`PUT /v1/settings` (partial body; `null` resets a key).

Settings are rows in the `settings` table (value as JSON). Rows win over the install's defaults (`SESSION_INBOX_SETTINGS` in the launchd plist), which win over the code defaults. Keys the pane doesn't show, such as `questions.answerMode` (`updatedInput`; `denyWithReason` is the fallback), can still be set by hand; the daemon reads rows only at startup, so restart it afterwards:

```bash
sqlite3 ~/Library/Application\ Support/SessionInbox/inbox.db \
  "insert or replace into settings values ('questions.answerMode', '\"denyWithReason\"')"
launchctl kickstart -k gui/$(id -u)/com.sessioninbox.inboxd
```

Environment overrides, mostly for development:

- `SESSION_INBOX_HOME`: moves the whole data directory.
- `SESSION_INBOX_UI_DIR`: where the daemon serves the UI from.
- `SESSION_INBOX_CLAUDE`: path to the `claude` binary.
- `CLAUDE_CONFIG_DIR`: where Claude settings are read for allow rules.
- `SESSION_INBOX_HOLD_SECONDS`: the hook's hold budget.

## Troubleshooting

- **The menu-bar app says "daemon offline":** run `launchctl print gui/$(id -u)/com.sessioninbox.inboxd` and check `inboxd.log`. To restart, run `launchctl kickstart -k gui/$(id -u)/com.sessioninbox.inboxd`.
- **Nothing shows up for a session:** the hooks load when a session starts, so restart it. Check that `~/.claude/settings.json` lists `inbox-hook` under `hooks`.
- **Claude seems to pause before running a command:** that's a held approval waiting for you. It falls back to Claude's own prompt after 120 s, or at once when you click **Open in Claude**.
- **No notification actions:** the app is ad-hoc signed. macOS may need **Alerts** style for "Session Inbox" in System Settings → Notifications for the buttons to show.

## Status

v1 is built and covered by tests, a smoke test and a browser check against a live daemon. Not yet confirmed on a real installed setup:

- That hooks fire for sessions started in the desktop app. Static analysis says yes; see [docs/spike.md](docs/spike.md).
- That `AskUserQuestion` answers land through `updatedInput`. The daemon switches to `denyWithReason` automatically if they don't.
- That the exact-session deep link lands on the right session.
- Notification clicks and buttons on a real desktop.

The design and its reasoning are in [docs/implementation.md](docs/implementation.md) (spec snapshot) and [DECISIONS.md](DECISIONS.md), which records every decision and where it departs from the spec.

## Development

```bash
bun install
bun test                              # unit, lifecycle-table, fixture-replay and API tests
bun run typecheck
bun run lint                          # Biome
bun scripts/smoke.ts                  # real daemon + real inbox-hook end to end; no Claude account needed
bun scripts/demo.ts                   # real daemon seeded with sample sessions; prints a URL to click around
bun run --cwd apps/desktop dev:mock   # UI against an in-memory fake daemon
bun run --cwd apps/daemon dev         # daemon with --watch on .dev/home
cd apps/desktop/src-tauri && cargo test && cargo clippy -- -D warnings
```

| Path | What |
| --- | --- |
| `apps/daemon` | `inboxd`: ingest, attention-item state machine, holds, outbox, notification policy, HTTP + SSE |
| `apps/hook` | `inbox-hook`: forward, long-poll, fail open; `record` mode writes fixtures; settings merge |
| `apps/desktop/src` | Foldkit + Effect UI: main window and `?view=compact` popover |
| `apps/desktop/src-tauri` | Tauri v2 shell: tray, popover, notifications, deep links, autostart |
| `packages/contracts` | Effect Schemas shared by the daemon and the UI: the only shared code |
| `fixtures/` | Recorded (real) and synthetic hook payloads replayed by the tests |
| `ops/` | launchd plist template, Claude settings snippet |
| `scripts/` | Bun scripts: install, uninstall, build, build-shell, smoke, demo, spike tools |
| `docs/` | Spec snapshot, mockups, Phase 0 spike report |

Stack: Bun 1.4 · Effect 4.1.2 · Foldkit 0.170 · Basecoat CSS · Tailwind 4 · Tauri 2 · SQLite. Contributor and agent guidance is in [CLAUDE.md](CLAUDE.md).
