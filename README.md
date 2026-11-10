# Session Inbox

**A macOS menu-bar inbox for your local Claude Code sessions.** It tells you when a session needs you, lets you answer a question or approve a tool call without switching to Claude, and drops you into the exact session when there's real work to do.

**Docs: <https://dopsonbr.github.io/session-inbox/>** (install, using it, settings, updating, troubleshooting, how it works)

- **Quiet by default.** You hear about questions, permission requests, stops and failures. Routine tool activity never notifies.
- **Answer in place.** When Claude asks for permission, the same request appears in the inbox while Claude's own prompt stays on screen; allow or deny it with the diff or the full command in front of you, and whichever you answer first wins. Answer several of Claude's questions in one form and they reach the waiting session together.
- **Claude's own structure.** Project, then session, then subagent, grouped by repository, worktrees included.
- **Invisible when off.** If the daemon isn't running, every hook exits immediately with no output and Claude behaves exactly as if nothing were installed.

Scope: sessions on **this Mac** only (the Claude desktop app's Code tab and the `claude` CLI). No cloud sessions, no sync, no transcript viewer.

**How it works.** Claude Code runs a small hook program (`inbox-hook`) for each event. It passes the event to a background daemon (`inboxd`), which alone decides what you hear about; the menu-bar app and the inbox window only show that and send back your choice. By default Session Inbox answers Claude's own permission prompt through Claude Code's `PermissionRequest` hook, so nothing is paused; a classic mode that holds the tool call before Claude asks is a setting away. If the daemon is down, every hook exits at once and Claude behaves as if nothing were installed. See [How approvals work](https://dopsonbr.github.io/session-inbox/holds.html) and [How it works](https://dopsonbr.github.io/session-inbox/how-it-works.html).

## Install

You need an Apple silicon Mac and the Claude desktop app or the `claude` CLI. The release is prebuilt (about 125 MB), so no Bun or Rust is needed.

```bash
curl -fsSL https://raw.githubusercontent.com/dopsonbr/session-inbox/main/install.sh | sh
```

The script checks the download's SHA-256 and hands over to the release's own `session-inbox install`. When it's done, click **Allow** when macOS asks about notifications, restart any Claude session that was already open, and run the setup check:

```bash
session-inbox doctor
```

What the installer changes on your Mac, installing from a tarball, updating, rolling back and uninstalling are on the [Install](https://dopsonbr.github.io/session-inbox/install.html) and [Updating](https://dopsonbr.github.io/session-inbox/updating.html) pages. `session-inbox uninstall --yes` removes it.

### Install from source

Needed on an Intel Mac (releases are Apple silicon only), and for development. You need [Bun](https://bun.sh) 1.4 or later, and Rust (`brew install rust`) for the menu-bar app.

```bash
git clone https://github.com/dopsonbr/session-inbox && cd session-inbox
bun install
bun scripts/install.ts            # dry run: prints every file, launchd and settings.json change
bun scripts/install.ts --yes --app   # build from this checkout, install, and open the menu-bar app
```

The first Rust build takes a few minutes. Without `--app` you get the daemon, the hook and the browser UI, but no menu-bar badge or native notifications. A second, beta install from a branch can sit beside the everyday one: see [GA and beta channels](https://dopsonbr.github.io/session-inbox/channels.html).

## Status

Built, covered by tests, a smoke test and a real-launchd update test, and run against real Claude desktop sessions.

**[v0.2.0](https://github.com/dopsonbr/session-inbox/releases/tag/v0.2.0) is published.** The one-liner above was run against it into a throwaway home on the Mac that built it, and an installed copy's update check finds it. A full install on a second Mac is the next check.

Two independent reviews of the whole product found 21 problems, all fixed: a request survives a daemon restart or update (the hook retries for up to 15 seconds), Always allow adds only a rule scoped to the call and says which, the inbox page loads only with the token, shortcuts no longer act behind a dialog, and uninstall can't touch the other channel's install. The suites and the smoke test pass.

**Checked live on a real desktop session:**

- In the default mode (answering Claude's own prompt), a Read outside the project, a question, an Edit (with its diff preview and Claude's sentence before it) and a Bash `rm` were each answered from the inbox, taking effect about 30 ms later while Claude's own prompt was on screen. The denied command didn't run and Claude reported the denial.
- In the classic mode, answers reach a held `AskUserQuestion`, and Allow and Deny release a held tool call about half a second later.
- **Open in Claude** lands on the exact session, and session titles come from the desktop app's own title.
- The approval preview shows a real diff.
- The daemon-driven update works end to end under launchd against a local release server (`bun scripts/e2e-update.ts`): a held call blocks the automatic update, it applies after 30 seconds of quiet, hooks keep failing open during the swap, and a corrupted download is refused.

**Not yet seen by a person:** the token-gated page inside the real menu-bar app windows (unit-tested and shown through headless Chrome; the reinstalled apps connect, but nobody has looked at the window), the 15-second hook retry against a real Claude session across a real update, the menu-bar app's own notification banners with their Allow, Deny, Answer and Open buttons, and a click through from one. Nobody could click **Allow** while it was being built. The plain fallback notifications that the daemon posts when the app isn't allowed are logged by macOS as displayed. Also unchecked: answering in Claude first while the inbox item is live (it should clear within a second or two), terminal `claude` sessions, **Open in Claude** for CLI sessions, and a full install from the published release on a second Mac (launchd agent and menu-bar app included). The full list is on the [Troubleshooting page](https://dopsonbr.github.io/session-inbox/troubleshooting.html#not-yet-verified-by-a-person).

**Known limits:** replies to idle sessions and Claude-generated titles need the `claude` CLI to be logged in (the desktop app's login isn't shared); everything else works without it. The app is ad-hoc signed, not notarized. Release downloads are Apple silicon only.

The design and its reasoning are in [docs/implementation.md](docs/implementation.md) (spec snapshot) and [DECISIONS.md](DECISIONS.md), which records every decision and where it departs from the spec. [docs/handoff.md](docs/handoff.md) says where to pick up.

## Development

```bash
bun install
bun test                              # unit, lifecycle-table, fixture-replay, API and site tests
bun run typecheck
bun run lint                          # Biome
bun scripts/smoke.ts                  # real daemon + real inbox-hook end to end; no Claude account needed
bun scripts/demo.ts                   # real daemon seeded with sample sessions; prints a URL to click around
bun run --cwd apps/desktop dev:mock   # UI against an in-memory fake daemon
bun run --cwd apps/daemon dev         # daemon with --watch on .dev/home
cd apps/desktop/src-tauri && cargo test && cargo clippy -- -D warnings
bun scripts/release.ts --skip-app     # payload, tarball and .sha256 in dist/release (no app: fast)
bun scripts/verify-release.ts         # check that tarball the way a user gets it
bun scripts/e2e-update.ts             # real-launchd update test against a local release server (about a minute)
bun scripts/build-site.ts --check     # build the docs site and check every link
```

When behaviour changes, update the matching page in `site/content/` in the same change. Releases: `bun scripts/release.ts --publish`, or the **Release** workflow (Actions, Release, Run: it bumps `VERSION` unless you choose none, runs every check, builds, tags and publishes). CI runs the same checks on every push.

| Path | What |
| --- | --- |
| `apps/daemon` | `inboxd`: ingest, attention-item state machine, holds, outbox, notification policy, updates, setup check, HTTP + SSE |
| `apps/hook` | `inbox-hook`: forward, long-poll, fail open; `record` mode writes fixtures; settings merge |
| `apps/cli` | `session-inbox`: install, uninstall, update, status, doctor (the one install path) |
| `apps/desktop/src` | Foldkit + Effect UI: main window and `?view=compact` popover |
| `apps/desktop/src-tauri` | Tauri v2 shell: tray, popover, notifications, deep links, autostart |
| `packages/contracts` | Effect Schemas shared by the daemon and the UI: the only shared code |
| `fixtures/` | Recorded (real) and synthetic hook payloads replayed by the tests |
| `ops/` | launchd plist template, Claude settings snippet |
| `scripts/` | Bun scripts: install, uninstall, build, build-shell, release, bump, verify-release, e2e-update, build-site, smoke, demo, spike tools |
| `site/` | The docs site (Markdown in `site/content`, built by `scripts/build-site.ts`) |
| `install.sh` | The `curl \| sh` bootstrap: download, verify, hand over to `session-inbox install` |
| `docs/` | Spec snapshot, mockups, Phase 0 spike report, handoff |

Stack: Bun 1.4 · Effect 4.1.2 · Foldkit 0.170 · Basecoat CSS · Tailwind 4 · Tauri 2 · SQLite. Contributor and agent guidance is in [CLAUDE.md](CLAUDE.md).
