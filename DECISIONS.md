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

## UI

## Shell

## Phase 0 spike findings
