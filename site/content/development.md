---
title: Development
description: Work on Session Inbox: the repository layout, the commands you'll use, how it's tested, how a release is cut, and how to record a decision.
order: 9
section: Reference
---

# Development

Session Inbox is a Bun workspace. The daemon, the hook, the UI build and every script run on Bun, and the menu-bar shell is Rust. If you're an agent or a contributor, the repository's `CLAUDE.md` has the rules of the road; this page is the overview.

## Repository layout

| Path | What |
| --- | --- |
| `apps/daemon` | `inboxd`: ingest, the attention-item state machine, holds, the reply outbox, notification policy, HTTP and SSE. |
| `apps/hook` | `inbox-hook`: forward, long-poll, fail open. `record` mode writes fixtures, and the settings merge lives here. |
| `apps/desktop/src` | The Foldkit and Effect UI: the main window and the `?view=compact` popover. |
| `apps/desktop/src-tauri` | The Tauri v2 shell: tray, popover, notifications, deep links and launch at login. |
| `packages/contracts` | Effect Schemas shared by the daemon and the UI. It's the only shared code. |
| `fixtures/` | Recorded (real) and synthetic hook payloads that the tests replay. |
| `ops/` | The launchd plist template and the Claude settings snippet. |
| `scripts/` | Bun scripts: install, uninstall, build, build-shell, channels, smoke, demo, and this site's builder. |
| `site/` | This documentation site. |
| `docs/` | The spec snapshot, mockups and the Phase 0 spike report. |

The stack is Bun 1.4, Effect 4.1.2, Foldkit 0.170, Basecoat CSS, Tailwind 4, Tauri 2 and SQLite. Versions are pinned exactly.

## Commands

```bash
bun install
```

```bash
bun test
```

```bash
bun run typecheck
```

```bash
bun run lint
```

The tests are unit tests, a lifecycle table, fixture replays and API tests. `bun test` must stay green. Lint is Biome.

Run the real daemon and the real hook end to end, with no Claude account:

```bash
bun scripts/smoke.ts
```

Run a live daemon seeded with sample sessions, for checking the UI in a browser (build the UI first):

```bash
bun run --cwd apps/desktop build
```

```bash
bun scripts/demo.ts
```

Work on the UI against an in-memory fake of the daemon:

```bash
bun run --cwd apps/desktop dev:mock
```

Test the Rust shell:

```bash
cd apps/desktop/src-tauri && cargo test && cargo clippy -- -D warnings
```

Before committing, run the tests, the typecheck and the lint. If you touched the daemon, the hook or the contracts, run the smoke test too.

## How it's tested

- The pure lifecycle function is tested for every state, event and item kind.
- **Scenarios** are JSONL fixtures replayed against a temporary database with a fake clock, git, `claude` and notifier. Hand-written ones are in `fixtures/synthetic`, and real, scrubbed payloads are in `fixtures/recorded`. Add a fixture for a new behaviour instead of writing a one-off test.
- UI update functions are tested as pure functions, and the SSE parser is tested across chunk boundaries.
- Check UI changes visually with the demo script and a browser, in light and dark.

Record real payloads from your own sessions with `inbox-hook record <Event>`. They can contain prompts and file contents, so scrub them before committing anything.

## Safe to run

Tests and scripts must never touch your real machine state: `~/.claude/settings.json`, `~/Library/LaunchAgents` or `~/Library/Application Support/SessionInbox`. Use `SESSION_INBOX_HOME`, `CLAUDE_CONFIG_DIR` and `--settings <temp file>`. The install and uninstall scripts are dry runs unless you give them `--yes`.

## Releases

The version lives in the `VERSION` file at the repository root. A release is cut with:

```bash
bun scripts/release.ts
```

Pushing the release tag runs the **Release** workflow on GitHub, which builds the app and publishes it, with checksums, as a GitHub release. The installer and the in-app updater both read from there. Write the release's notes in the [Changelog](changelog.md) as part of the change.

## Recording a decision

Every decision goes in `DECISIONS.md` at the repository root, which is the source of truth for what was decided and why. It overrides the spec snapshot in `docs/implementation.md`.

Add an entry in your area's section, using the next free number. The sections are G (general), C (contracts), D (daemon), H (hook and ops), U (UI), S (shell) and P (spike findings). One or two lines, in this shape:

```text
- X-NNN — decision. Why.
```

The [Decisions](decisions.md) page on this site is generated from that file at build time, so a new entry appears here, with its own anchor, on the next build.

## Working on this site

The documentation is Markdown in `site/content`, built by `scripts/build-site.ts`. See `site/README.md` for how to add a page. Build it, check every link and preview it with:

```bash
bun scripts/build-site.ts --check
```

```bash
bun scripts/build-site.ts --serve
```
