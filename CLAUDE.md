# Session Inbox: agent guide

macOS menu-bar inbox for local Claude Code sessions: hooks → Bun daemon → Tauri app + Foldkit UI. See README.md for what it does; this file covers how to work in the repo.

## Read first

- **DECISIONS.md** is the source of truth for what was decided and why; it overrides `docs/implementation.md` (the spec snapshot). Add an entry for every decision you make, in your area's section with the next free number (G general, C contracts, D daemon, H hook & ops, U UI, S shell, P spike findings): `- X-NNN — decision. Why.` Keep it to one or two lines.
- `docs/spike.md`: what's proven about Claude Code's hooks, and what isn't.
- `docs/mockups/InboxDesktop.dc.html`, `MenuBar.dc.html`: the target UI.

## Architecture rules (don't break these)

1. **The daemon decides; nothing else does.** Classification, lifecycle, queue, priority, notification policy, dedupe and reply routing live in `apps/daemon`. The UI renders `item.queue` / `item.state` / counts and sends intents. The Rust shell posts notifications and forwards clicks. Neither derives domain state.
2. **Fail open.** If the daemon is down or slow, `inbox-hook` exits 0 with no stdout and Claude behaves as if no hooks existed. Never exit 2 from the hook, and never let an ingest error become a hook failure.
3. **Hold only when Claude would ask** (G-014): default permission mode, tool in `holds.tools`, no matching allow rule, project not muted. `AskUserQuestion` is always held. Any change here changes how every Claude session on the machine feels.
4. **Every state change appends an event** (`events.seq`), including user intents. Stream deltas carry the causing seq; the UI resumes with `since=<seq>`.
5. **Contracts are the only shared code.** Change `packages/contracts` first (additively where possible), then the daemon and UI. The UI must import only the browser-safe index, never `@session-inbox/contracts/paths` (it uses `node:os`).
6. **The UI is served by the daemon** at `http://127.0.0.1:<port>/` with the token injected into `<meta name="session-inbox-token">`. Keep that tag in `apps/desktop/index.html` and use relative `/v1/...` URLs. The UI uses no Tauri APIs; the shell just loads the URL (`#/item/<id>` selects, `?view=compact` is the popover).

## Conventions

- **Bun for everything**: runtime, tests, scripts (`scripts/*.ts`), compiled binaries. No Node, npm, or shell scripts.
- **Pin exact versions** (G-005). Effect is **v4.1.2**: `Schema.Literals([...])`, `Schema.Union([...])`, `Result` not `Either`, no `onExcessProperty: "preserve"` (use `decodeHookPayload`). Check `node_modules/.bun/effect@4.1.2/node_modules/effect/dist/*.d.ts` rather than recalling v3 APIs. Foldkit (0.170) is not React; follow the existing Model / Message / Update / View code in `apps/desktop/src`.
- Daemon storage is `bun:sqlite` and HTTP is `Bun.serve`, wrapped in Effect services (D-001, D-002). Schema changes are new numbered files in `apps/daemon/src/db/migrations/`; never edit a shipped migration.
- Side effects (git, claude CLI, notifier, opener, clock) go through services in `apps/daemon/src/services.ts` so tests can fake them.
- Store hook payloads raw (`events.payload_json`); Claude adds fields between releases.
- Biome formats and lints (`bun run lint`): 2 spaces, no semicolons, double quotes, 100 columns.
- Commit messages: imperative subject, a short body when useful.

## Commands

```bash
bun install
bun test                              # whole repo; must stay green
bun run typecheck
bun run lint
bun scripts/smoke.ts                  # real daemon + real inbox-hook end to end; run after daemon/hook changes
bun scripts/demo.ts                   # seeded live daemon + built UI for browser checks (build UI first)
bun run --cwd apps/desktop build      # UI → apps/desktop/dist
bun run --cwd apps/desktop dev:mock   # UI against the fake client
cd apps/desktop/src-tauri && cargo test && cargo clippy -- -D warnings
bun scripts/build-shell.ts            # Session Inbox.app (slow first build); --channel beta
bun scripts/install.ts --channel beta --yes --app   # beta install beside GA (H-014)
bun scripts/channels.ts               # GA + beta status; `holds <ga|beta>` picks the holder
```

Before committing: `bun test`, `bun run typecheck`, `bun run lint`; also `bun scripts/smoke.ts` if you touched the daemon, hook or contracts.

## Testing approach

- Pure lifecycle `transition` is tested for every state × event × kind (`apps/daemon/test/lifecycle.test.ts`).
- Scenarios are JSONL fixtures replayed against a temp DB with a fake clock, git, claude and notifier: `fixtures/synthetic/*.jsonl` (hand-written) and `fixtures/recorded/*.jsonl` (real payloads, scrubbed). Add a fixture for a new behaviour rather than a bespoke test. Record real payloads with `inbox-hook record <Event>`.
- UI: update functions are tested as pure functions; the SSE parser is tested across chunk boundaries.
- Check UI changes visually with `bun scripts/demo.ts` plus the browser, in light and dark.

## Gotchas

- **Two channels can be installed at once** (GA from `main`, beta from a branch; H-014). Test a daemon/hook change on beta (`install.ts --channel beta`) before reinstalling GA. Never let both hold (H-016).
- **Never touch the real machine state from tests or scripts without being asked**: `~/.claude/settings.json`, `~/Library/LaunchAgents`, `~/Library/Application Support/SessionInbox`. Use `SESSION_INBOX_HOME`, `CLAUDE_CONFIG_DIR` and `--settings <temp file>`. `install.ts` and `uninstall.ts` are dry runs unless given `--yes`.
- macOS caps Unix socket paths at 104 bytes. Use short temp homes (`mkdtempSync("/tmp/si-…")`), not the session scratchpad.
- `claude` processes the daemon spawns for its own use must set `SESSION_INBOX_INTERNAL=1` (the hook then ignores them) and disable hooks, or they feed back into the inbox. Outbox `--resume` replies deliberately do not, because their events confirm delivery.
- A child `claude -p` started from inside a Claude Code session needs a clean env (`env -u CLAUDECODE …`) and its own login. Desktop-app auth is not shared with the CLI.
- In zsh, `$VAR:path` applies a history modifier (`:a`, `:h`, …). Write `"${VAR}:path"` in git commands like `git show "${B}:file"`.
- Agent worktrees live in `.claude/worktrees/` (git-ignored). Never commit them.
- Vite emits the token meta tag self-closed; the daemon's injector matches both forms. Keep it that way.
