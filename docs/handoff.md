# Handoff: publish the first release, then check what no person has seen

Status as of 2026-11-09. Read with [DECISIONS.md](../DECISIONS.md) (G-024 to G-031, C-012 to C-024, D-033 to D-066, H-014 to H-035, U-022 to U-040, S-010 to S-020 and P-012 to P-020 cover this round), [CLAUDE.md](../CLAUDE.md) and the docs site (<https://dopsonbr.github.io/session-inbox/>, source in `site/content/`).

## Where things stand

**Merged on `main`, tests green:**

- **Releases and the CLI.** `VERSION` is 0.2.0. `scripts/release.ts` builds a tarball (hook, daemon, `session-inbox` CLI, UI, menu-bar app; Apple silicon only, about 125 MB) and `install.sh` installs it with one `curl | sh`. `session-inbox` has `install`, `uninstall`, `update`, `status`, `doctor`, `holds` and `open`. Install from a mirror works too (G-024 to G-029, H-019 to H-035).
- **Updates.** The daemon checks every 6 hours and installs by itself only when quiet (no held call, no reply in flight, no hook event for 30 s). **Update now** banner, `session-inbox update --yes`. Beta never updates from releases.
- **Settings pane** (applied live, five groups), **retention** (14 days, daily prune), **setup check** (`session-inbox doctor` and the Setup page, with **Send test notification**).
- **Approval preview**: a real diff, the full command, and what Claude said before asking. Claude's last message on review items. Titles from the desktop app's own title.
- **Notifications** moved to `UNUserNotificationCenter`; the app reports its permission and the daemon falls back to plain notifications while it isn't allowed (D-062, S-014 to S-018).
- **Beta shell** (`channel.rs`, S-010 to S-013) merged. **Docs site** in `site/`, deployed by `.github/workflows/pages.yml` (Pages needs its source set to GitHub Actions once).

**On this Mac right now:** <!-- ORCH: replace with the real state before handing over. Last known: GA is the old 0.1.0 source install, with the legacy menu-bar app running from the build folder (apps/desktop/src-tauri/target/release/bundle/macos/), not from ~/Applications. Say whether the orchestrator replaced it, which build is installed, and whether a beta is installed. -->
See the orchestrator's final note for the machine state.

**Branches left over:** three old `worktree-agent-*` branches and the remote branch `wip/beta-shell-channel` (merged work; force-deleting them wasn't permitted). <!-- ORCH: list the three branch names. -->

## Verified live, and how

- **Answers reach a held `AskUserQuestion`.** A real desktop session (Claude Code 2.1.321): the answer arrived as `allow` plus `updatedInput.answers`, and the `PostToolUse` result matched 27 ms later. `questions.answerModeByRuntime` stayed empty (P-012).
- **Allow and Deny release a held Bash** 0.5 s after the decision. The first Bash of a session takes Claude about 10 s itself, however long it was held (P-013).
- **Open in Claude lands on the exact desktop session.** The deep link was opened through the daemon and the desktop app's window layout then showed that session focused (P-017).
- **Titles** come from the desktop app's `custom-title` transcript lines (P-015). **The approval preview** shows a real diff, and its context is read again when an item opens (D-066).
- **The update path**, end to end under the real launchd against a local release server: `bun scripts/e2e-update.ts`, 38 checks. A held call blocks the automatic update, it applies after 30 s of quiet, hooks fail open during the swap, a corrupted download is refused, and the real settings and GA/beta plists are unchanged afterwards (H-031).
- **Notification delivery without the app's buttons**: with the app reporting `denied`, the setup check's test notification went out as `via: fallback`, and `usernoted` logged it as displayed (P-019).

## Not verified, and why

- **The app's own banners and their Allow / Deny / Answer / Open buttons, and a click through.** Nobody could click **Allow** while it was built, and the shell used for the checks has neither Screen Recording nor Accessibility permission (P-016). Everything native was checked through `/usr/bin/log` and the daemon's API. Also unseen: whether the Alerts style keeps the buttons on screen.
- **A first install from a real GitHub Release.** None exists yet. The one-liner currently answers "no published release found".
- **Opening a CLI session** (`claude://resume?session=…`). Desktop sessions are verified; CLI ones aren't.
- **A real `Notification` hook payload.** Notification hooks can't be triggered with `claude -p` (P-010), so no real fixture exists.
- **Gatekeeper on a tarball copied between Macs.** The app is ad-hoc signed, not notarized (S-007). The installer clears the quarantine flag on what it copies (H-033).
- **A Focus mode** can hide banners whatever we do (P-020). The setup check can't see it.

## Remaining work, in order

1. **Publish the first release.** It's the owner's step. Either `bun scripts/release.ts --publish` from a clean checkout of `main` (builds in about a minute, creates the release with `gh`, publishes the version in `VERSION`, 0.2.0), or run the **Release** workflow from the Actions tab (bumps first, so a patch bump publishes 0.2.1). Then delete the `<!-- REMOVE AFTER FIRST RELEASE -->` blocks in `site/content/index.md`, `install.md`, `changelog.md` and in `README.md`, and update the changelog heading if the version differs.
2. **Install on the second Mac with the one-liner**, then click **Allow** on the notification prompt. Run `session-inbox doctor`. If the prompt is missed, the fix is System Settings, Notifications, Session Inbox, Allow; the Setup page links to it.
3. **See the app's own banners once.** From the Setup page choose **Send test notification**, then trigger a held Bash and a question, and click **Allow**, **Deny**, **Answer** and **Open**. Check the Alerts style. Then move the lines this clears out of the "Not yet verified by a person" list in `site/content/troubleshooting.md` and `README.md`.
4. **Try the experimental PermissionRequest mode** that another agent is building: it answers Claude's own prompt through its `PermissionRequest` hook. Once it's merged, document it in `site/content/holds.md` where the `TODO(orchestrator): PermissionRequest` comment is. <!-- ORCH: say whether it merged and which setting turns it on. -->
5. **The leftover branches.** Delete the three old `worktree-agent-*` branches and `wip/beta-shell-channel` once you're allowed to force-delete: `git branch -D <name>` and `git push origin --delete wip/beta-shell-channel`. Remove `.claude/worktrees/` too.
6. **Smaller follow-ups:**
   - One multi-call binary instead of three, to cut the 125 MB download.
   - Developer ID signing and notarization (S-007, G-028), and then a signed update channel.
   - Check **Open in Claude** for a CLI session.
   - Record a real `Notification` fixture with `inbox-hook record Notification` and scrub it into `fixtures/recorded/`.
   - Take the six screenshots in `site/assets/screenshots/` (`inbox-light`, `inbox-dark`, `popover`, `approval-diff`, `settings`, `setup`; sizes are in the page that uses each).

## Things to know

- Reinstalling or restarting the daemon lets any held call lapse to Claude's own prompt, which is harmless. `session-inbox holds <ga|beta>` restarts both daemons, so switch when nothing is waiting.
- Replies to idle sessions and Haiku titles need the `claude` CLI to be logged in; the desktop app's login isn't shared. Without it the reply box says so and offers **Open in Claude**.
- `scripts/e2e-update.ts` is the only script that uses the real launchd (an isolated label under `/tmp`). Run it only when nobody is reinstalling beta, or its closing check on the real plists trips.
- When behaviour changes, update the matching page under `site/content/` in the same change. The site deploys on every push to `main` that touches `site/**`, `README.md`, `DECISIONS.md` or `VERSION`.
- Roll back a bad install with `session-inbox uninstall --yes` (dry run without `--yes`), or restore the `settings.json.bak-<timestamp>` file the installer leaves beside `~/.claude/settings.json`.
