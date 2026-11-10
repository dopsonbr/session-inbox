# Handoff: install channels and live verification

Status as of 2026-11-09. Read with [DECISIONS.md](../DECISIONS.md) (H-014 to H-018, D-033, D-034 and C-012 cover this round) and [CLAUDE.md](../CLAUDE.md).

## Where things stand

**On `main` (pushed, tests green: 330 pass, typecheck, lint and smoke clean):**

- **GA and beta install channels.** `install.ts --channel ga|beta`, `uninstall.ts --channel …` and `scripts/channels.ts` (`status`, `holds <ga|beta>`, `open <ga|beta>`). Each channel has its own home, launchd label, port and page title. Both channels' hooks sit in `~/.claude/settings.json`, and each install leaves the other channel's hooks alone (H-014).
- **The hook finds its daemon from its own path**, `<home>/bin/inbox-hook` (H-015). Before this, a `--home` install silently talked to the default home.
- **One holder, one observer** (H-016). A channel installed while the other's hooks are present gets `holds.enabled=false`. It opens the same question and permission items the holder does, just not live, and it still notifies, as you chose.
- **`install.ts --app`** builds the menu-bar app and installs it as `~/Applications/<title>.app` (H-017).
- **Fixes found on the real install:**
  - The reinstall raced `launchctl bootout` and left the agent unloaded (H-018).
  - A lapsed AskUserQuestion hold opened a duplicate permission item (D-034).
- **Build stamp.** Health, `connection.json` and the startup log now carry the channel and build stamp (C-012, D-033).

**On this Mac right now:**

- **GA daemon:** installed and running as `com.sessioninbox.inboxd`, build `8ef7cf8`.
- **GA hooks:** in `~/.claude/settings.json`. The original file is backed up at `~/.claude/settings.json.bak-2026-11-08T21-13-13-911Z`.
- **GA menu-bar app:** running and connected, but launched from the build folder (`apps/desktop/src-tauri/target/release/bundle/macos/Session Inbox.app`), not yet installed into `~/Applications`.
- **Beta:** not installed.

**Verified live:**

- Hooks fire for desktop-app sessions: `runtime=desktop`, with a `local_…` host session id. Settings changes hot-reload into already-running sessions.
- `permission_mode: "auto"` calls are not held.
- A held AskUserQuestion shows up in the inbox, and the 120 s lapse falls back to Claude's own prompt.
- The menu-bar app reconnects by itself after a daemon restart.

**Not yet verified:**

- That an answer given in the inbox reaches a live session through `updatedInput`. The one live attempt lapsed overnight and was answered in Claude.
- Notification Allow/Deny/Answer buttons and clicks.
- That `claude://code/continue?session=…` lands on the right session.
- Outbox `--resume` replies and Claude-written titles. Both need the `claude` CLI to be logged in; at last check (`loggedIn:false`) it wasn't, and desktop-app auth isn't shared with the CLI.

## Remaining work, in order

1. **Finish the beta menu-bar app.** A subagent's work-in-progress is on branch `wip/beta-shell-channel` (11ee2af, pushed, worktree `.claude/worktrees/agent-a01fe2a86bd22e729`). It adds:
   - `src-tauri/src/channel.rs`, compile-time `SESSION_INBOX_CHANNEL` choosing the home, launchd label, bundle id, `sessioninbox-beta` scheme, ⌘⌥⇧I and the product name;
   - `build-shell.ts --channel beta`, passing a `--config` override.

   It has **not** been through `cargo test`, clippy or a bundle build. Steps:
   - Merge it into `main`. It only touches `apps/desktop/src-tauri/**` and `scripts/build-shell.ts`, so no conflicts are expected.
   - In `apps/desktop/src-tauri`, run `cargo test && cargo clippy -- -D warnings` twice: once plain, once with `SESSION_INBOX_CHANNEL=beta`.
   - Run `bun scripts/build-shell.ts --channel beta` and confirm it prints `…/Session Inbox Beta.app` as its **last** line. `install.ts --app` reads that line.
   - Add shell decisions S-010 onward to DECISIONS.md: compile-time channel, beta identifiers/scheme/shortcut, and the `--config` override.
2. **Install the GA app properly:** `bun scripts/install.ts --yes --app`. It quits the copy running from the build folder and installs `~/Applications/Session Inbox.app`. Then check that launch at login points at the `~/Applications` path.
3. **Install beta beside GA:** `bun scripts/install.ts --channel beta --yes --app`. Then run `bun scripts/channels.ts` and confirm:
   - beta shows `holds no (observer)`, a different build stamp and its own URL;
   - both apps are connected;
   - a held Bash in a default-mode session appears in both inboxes, live only in GA;
   - both apps notify.

   The ad-hoc-signed beta app may need its notification permission granted once, in System Settings → Notifications.
4. **Finish live verification**, with someone at the Mac and an answer within 120 s:
   - Answer an AskUserQuestion from the inbox and confirm a `PostToolUse` with `tool_response.answers` arrives, so that `questions.answerModeByRuntime` stays empty (P-004).
   - Allow and Deny a held Bash from the notification buttons, and click a notification.
   - Use "Open in Claude" on a desktop item and on a CLI item.
   - Log the CLI in (`claude` in a plain terminal) and check an outbox reply and a generated title.
   - Record a real `Notification` fixture with `inbox-hook record Notification` and scrub it into `fixtures/recorded/`.
5. **Housekeeping:**
   - Remove the old merged `worktree-agent-*` branches and `.claude/worktrees/` (seven worktrees).
   - Live payloads now carry `scratchpad_dir`, `prompt_id` and `effort`. They're stored raw already; add them to the contracts as optional fields only if something needs them.

## Things to know

- `channels.ts holds <ga|beta>` restarts both daemons. Hooks held at that moment fall back to Claude's own prompt, so switch when nothing is waiting.
- A daemon reinstall does the same: held hooks lapse to `ask`, and that is harmless.
- The beta page differs from GA only in its `<title>` ("Session Inbox Beta"). There's no in-page badge yet, which would be a small UI addition if side-by-side windows get confusing.
- Roll back with:
  - `bun scripts/uninstall.ts --channel beta --yes --app`, then the same with `--channel ga`. Each removes only its own channel's hooks and agent.
  - Restoring the settings backup above also works.
