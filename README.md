# Session Inbox

A macOS menu-bar companion for Claude Code sessions running on this Mac (CLI and the Claude desktop app's Code tab). It notifies you when a session needs you, lets you answer questions or approve tool calls without opening Claude, and hands you back to the exact session for anything substantive.

- Notifies only for questions, permission requests, stops and failures. Routine tool activity stays silent.
- Mirrors Claude's structure: project → session → subagent.
- Allow or Deny straight from the notification; answers to several questions go back as one reply.
- If the daemon is down, Claude behaves exactly as if nothing were installed.

```
Claude Code ──hook JSON──▶ inbox-hook ──unix socket──▶ inboxd (Bun daemon, SQLite)
     ▲                         │ waits for allow/deny          │ HTTP + SSE on 127.0.0.1
     └──── decision ◀──────────┘                               ▼
                                              Tauri menu-bar app + Foldkit UI
```

Design: [docs/implementation.md](docs/implementation.md) (spec snapshot), [DECISIONS.md](DECISIONS.md) (everything we decided and why, and where it overrides the spec), [docs/spike.md](docs/spike.md) (Phase 0 findings).

## Install

Requires Bun ≥ 1.4, Rust (for the menu-bar app), and the Claude desktop app or CLI.

```bash
bun install
bun scripts/install.ts          # dry run: shows every file and settings.json change
bun scripts/install.ts --yes    # build, copy to ~/Library/Application Support/SessionInbox,
                                # load the launchd agent, merge hooks into ~/.claude/settings.json
bun scripts/build-shell.ts      # build "Session Inbox.app" (menu bar); open it from the printed path
```

`install.ts --yes` backs up `~/.claude/settings.json` first, and re-running it changes nothing. `bun scripts/uninstall.ts --yes` removes the hooks and the launchd agent.

**Trial in one project only.** To leave your global settings alone, install the hooks into one repo's local settings and run the daemon by hand:

```bash
bun scripts/install.ts --yes --no-launchd --settings /path/to/repo/.claude/settings.local.json
bun apps/daemon/src/main.ts     # leave running; open the URL it logs
```

## Develop

```bash
bun test                        # unit, fixture-replay and API tests (whole repo)
bun run typecheck
bun run lint
bun scripts/smoke.ts            # real daemon + real inbox-hook, fake payloads; no Claude account
bun scripts/demo.ts             # real daemon seeded with sample sessions; prints a URL for the UI
bun run --cwd apps/desktop dev:mock   # UI against an in-memory fake daemon
bun run --cwd apps/daemon dev         # daemon with --watch on .dev/home
```

| Path | What |
| --- | --- |
| `apps/daemon` | `inboxd`: ingest, attention-item state machine, holds, outbox, notifications, HTTP/SSE |
| `apps/hook` | `inbox-hook`: forwards hook JSON, long-polls decisions, fails open; `record` mode for fixtures |
| `apps/desktop/src` | Foldkit + Effect UI (main window and `?view=compact` popover) |
| `apps/desktop/src-tauri` | Tauri v2 shell: tray badge, popover, native notifications, deep links |
| `packages/contracts` | Effect Schemas shared by daemon and UI |
| `fixtures/` | recorded and synthetic hook payloads replayed by the tests |
| `scripts/` | Bun scripts: install, build, smoke, demo, spike tools |
