# Decisions

Every implementation decision, newest at the bottom of each section. Format:
`D-NNN — decision. Why.` Sources: the implementation doc
(claude.ai/artifact/HuCXKRfgC8b5SdUH2FVmEB) and the mockups canvas
(claude.ai/artifact/RPkJ4xpCE5ZK6PZvJNJomw, page "Desktop v2"). Where this file
and the doc disagree, this file wins (it records what we actually learned).

Sections are owned by area so parallel branches merge cleanly. Number new
entries with your section's prefix (G, C, D, H, U, S, P) and the next free number.

## General

- G-001 — Scope is **local sessions on this Mac only** (CLI + Claude desktop's Code tab). No cloud sessions, no sync. User answered this in the doc's open questions.
- G-002 — The daemon is the only place that decides (classification, lifecycle, priority, notification policy, dedupe, reply routing). UI and shell render and send intents. Straight from the doc's guiding principle.
- G-003 — Bun is the language and runtime for everything that isn't Rust: daemon, hook, UI build, and all repo tooling (`scripts/*.ts` run with `bun`). No Node, npm, or shell scripts beyond one-liners. User instruction.
- G-004 — One Bun workspace: `apps/{daemon,hook,desktop}`, `packages/contracts`, `ops/`, `scripts/`, `fixtures/`. Matches the doc's repo layout.
- G-005 — Pin exact versions: `effect@4.1.2` (Foldkit 0.170 peers on `effect ~4.1.0`, `@effect/platform-bun` and `@effect/sql-sqlite-bun` are 4.1.2), `foldkit@0.170.0`, `@foldkit/ui@0.170.0`, `basecoat-css@1.1.0`, `tailwindcss@4.3.5`, `@biomejs/biome@2.6.6`, `typescript@5.9.3`. Doc says pin; 4.1.x is the one line all of them agree on.
- G-006 — TypeScript 5.9.3, not 7.x. Foldkit/Effect tooling is tested against 5.x; tsc is only used for `typecheck`, Bun runs TS directly.
- G-007 — Rust installed with Homebrew (`brew install rust`) because Tauri v2 needs cargo and none was present. Homebrew was already the machine's package manager; rustup can replace it later without code changes.
- G-008 — Work happens on short-lived branches per area (worktrees), merged to `main` often. User instruction: commit and merge frequently.
- G-009 — Testing is light and layered: pure unit tests (`bun test`) for domain transitions and UI update functions; fixture replay of real hook JSON against in-memory SQLite; a `scripts/smoke.ts` end-to-end run (daemon + hook binary + fake Claude payloads) that needs no Claude account. User asked for light ways to verify while building.
- G-010 — Delegation: Opus 5.5 (medium) for the daemon and the Foldkit UI (design-heavy, unfamiliar APIs); Sonnet 5.5 (medium) for the hook CLI, ops/install scripts, the Phase 0 spike and the Tauri shell (well-specified, mechanical). User instruction.
- G-011 — The daemon serves the built UI same-origin at `http://127.0.0.1:<port>/` and injects the bearer token into `<meta name="session-inbox-token">` (only after a Host-header check against DNS rebinding). The Tauri windows just load that URL, and so does a plain browser, so the UI needs no Tauri APIs and can be tested in any browser. The UI always calls relative `/v1/...`; in dev a proxy adds the header.
- G-012 — The shell, not the webview, consumes the daemon stream for native work: a Rust SSE client (`?client=shell`) posts notifications and sets the tray badge. Notifications then don't depend on a webview being alive, and the UI stays shell-agnostic.
- G-013 — The daemon itself opens "Open in Claude" URLs (`open <url>`); the shell needs no opener plugin. For CLI sessions with no URL, it copies `cd <cwd> && claude --resume <id>` to the clipboard.
- G-014 — Hold a PreToolUse only when Claude itself would have asked (permission_mode `default`, tool in the hold matcher, no matching allow rule in user/project/local settings, project not muted). AskUserQuestion is always held. Otherwise the inbox would add friction where Claude adds none.
- G-015 — Answering a pending AskUserQuestion goes back through its held PreToolUse hook (`allow` + `updatedInput.answers`, or `deny` + reason as a fallback the spike picks). `--resume -p` is only for idle/waiting sessions (free-text replies, non-live questions).
- G-016 — "Always allow" writes to `<project>/.claude/settings.local.json` `permissions.allow`, the same scope Claude's own "don't ask again for this project" uses. The user answered yes to writing Claude's settings; project scope keeps the blast radius small.
- G-017 — Session titles: the first prompt right away, then a 3–6 word title from `claude -p --model haiku` run with `SESSION_INBOX_INTERNAL=1` and hooks disabled so it's never ingested. The user answered "yes" to both options in the doc, so we do both: instant fallback, better title moments later.
- G-018 — Without a connected shell, the daemon falls back to `osascript` notifications (no actions) so "window closed ⇒ one notification within 2 s" holds even before the Tauri app runs.
- G-019 — Project = the main worktree root (via `git rev-parse --git-common-dir`). A session in a linked worktree records it in `session.worktree`, so all of a repo's worktrees group under one project.
- G-020 — `scripts/install.ts` is a dry run by default. It touches `~/.claude/settings.json` and launchd only with `--yes`, backs up first, and merges idempotently. Installing hooks globally changes every Claude session on the machine, so it's an explicit step.
- G-021 — Quiet hours are out of scope for v1. The user said not to worry about them.

## Contracts

- C-001 — `packages/contracts` exports Effect Schemas only; it is the only code the daemon and UI share. Node-only helpers (`paths`) live at the `@session-inbox/contracts/paths` subpath so the UI bundle never pulls `node:os`.
- C-002 — Effect 4 dropped `onExcessProperty: "preserve"`. `decodeHookPayload(schema, raw)` decodes and then overlays typed fields onto the raw object, so unknown fields survive. The raw JSON is also stored verbatim in `events.payload_json`.
- C-003 — Added hook events beyond the doc's table: `UserPromptSubmit` (first prompt → provisional title; any prompt confirms an answered item and marks the session running), `SubagentStart` (tree node appears before it finishes), `SessionEnd` (state `ended`; abnormal end → failed). They are cheap and fill gaps the doc left open.
- C-004 — The hook sends an envelope `{event, payload, env, sentAt}`. `env` carries what only the hook's process can see: `CLAUDE_CODE_ENTRYPOINT` (`claude-desktop` ⇒ runtime `desktop`, `cli` ⇒ `cli`), `CLAUDE_CODE_HOST_SESSION_ID` (desktop's `local_<uuid>`, used for deep links), and the parent Claude pid.
- C-005 — Stream messages are a tagged union `hello | delta | notify | badge | reset`. `delta` carries full upserted rows (projects, sessions, agents, items) plus counts, not patches. Simpler to merge, small enough at this scale.
- C-006 — Items carry a daemon-computed `queue` (`needs-you | review | snoozed | done`), `live` (a PreToolUse hook is being held for it right now) and `unconfirmed`. The UI filters on `queue` and never derives it.
- C-007 — Decisions include `ask`, which releases a held hook so Claude's own prompt appears. "Open in Claude" on a live item sends `ask` first, so you're never looking at a frozen session.
- C-008 — Daemon files live in `~/Library/Application Support/SessionInbox/` (override with `SESSION_INBOX_HOME` for tests and dev). Keep test homes short: macOS caps Unix socket paths at 104 bytes.

## Daemon

## Hook & Ops

- H-001 — `inbox-hook` imports only `contracts/paths` (no Effect, no schema decode) and posts the raw envelope. Why: cold start. The daemon validates; the hook must never be a reason Claude is slow.
- H-002 — Fail open everywhere: any throw, refused/missing socket, 500 ms ingest timeout, non-2xx, or bad stdin JSON → exit 0, empty stdout. Never exit 2. A vanished daemon mid-poll is also silent (not `ask`), so Claude behaves as with no hooks. Only a lapsed hold budget prints `ask`.
- H-003 — Hold budget 120 s (env `SESSION_INBOX_HOLD_SECONDS` overrides, for tests), polled in `wait<=110` slices; a `pending` reply just loops. The registered PreToolUse `timeout` is 130 s so Claude never kills the hook before our own `ask` fallback prints.
- H-004 — No top-level `await` in `main.ts` (the `main()` wrapper): `bun build --bytecode` emits CommonJS and fails otherwise. Compile flags: `--minify --bytecode` for the hook; the daemon uses `--minify` only.
- H-005 — Cold start of the compiled binary (90 MB, daemon down, Apple silicon, Bun 1.4.4): about 30-40 ms steady state. The first exec of a freshly written binary costs about 700 ms (one-off macOS scan). `install.ts` runs `inbox-hook warmup` (with `SESSION_INBOX_INTERNAL=1`, so a no-op) right after copying so Claude's first hook doesn't pay it; the compiled-binary test does the same.
- H-006 — Hook registration format (Claude Code 2.1.x): `hooks.<Event> = [{matcher?, hooks:[{type:"command", command, timeout}]}]`, timeout in seconds, command `"<home>/bin/inbox-hook" <Event>` quoted because the path contains a space. PreToolUse matcher `Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|AskUserQuestion` (broader than G-014's allow-rule filter: the daemon decides whether to hold; a non-held PreToolUse just returns no `requestId`). PostToolUse matcher `*`. Others have no matcher, timeout 5.
- H-007 — Settings merge lives in `apps/hook/src/settings.ts` as pure functions, our entries identified by the executable basename `inbox-hook` (so moving `--home` replaces rather than duplicates). Merge replaces ours in place (order of user hooks untouched), removes strays elsewhere, and keeps every other key/hook. `unmergeHooks` removes only groups that became empty because of us, so merge→unmerge round-trips to the original (an originally absent `hooks` key is dropped again). `ops/claude-settings.snippet.json` is generated from `buildHooks("<home>")` and a test keeps it in sync.
- H-008 — `install.ts`/`uninstall.ts` are dry-run by default and print a unified diff of settings.json; `--yes` backs up to `settings.json.bak-<timestamp>` first. A settings file that isn't valid JSON aborts untouched. Scripts import `paths.ts` by relative path (root has no dep on contracts).
- H-009 — launchd plist template sets `SESSION_INBOX_HOME` in `EnvironmentVariables` so a non-default `--home` reaches the daemon; install does `bootout` (ignored), `bootstrap gui/$UID`, `kickstart -k`. Uninstall boots out and removes the plist but leaves binaries and data.
- H-010 — Record mode stores only `{event, payload, env}` with the three env fields the envelope already carries (entrypoint, host session id, claude pid) — never process env, tokens or account ids. Payloads themselves may contain prompts and file contents, so `fixtures/` should be treated as private and scrubbed before anything is committed.
- H-011 — Tests run the hook as a subprocess against a fake daemon on a Unix socket under `/tmp/sih-XXXX`, for both `bun src/main.ts` and a freshly compiled binary. The install-script test runs `--yes` only with `--settings <tmp> --home <tmp> --no-launchd`.

## UI

## Shell

## Phase 0 spike findings
