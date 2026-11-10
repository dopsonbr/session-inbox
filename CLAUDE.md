# Session Inbox: agent guide

macOS menu-bar inbox for local Claude Code sessions: hooks → Bun daemon → Tauri app + Foldkit UI. See README.md for what it does; this file covers how to work in the repo.

## Read first

- **DECISIONS.md** is the source of truth for what was decided and why; it overrides `docs/implementation.md` (the spec snapshot). Add an entry for every decision you make, in your area's section with the next free number (G general, C contracts, D daemon, H hook & ops, U UI, S shell, P spike findings): `- X-NNN — decision. Why.` Keep it to one or two lines.
- `docs/spike.md`: what's proven about Claude Code's hooks, and what isn't.
- `docs/mockups/InboxDesktop.dc.html`, `MenuBar.dc.html`: the target UI.
- `docs/handoff.md`: where things stand and what's next.
- **Docs site** (`site/content/*.md`, published at https://dopsonbr.github.io/session-inbox/): **when behaviour changes, update the matching page in `site/content/` in the same change.** Quote UI labels and defaults from the code; don't document what you can't find there. Claims no person has checked yet go in the "Not yet verified by a person" list on the Troubleshooting page. `site/README.md` says how pages are built.

## Architecture rules (don't break these)

1. **The daemon decides; nothing else does.** Classification, lifecycle, queue, priority, notification policy, dedupe and reply routing live in `apps/daemon`. The UI renders `item.queue` / `item.state` / counts and sends intents. The Rust shell posts notifications and forwards clicks. Neither derives domain state.
2. **Fail open.** If the daemon is down or slow, `inbox-hook` exits 0 with no stdout and Claude behaves as if no hooks existed. Never exit 2 from the hook, and never let an ingest error become a hook failure.
3. **Answer only when Claude would ask** (G-014, D-074). By default the inbox answers Claude's own prompt through the `PermissionRequest` hook (`holds.via = permissionRequest`): nothing is paused, Claude decides when to ask, and the first answer wins. In the classic mode (`preToolUse`) it holds a PreToolUse only when Claude would have asked: default permission mode, tool in `holds.tools`, no matching allow rule, project not muted. `AskUserQuestion` is always routed through the inbox. Never freeze a session for long. Any change here changes how every Claude session on the machine feels.
4. **Every state change appends an event** (`events.seq`), including user intents. Stream deltas carry the causing seq; the UI resumes with `since=<seq>`.
5. **Contracts are the only shared code.** Change `packages/contracts` first (additively where possible), then the daemon and UI. The UI must import only the browser-safe index, never `@session-inbox/contracts/paths` (it uses `node:os`).
6. **The UI is served by the daemon** at `http://127.0.0.1:<port>/`. It injects the token into `<meta name="session-inbox-token">` only when the page request shows it already knows it: `?k=<token>` (the shell and `session-inbox open` add it; the daemon then sets an HttpOnly `si_k_<port>` cookie) or that cookie. Any other request gets a static notice (D-095). The cookie never authorises `/v1/*`; the API takes only the bearer header (and `?token=` on the stream). Keep that tag in `apps/desktop/index.html` and use relative `/v1/...` URLs. The UI uses no Tauri APIs and drops `k` from its address after boot. The shell just loads `…/?k=<token>` (`#/item/<id>` selects, `view=compact` is the popover).

## Conventions

- **Bun for everything**: runtime, tests, scripts (`scripts/*.ts`), compiled binaries. No Node, npm, or shell scripts, except `install.sh` (G-025), the `curl | sh` bootstrap that must run before Bun exists.
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
bun scripts/e2e-update.ts             # release → install → auto-update under the REAL launchd (isolated label, ~1 min)
bun scripts/release.ts --skip-app && bun scripts/verify-release.ts   # build + install-check a tarball
bun scripts/demo.ts                   # seeded live daemon + built UI for browser checks (build UI first)
bun run --cwd apps/desktop build      # UI → apps/desktop/dist
bun run --cwd apps/desktop dev:mock   # UI against the fake client
cd apps/desktop/src-tauri && cargo test && cargo clippy -- -D warnings
bun scripts/build-shell.ts            # Session Inbox.app (slow first build); --channel beta
bun scripts/install.ts --channel beta --yes --app   # beta install beside GA (H-014)
bun scripts/channels.ts               # GA + beta status; `holds <ga|beta>` picks the holder
session-inbox doctor [--json]         # setup check (daemon's report, or local checks when it's down)
bun scripts/release.ts --skip-app     # release payload + tarball + .sha256 → dist/release (no app: fast); --publish runs `gh release create`
bun scripts/bump.ts patch|minor|major # edit VERSION (the Release workflow runs it)
bun scripts/build-site.ts --check     # docs site: build and check every link; --serve to preview
bun apps/cli/src/main.ts <cmd>        # the session-inbox CLI from source: install | uninstall | update | status | doctor | holds | open
```

Before committing: `bun test`, `bun run typecheck`, `bun run lint`; also `bun scripts/smoke.ts` if you touched the daemon, hook or contracts, and `bun scripts/e2e-update.ts` if you touched the CLI, the updater or the launchd plist, and `bun scripts/build-site.ts --check` if you touched `site/`, `README.md` or `DECISIONS.md`.

## Testing approach

- Pure lifecycle `transition` is tested for every state × event × kind (`apps/daemon/test/lifecycle.test.ts`).
- Scenarios are JSONL fixtures replayed against a temp DB with a fake clock, git, claude and notifier: `fixtures/synthetic/*.jsonl` (hand-written) and `fixtures/recorded/*.jsonl` (real payloads, scrubbed). Add a fixture for a new behaviour rather than a bespoke test. Record real payloads with `inbox-hook record <Event>`.
- UI: update functions are tested as pure functions; the SSE parser is tested across chunk boundaries.
- Check UI changes visually with `bun scripts/demo.ts` plus the browser, in light and dark.

## Gotchas

- **Two channels can be installed at once** (GA from `main`, beta from a branch; H-014). Test a daemon/hook change on beta (`install.ts --channel beta`) before reinstalling GA. Never let both hold (H-016).
- **Never touch the real machine state from tests or scripts without being asked**: `~/.claude/settings.json`, `~/Library/LaunchAgents`, `~/Library/Application Support/SessionInbox`. Use `SESSION_INBOX_HOME`, `CLAUDE_CONFIG_DIR` and `--settings <temp file>`. `install`, `uninstall` and `update` (the scripts and the `session-inbox` CLI) are dry runs unless given `--yes`; `holds` and `open` act at once.
- **Publishing is never automatic**: `release.ts --publish` and the Release workflow create a GitHub Release. Don't run or trigger either unless asked. Release artifacts are Apple silicon only (G-027); beta never updates from releases (G-029).
- macOS caps Unix socket paths at 104 bytes. Use short temp homes (`mkdtempSync("/tmp/si-…")`), not the session scratchpad.
- `claude` processes the daemon spawns for its own use must set `SESSION_INBOX_INTERNAL=1` (the hook then ignores them) and disable hooks, or they feed back into the inbox. Outbox `--resume` replies deliberately do not, because their events confirm delivery.
- A child `claude -p` started from inside a Claude Code session needs a clean env (`env -u CLAUDECODE …`) and its own login. Desktop-app auth is not shared with the CLI.
- In zsh, `$VAR:path` applies a history modifier (`:a`, `:h`, …). Write `"${VAR}:path"` in git commands like `git show "${B}:file"`.
- Agent worktrees live in `.claude/worktrees/` (git-ignored). Never commit them.
- `bun scripts/e2e-update.ts` is the one script that uses the real launchd: only the label `com.sessioninbox.inboxd.e2e`, its plist (removed at the end) and `/tmp/si-e2e-*`. Keep it that way; it checks the real settings and GA/beta plists are unchanged afterwards (another agent reinstalling beta mid-run will trip that check).
- **All install logic lives in `apps/cli`** (H-019). `scripts/install.ts`/`uninstall.ts`/`channels.ts` are thin wrappers; change the CLI, not them. Anything derived from the user's home goes through `homedir()` (honours `$HOME`), so tests run installs with `HOME=/tmp/si-…` as well as `--home`/`--settings`/`--no-launchd`. The version comes from the root `VERSION` file (`--define` in compiled builds; `@session-inbox/contracts/version`).
- `apps/cli/test/release.test.ts` compiles two full payloads (about a minute). It never touches the network: `SESSION_INBOX_RELEASES_URL` points at a local fake.
- Vite emits the token meta tag self-closed; the daemon's injector matches both forms. Keep it that way.
