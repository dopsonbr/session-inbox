# Truth pass: claims to re-verify against the final code

This file isn't published. Several features were documented from their descriptions while other branches were still building them. Before announcing the site, check each line below against the merged code, fix the page, then tick it off. Everything not listed was written from the current `main` (README, DECISIONS.md, the daemon and UI source).

Each line is `page: claim`.

## One-line installer and the `session-inbox` CLI

- [ ] install: the URL `https://raw.githubusercontent.com/dopsonbr/session-inbox/main/install.sh` and the file name `install.sh` at the repo root.
- [ ] install: the script downloads the latest GitHub release, verifies its SHA-256, and runs the bundled `session-inbox install`.
- [ ] install: Apple silicon only; no Bun or Rust needed.
- [ ] install: re-running `session-inbox install` is safe and changes nothing the second time.
- [ ] install, updating: `SESSION_INBOX_VERSION=v0.2.0` before `sh` is how the installer picks a version, and the `v` prefix is right.
- [ ] install: the install location list is complete and exact: `~/Library/Application Support/SessionInbox/`, `~/Library/LaunchAgents/com.sessioninbox.inboxd.plist`, `~/.claude/settings.json` (backup named `settings.json.bak-<timestamp>`), `~/Applications/Session Inbox.app`, `~/.local/bin/session-inbox` as a symlink.
- [ ] install: the app is opened after install and registers launch at login.
- [ ] install: `session-inbox uninstall` exists and removes hooks, launchd agent and app. **The subcommand name is a guess.** Also confirm it leaves `~/Library/Application Support/SessionInbox/` in place (the page says it does).
- [ ] install, troubleshooting: `~/.local/bin` needs to be on `PATH` for `session-inbox` to work.
- [ ] install: the first-run checklist (allow notifications, Alerts style for buttons, restart open Claude sessions, run `session-inbox doctor`).
- [ ] install, troubleshooting: the CLI sign-in advice (desktop-app auth isn't shared with the CLI) still applies to the packaged build.

## `session-inbox doctor`

- [ ] troubleshooting, install: doctor checks daemon running, hooks installed, which channel holds, `claude` on PATH and logged in, notifications. Confirm the list, and that notification status can actually be checked from a CLI.
- [ ] troubleshooting: the page says doctor "tells you which one it found". Confirm the output actually names the failing check.
- [ ] troubleshooting: the bug-report advice to paste doctor's output.

## Auto-update and `session-inbox update`

- [ ] updating, changelog: the daemon checks GitHub Releases every few hours (confirm the interval wording).
- [ ] updating: it installs by itself only when no tool call is held and nothing is in flight; otherwise it waits and retries later.
- [ ] updating: a banner with an **Update now** button appears when an update is ready. Confirm the button's exact label, and when the banner shows (the page says "ready but not installed yet").
- [ ] updating: **Update now** installs right away instead of waiting for the next check. Confirm it doesn't wait for "no hold".
- [ ] updating: the daemon restarts as part of an update, the app reconnects by itself, and a held call falls back to Claude's own prompt.
- [ ] updating: `session-inbox update --check` only checks and installs nothing; `session-inbox update` installs the latest.
- [ ] updating: an update replaces `inbox-hook`, `inboxd` and the UI, and keeps the database, settings, history and token. Confirm whether it also replaces the menu-bar app and re-merges the hooks, and say so if it does.
- [ ] updating, troubleshooting, how-it-works: `update.log` lives in `~/Library/Application Support/SessionInbox/`.
- [ ] updating: turning auto-update off is in Settings, in the Updates group, and then Session Inbox "only tells you when a new version is available". Confirm the label and the behaviour.
- [ ] updating: rollback by re-running the installer with `SESSION_INBOX_VERSION` leaves data alone, and auto-update will move forward again unless it's turned off.
- [ ] how-it-works, updating: the update check and download are the only network traffic, to `api.github.com` and the release assets.

## Settings pane

- [ ] settings, using-it: <kbd>⌘</kbd><kbd>,</kbd> opens the pane.
- [ ] settings: the groups are Approvals, Notifications, Sessions, Updates, and a change applies live with no restart.
- [ ] settings: which key sits in which group. The page assigns `holds.*` and `questions.answerMode` to Approvals, `notifications.*` to Notifications, and `titles.generate`, `items.confirmWindowMs`, `outbox.*` to Sessions. Confirm which keys the pane actually exposes, and drop or add rows.
- [ ] settings: defaults match `apps/daemon/src/settings.ts` at merge time (holds.enabled on, holds.budgetMs 120000, reviewGroupMs 30000, confirmWindowMs 300000, outbox 3 attempts and 5000 ms, safe prefix list).
- [ ] settings: the Updates group's switch default is "on".
- [ ] settings: rows written straight into the `settings` table are still read, and still need a daemon restart (the page says restart; if the daemon now reloads settings live, simplify the text).
- [ ] settings: the screenshot slot `settings.png` shows those four groups.

## Approval preview

- [ ] using-it, changelog: the permission card shows the diff for an edit or write, the full command for Bash, and what Claude said before it asked.
- [ ] using-it: the buttons are **Allow once**, **Always allow** and **Deny** (checked against the UI source today).
- [ ] using-it: Write and MultiEdit and NotebookEdit also get a diff, not only Edit. The page says "an edit or write".
- [ ] using-it: the screenshot slot `approval-diff.png` shows that card.

## Using it (behaviours checked in source but worth a live look)

- [ ] using-it: **Pause notifications** is in the menu-bar app and never silences permission requests (shell decision S-004).
- [ ] using-it: **Mute project** can be undone from the same menu.
- [ ] using-it: the popover has an **Open inbox** control, and <kbd>⌘</kbd><kbd>⇧</kbd><kbd>I</kbd> opens the window.
- [ ] using-it: Allow and Deny on a notification open nothing; the body click opens the item.
- [ ] using-it: "Open in Claude" lands on the exact session (still unverified live, per `docs/handoff.md`). The page states it as fact.
- [ ] using-it: answers sent through the inbox reach a live session (also unverified live; `updatedInput` vs `denyWithReason`).
- [ ] using-it, how-it-works: Notification Allow, Deny and Answer buttons work on a real desktop (unverified live).

## Holds

- [ ] holds: the rule, the 120 s fallback, the default held tools, the safe Bash list, and "Always allow" writing `.claude/settings.local.json` under `permissions.allow`. Matches README, G-014, G-016, D-012 and D-014 today; re-read if the Settings branch changes the rule.
- [ ] holds: "the hook gives up after half a second" matches H-002's 500 ms ingest timeout.

## Channels

- [ ] channels: still true that beta is installed from source only. If the one-line installer or the CLI grows a channel option, document it.
- [ ] channels: the table of per-channel paths, labels, schemes and the beta shortcut (<kbd>⌘</kbd><kbd>⌥</kbd><kbd>⇧</kbd><kbd>I</kbd>). The beta app and `sessioninbox-beta://` scheme are on `wip/beta-shell-channel`, not yet on `main` at the time of writing.

## Development

- [ ] development: `VERSION` at the repo root is the version source.
- [ ] development: `bun scripts/release.ts` is the release command. The page says it "cuts" a release and that pushing the tag runs the Release workflow. Confirm what the script does (bump, tag, push?) and the workflow's trigger, and rewrite that paragraph to match.
- [ ] development: the Release workflow builds the app and publishes it with checksums as a GitHub release.
- [ ] development: the repo layout table still matches (new top-level folders such as `site/`).

## Changelog

- [ ] changelog: 0.2.0 lists exactly what shipped. Update the date or add it if you add dates, and re-check each bullet against the tagged release.

## Site mechanics

- [ ] site: after the first deploy, open <https://dopsonbr.github.io/session-inbox/> and click through every page (relative links under the base path, assets load, favicon shows).
- [ ] site: add the five screenshots (`inbox-light.png`, `inbox-dark.png`, `popover.png`, `approval-diff.png`, `settings.png`) to `site/assets/screenshots/` at the pixel sizes given in the pages, or update the sizes in the `[[screenshot ...]]` lines.
- [ ] site: the README docs link (the user adds it).
