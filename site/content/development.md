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
| `apps/cli` | `session-inbox`: install, uninstall, update, status, doctor. The one install path: a source install and a release install both end in the same code. |
| `apps/desktop/src` | The Foldkit and Effect UI: the main window and the `?view=compact` popover. |
| `apps/desktop/src-tauri` | The Tauri v2 shell: tray, popover, notifications, deep links and launch at login. |
| `packages/contracts` | Effect Schemas shared by the daemon and the UI. It's the only shared code. |
| `fixtures/` | Recorded (real) and synthetic hook payloads that the tests replay. |
| `ops/` | The launchd plist template and the Claude settings snippet. |
| `install.sh` | The `curl \| sh` bootstrap: download, verify, hand over to `session-inbox install`. The only shell script. |
| `scripts/` | Bun scripts: install, uninstall, build, build-shell, channels, release, bump, verify-release, e2e-update, smoke, demo, the docs screenshots, and this site's builder. |
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

Build a release tarball and check it the way a user gets it. `--skip-app` leaves the menu-bar app out and is fast; without it the Rust build runs:

```bash
bun scripts/release.ts --skip-app
```

```bash
bun scripts/verify-release.ts
```

Prove the update path under the real launchd with no GitHub. It builds two releases, installs the older one as an isolated job (`com.sessioninbox.inboxd.e2e` under `/tmp`), and checks that a held call blocks the automatic update, that the update applies after 30 seconds of quiet, that hooks keep failing open during the swap, and that a corrupted download is refused. It takes about a minute and isn't part of `bun test`:

```bash
bun scripts/e2e-update.ts
```

Regenerate the docs screenshots in `site/assets/screenshots/`. It runs the seeded demo daemon and renders each view in headless Chrome, so it needs Chrome, Chromium or Edge in `/Applications` and the UI built first, but no screen-recording permission:

```bash
bun scripts/screenshots.ts
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

The version lives in the `VERSION` file at the repository root. The compiled binaries carry it, and so does the menu-bar app's bundle.

`scripts/release.ts` builds a release: the hook, daemon and CLI binaries, the UI and the menu-bar app, packed as `dist/release/session-inbox-<version>-macos-arm64.tar.gz` with a `.sha256` file beside it. Release builds are Apple silicon only.

```bash
bun scripts/release.ts
```

Add `--publish` to also create the GitHub Release with `gh`, with the tarball, its checksum and `install.sh` attached. It refuses to run on a dirty tree or when the tag exists, locally or on `origin`. It publishes the version in `VERSION` as `v<version>` and doesn't bump it:

```bash
bun scripts/release.ts --publish
```

The other way is the **Release** workflow, run by hand from the repository's Actions tab with a bump of patch, minor, major or none. It runs `scripts/bump.ts` to bump `VERSION` and commits it (none publishes `VERSION` as it stands and is the choice for the first release), stops at once if that version is already tagged, runs the tests, typecheck, lint, smoke test and the Rust checks, builds with `scripts/release.ts`, verifies the result with `scripts/verify-release.ts --require-app`, then tags, pushes and publishes. Because it bumps first, a patch bump from `0.2.0` publishes `0.2.1`; choose none to publish `0.2.0`.

CI runs the same checks on every push and pull request, plus a `package` job that builds the full release and verifies it. Nothing is uploaded from CI. The installer and the in-app updater both read releases from GitHub. Write the release's notes in the [Changelog](changelog.md) as part of the change.

## Recording a decision

Every decision goes in `DECISIONS.md` at the repository root, which is the source of truth for what was decided and why. It overrides the spec snapshot in `docs/implementation.md`.

Add an entry in your area's section, using the next free number. The sections are G (general), C (contracts), D (daemon), H (hook and ops), U (UI), S (shell) and P (spike findings). One or two lines, in this shape:

```text
- X-NNN — decision. Why.
```

The [Decisions](decisions.md) page on this site is generated from that file at build time, so a new entry appears here, with its own anchor, on the next build.

## Working on this site

The documentation is Markdown in `site/content`, built by `scripts/build-site.ts`. **When behaviour changes, update the matching page in `site/content/` in the same change.** See `site/README.md` for how to add a page. Build it, check every link and preview it with:

```bash
bun scripts/build-site.ts --check
```

```bash
bun scripts/build-site.ts --serve
```
