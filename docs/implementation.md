<!-- Snapshot of the implementation doc (claude.ai/artifact/HuCXKRfgC8b5SdUH2FVmEB), 2026-11-08. DECISIONS.md overrides it. -->

# Session Inbox — Implementation Doc
 · 

## Overview
Session Inbox is a macOS menu-bar companion for Claude Code. It tells you when a session needs you, lets you answer quickly, and hands you back to Claude for real work. It is built from a Tauri shell, a Bun daemon and SQLite, with a Foldkit + Effect UI. All business logic lives in the daemon.
**Goals**

- Notify only when a session asks a question, needs permission, stops, or fails. Routine progress stays silent.

- Mirror Claude's structure: project → session → subagent.

- Let you answer questions and approve or deny tool calls without opening Claude.

- Open the exact session in Claude for anything substantive.
**Non-goals (v1)**

- No transcript reader, diff viewer, terminal or editor.

- No starting new sessions, and no support for other providers.

- No cross-machine sync or hosted backend.
**Guiding principle.** The daemon is the only place that decides anything: classification, lifecycle state, priority, notification policy, dedupe, and reply routing. The UI renders daemon state and sends user intents. Tauri is a native bridge for notifications, the menu bar, deep links and supervision, with no domain logic.

## Architecture
Four processes, one owner of state. The daemon runs under launchd whether or not the window is open, so hook events and approvals keep working even when you quit the UI.

_[diagram: process boundaries · 6 parts]_
Paired arrows are request and reply: hook events in, decisions back; the stream out to the app, user intents back. Replies to Claude leave only through the outbox.

| Process | Runtime | Owns | Never does |
| --- | --- | --- | --- |
| `inbox-hook` | Bun, compiled binary | Forwarding hook JSON to the daemon; waiting for a decision on PreToolUse | Decide anything; block Claude when the daemon is down |
| `inboxd` (daemon) | Bun + Effect | Domain state machine, classification, notification policy, outbox, SQLite | Render UI |
| Desktop shell | Tauri v2 (Rust) | Native notifications, menu bar badge, deep links, login item, starting the daemon if it's missing | Domain logic |
| UI | Foldkit + Effect in WKWebView | Showing daemon state; local view state (selection, focus, open panels) | Persist or derive domain state |

**Who does what with a notification.** The daemon decides that a notification should go out and pushes a `notify` command on the event stream. The shell posts it and reports clicks and actions back as intents. If the shell isn't running, the daemon marks the notification pending and delivers it when the shell connects. As a stopgap it can fall back to an `osascript` notification for high-priority items.
**Transport.** Hooks and CLI tools talk to the daemon over a Unix socket (`~/Library/Application Support/SessionInbox/inboxd.sock`, mode 0600). The webview can't open Unix sockets, so the daemon also serves HTTP + SSE on 127.0.0.1 with a random port and a per-install bearer token. Both are written to a 0600 file that the shell reads and passes to the UI at startup.

## Claude integration
Claude Code hooks are the only input. The daemon never scrapes the Claude UI. It may read transcript files, but only to build summaries.
**Hooks registered** (user-level `~/.claude/settings.json`, each running `inbox-hook <event>`):

| Hook | Daemon uses it for | Blocking? |
| --- | --- | --- |
| `SessionStart` | Create or update the session; map cwd to a project; record the transcript path | No |
| `Notification` | An attention item for "waiting for input" or a permission prompt | No |
| `PreToolUse` | Approval requests; also catches `AskUserQuestion` to pull out structured questions | Yes, for matched tools |
| `PostToolUse` | Quiet activity timeline (tool, file, result) | No |
| `SubagentStop` | Mark the subagent node done and update the tree | No |
| `Stop` | Move to Ready to review, or Failed if the last turn errored | No |

**Approvals.** For tools on a configurable matcher (e.g. `Bash`, `Write`), `inbox-hook` POSTs the request and long-polls the daemon for a decision. It returns allow, deny or ask using the PreToolUse decision output. If no answer arrives within the hook timeout (default 120 s), it returns ask, so Claude's own prompt appears in the desktop app. **Fail open:** if the daemon is unreachable, the hook exits 0 at once with no decision, and Claude behaves as if the inbox didn't exist.
**Questions and replies.** The outbox sends free-text replies and question answers with `claude --resume <session_id> -p "<reply>"`, but only when the session is idle or waiting, never during an active turn. Answering an `AskUserQuestion` that is pending in the desktop UI is the riskiest part. Phase 0 decides between answering it through the PreToolUse hook and handing off to Claude.
**Session tree.** project = git root of `cwd` (falling back to `cwd`); session = `session_id`; subagent = a sidechain in the transcript, confirmed by `SubagentStop`. Runtime (desktop, CLI, cloud) is recorded when SessionStart reports it, otherwise inferred and labelled "unknown".
**Deep links out.** Cloud sessions open `https://claude.ai/code/<session>`. Desktop sessions use the Claude app's URL scheme if it can target an exact session (Phase 0). Otherwise they open the project in Claude and copy the session title to the clipboard.

## Domain model
There are two state machines, both in the daemon. **Session state** says what Claude is doing. **Attention-item state** says what you owe it. The UI's queues are just filters over attention items.
**Entities:** Project → Session → Agent (main or subagent) → AttentionItem → Question | Approval. Every change starts as an appended `Event`, and state is rebuilt from events plus current rows.
**Attention kinds and what triggers them**

| Kind | Trigger | Queue | Notify |
| --- | --- | --- | --- |
| `question` | PreToolUse on `AskUserQuestion`, or a Notification saying input is needed | Needs you | Yes |
| `permission` | Blocking PreToolUse on a matched tool | Needs you | Yes (critical) |
| `failed` | Stop after an errored turn, or the session ends abnormally | Needs you | Yes |
| `review` | Stop after a clean turn | Ready to review | Yes (quiet, grouped) |
| `progress` | PostToolUse, SubagentStop | none (timeline only) | No |

**Rules enforced in the daemon**

- Each item has a dedupe key: one open item per (session, agent, kind). A repeat event refreshes it instead of notifying again.

- Snoozed items come back at `snooze_until` and notify once.

- An answered or decided item closes when the next event from that session arrives. If that event doesn't come within 5 minutes, it is flagged "unconfirmed".

- Any new event from a session auto-resolves its stale `review` items.
The diagram below shows the attention-item lifecycle. The Effect implementation is a tagged-union `State` plus a pure `transition(state, event) => Either<State, IllegalTransition>`, unit-tested exhaustively.

_[diagram: attention item lifecycle · 6 states]_
Only permission items can expire, and they expire when the hook times out and Claude's own prompt takes over. Answered becomes Resolved only once a later event from the session confirms the reply landed.

## SQLite schema
The daemon is the single writer to one file, `inbox.db`, using WAL mode, foreign keys on, and `busy_timeout` 5000. Migrations are numbered SQL files applied at startup. Secrets never go in SQLite; the bearer token lives in a 0600 file and can move to the Keychain later.

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY, root_path TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- Claude session_id
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT, runtime TEXT NOT NULL,   -- desktop | cli | cloud | unknown
  cwd TEXT, branch TEXT, worktree TEXT, transcript_path TEXT,
  state TEXT NOT NULL,                 -- running | waiting | idle | ended
  last_event_at INTEGER NOT NULL);

CREATE TABLE agents (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  parent_agent_id TEXT REFERENCES agents(id), name TEXT NOT NULL,
  state TEXT NOT NULL, started_at INTEGER, ended_at INTEGER);

CREATE TABLE events (                  -- append-only
  seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, agent_id TEXT,
  hook TEXT NOT NULL, payload_json TEXT NOT NULL, received_at INTEGER NOT NULL);

CREATE TABLE attention_items (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  agent_id TEXT REFERENCES agents(id),
  kind TEXT NOT NULL,                  -- question | permission | failed | review
  state TEXT NOT NULL,                 -- open | snoozed | answered | resolved | expired | dismissed
  dedupe_key TEXT NOT NULL, summary TEXT, source_seq INTEGER REFERENCES events(seq),
  snooze_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX one_open_item ON attention_items(dedupe_key)
  WHERE state IN ('open','snoozed');

CREATE TABLE questions (
  item_id TEXT NOT NULL REFERENCES attention_items(id), idx INTEGER NOT NULL,
  text TEXT NOT NULL, options_json TEXT, multi INTEGER NOT NULL DEFAULT 0,
  answer_json TEXT, PRIMARY KEY (item_id, idx));

CREATE TABLE approvals (
  item_id TEXT PRIMARY KEY REFERENCES attention_items(id),
  hook_request_id TEXT UNIQUE NOT NULL, tool TEXT NOT NULL, input_json TEXT NOT NULL,
  decision TEXT, decided_at INTEGER, expires_at INTEGER NOT NULL);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  item_id TEXT REFERENCES attention_items(id), body TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  state TEXT NOT NULL,                 -- queued | sending | delivered | failed
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES attention_items(id),
  state TEXT NOT NULL,                 -- pending | posted | clicked | acted | cleared
  posted_at INTEGER, acted_at INTEGER, action TEXT);

CREATE TABLE drafts (item_id TEXT PRIMARY KEY REFERENCES attention_items(id),
  body_json TEXT NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
```
Full-text search (FTS5 over session titles and summaries) can wait until ⌘K jump needs it.

## Daemon API
The UI holds a snapshot plus a stream of changes; it never queries rows directly. Every request and response is an Effect `Schema` in `packages/contracts`, which the daemon and the UI both import. The daemon is built on `@effect/platform-bun` (HTTP server) with SQLite access through Effect's SQL layer.

| Method | Path | Caller | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/hooks/:event` | inbox-hook (socket) | Ingest hook JSON; returns `{requestId}` for blocking PreToolUse |
| GET | `/v1/hooks/decision/:requestId?wait=110` | inbox-hook (socket) | Long-poll for allow / deny / ask |
| GET | `/v1/snapshot` | UI | Tree + queues + counts, with `seq` |
| GET | `/v1/stream?since=<seq>` | UI, shell | SSE: `delta`, `notify`, `badge` messages; resumes from seq |
| GET | `/v1/items/:id` | UI | Item detail: questions, approval, context, timeline |
| POST | `/v1/items/:id/answers` | UI | Answers to all questions; queued to the outbox as one reply |
| POST | `/v1/items/:id/decision` | UI, shell | `allow` / `allow-always` / `deny` for an approval |
| POST | `/v1/items/:id/reply` | UI | Free-text short reply |
| POST | `/v1/items/:id/snooze` · `/dismiss` | UI, shell | Queue actions |
| PUT | `/v1/items/:id/draft` | UI | Autosaved draft (debounced 500 ms) |
| POST | `/v1/notifications/:id/acted` | shell | Click or action on a native notification |
| GET | `/v1/health` | shell | Liveness + schema version |

**Stream semantics.** Each delta carries the `seq` of the event that caused it. After a reconnect the UI asks for `since=<last seq>`. If the daemon can't replay that far, it sends `reset` and the UI fetches a fresh snapshot. User actions are idempotent: the UI supplies an idempotency key, which becomes the outbox key.

## Frontend
The UI stack is Foldkit + Effect, with `@foldkit/ui` for behavior, Basecoat CSS for the look, and Tailwind CSS 4, plus a small set of app-specific components. Foldkit is not React, so shadcn and Radix components can't be used directly. Basecoat gives the shadcn look as plain HTML + CSS.
**Layering**

| Layer | Role |
| --- | --- |
| App components | QueueList, SessionTree, QuestionForm, ApprovalCard, ContextStrip, ActivityTimeline, OpenInClaude |
| `@foldkit/ui` | Behavior, focus, keyboard, accessibility (via its `toView` pattern) |
| Basecoat CSS | Styling, typography, tokens. Load its CSS only, never its JS, so there aren't two systems fighting over state and focus |
| Foldkit + Effect | Model, Message, Update, Commands, Subscriptions, shared Schemas |

**What the UI model holds:** the last snapshot + `seq`, the selected item, which tree nodes are expanded, the queue filter, and in-progress form input (mirrored to the daemon draft). It never holds or derives lifecycle state, priority or notification rules.
**Component map**

| Component | Built from |
| --- | --- |
| Queue list | Custom + Foldkit `VirtualList` (stable keys, so new items don't make the list jump) |
| Session tree | Custom, keyboard-navigable tree |
| Question form | Foldkit RadioGroup / Checkbox per question + Textarea for "other" |
| Approval card | Basecoat buttons; ⌘↵ allow, ⌘⌫ deny |
| ⌘K jump | Foldkit Combobox inside a Dialog |
| Row context menu | Foldkit Menu (snooze 15m / 1h / tomorrow, dismiss, mute project) |
| In-app toasts | Foldkit Toast (delivery confirmations only; real alerts go to native notifications) |
| Status badges | Custom Basecoat badges: icon + word, never color alone |

**Data flow.** A Foldkit Subscription opens the SSE stream and turns each delta into a Message. The snapshot load and reconnects go through Foldkit's experimental Query module, wrapped in our own `DaemonClient` interface so it can be swapped out. Foldkit's experimental Machine module is **not** used for session lifecycle, which belongs to the daemon. It may model purely local UI flows such as composer submit, but don't rely on it for that either.
**Design tokens.** Follow the system appearance (light and dark) at desktop density: 13 px base text, 32 px rows, 8 px spacing grid. Colors are neutral surfaces plus four status hues: needs-you orange, working blue, ready green, failed red. All of them must pass 4.5:1 contrast for text. The needs-you state is the only one allowed a heavy border or fill. Choose one Basecoat theme (e.g. `basecoat-css/nova`) and override its tokens rather than writing a parallel set.
**Version risk.** Foldkit is pre-1.0 (around v0.170 at the time of writing), and minor releases can break things. Pin exact versions and put Query, VirtualList and DevTools usage behind small adapters.

## Native shell
The Tauri v2 shell is a thin bridge. Its Rust code should stay under about 300 lines and contain no domain types beyond the notification payload.

| Concern | Implementation |
| --- | --- |
| Notifications | `tauri-plugin-notification`. The daemon's `notify` message carries title, body, item id and action set. Click and action events go to `/v1/notifications/:id/acted`. Action sets: question → Answer, Open in Claude; permission → Allow, Deny, Open. |
| Deep links in | `tauri-plugin-deep-link`, scheme `sessioninbox://item/<id>` and `sessioninbox://session/<id>`. Opens the window and selects the item. |
| Deep links out | `tauri-plugin-opener` for `claude.ai/code/…` and the Claude desktop URL scheme. |
| Menu bar | Tray icon with a badge for the Needs-you count, plus a popover window (480 × auto) that loads the same Foldkit app in compact mode. |
| Login item | `tauri-plugin-autostart`, so the shell starts at login with its window hidden. |
| Daemon supervision | A launchd agent (`com.sessioninbox.inboxd`, KeepAlive) is the source of truth. The shell installs or repairs the plist on first run, checks `/v1/health`, and shows a "daemon offline" banner. It never runs the daemon as a child process. |
| Global shortcut | ⌘⇧I opens the inbox (`tauri-plugin-global-shortcut`). |
| Updates | Out of scope for v1; sign and notarize anyway so notifications and the login item behave. |

Notification permission has to be requested by the signed, bundled app. In `tauri dev`, macOS may show notifications under a different app name and drop actions, so test action handling on a signed build.

## Repo layout and tooling
The project is one Bun workspace. The contracts package is the only code shared between the daemon and the UI.

```text
session-inbox/
  apps/
    daemon/        # inboxd: Bun + Effect; domain/, ingest/, outbox/, api/, db/migrations/
    hook/          # inbox-hook: tiny Bun CLI, compiled with `bun build --compile`
    desktop/
      src/         # Foldkit app (Model / Message / Update / View)
      src-tauri/   # Rust shell + tauri.conf.json
  packages/
    contracts/     # Effect Schemas: API, stream messages, hook payloads
  ops/
    launchd/com.sessioninbox.inboxd.plist
    claude-settings.snippet.json
  bunfig.toml  package.json  biome.json
```

- **Scaffold:** `bunx create-foldkit-app@latest apps/desktop`, then add Tauri (`bun tauri init`) and `bun add @foldkit/ui basecoat-css`.

- **Tests:** `bun test` for domain transitions, and replaying recorded hook JSON fixtures against an in-memory SQLite; Foldkit update functions tested as pure functions.

- **Fixtures:** a `record` mode in `inbox-hook` writes every real hook payload to `fixtures/` during Phase 0. Those files become the contract tests.

- **Lint/format:** Biome. **Rust:** `cargo clippy` in CI only.

- **Dev loop:** `bun dev` runs the daemon with `--watch` on a dev socket path, plus Vite. `bun tauri dev` runs the shell against the dev daemon.

## Build plan
Build in four phases. Phase 0 is a go/no-go gate: if hooks can't see sessions started in the Claude desktop app, the product shrinks to CLI sessions only.

- **Phase 0 — Spike (2–3 days).** Record real hook payloads with `inbox-hook record`. Prove each of these, or document it as unsupported:

- Hooks fire for sessions started in the Claude desktop app, a CLI, and a worktree.

- A PreToolUse hold → decide round trip works, including the timeout fallback to ask.

- `AskUserQuestion` answers can be supplied from outside, or else they need a handoff.

- A `--resume -p` reply shows up in a session that's open in the desktop app, without conflicts.

- An exact-session deep link into Claude desktop works.

- Tauri notification actions work on a signed build.

- **Phase 1 — Daemon.** Contracts package, migrations, hook ingest, tree building, attention state machine, outbox, snapshot + SSE, launchd plist. Done when replaying the fixtures produces the expected items.

- **Phase 2 — Shell + inbox.** Tauri tray, badge, notifications with click routing, login item, Foldkit inbox (tree, queues, detail, Open in Claude).

- **Phase 3 — Answers.** Question form, approvals from the UI and from notifications, snooze and dismiss, drafts, ⌘K jump, quiet hours, per-project mute.
**Acceptance criteria for v1**

- With the window closed, a question in any Claude session produces exactly one native notification within 2 s.

- Allow or Deny from the notification lets the tool run or blocks it, without opening any window.

- Answers to several questions go out as one reply to the right session, and the item shows Delivered.

- Open in Claude lands on the right project, and on the exact session if Phase 0 proved that's possible.

- Unread, snoozed, draft and notification state survive restarts of the daemon and the shell.

- Routine tool activity creates no notifications.

- With the daemon stopped, Claude Code behaves exactly as it would with no hooks installed.

## Risks and open questions

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Hooks don't cover sessions run inside the Claude desktop app | Product limited to CLI sessions | Phase 0 gate; check the desktop app's hook settings first |
| No supported way to answer a pending `AskUserQuestion` from outside | Questions become "open in Claude" only | Handoff with the question shown; free-text replies still go via `--resume` |
| Reply collides with a turn in progress | Duplicate or interleaved turns | Send only when state is idle or waiting; idempotent outbox; flag unconfirmed replies |
| Blocking PreToolUse slows Claude when you're away | Agent stalls up to the hook timeout | Matcher limited to risky tools; a 120 s timeout then ask; per-project opt-out |
| Foldkit pre-1.0 breaking changes | Upgrade churn | Pin versions; adapters around experimental modules |
| Tauri notification actions behave differently on macOS | Approvals from notifications fail | Fall back to click → open item; small Swift helper if needed |
| Hook payload schema changes in Claude Code | Ingest breaks | Decode with Effect Schema, keep unknown fields, store raw `events`, alert on decode failures |

**Open questions**

- Should "Always allow" write to Claude's own permission settings, or stay inside the inbox? yes

- Quiet hours: are critical permission prompts exempt? dont worry about quiet hours

- Cloud sessions: are their hooks reachable from this Mac, or does v1 only show them via links?only worry about local sessions

- Session titles: take the first prompt, or have Claude write a short title when the session starts?yes
