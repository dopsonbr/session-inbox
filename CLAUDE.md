# Session Inbox

macOS menu-bar companion for local Claude Code sessions. It notifies you when a session needs you, lets you answer or approve without opening Claude, and hands you back to Claude for real work.

- Implementation doc: claude.ai/artifact/HuCXKRfgC8b5SdUH2FVmEB. Mockups: claude.ai/artifact/RPkJ4xpCE5ZK6PZvJNJomw.
- **DECISIONS.md is the source of truth for what was decided.** Add an entry for every decision you make, in your area's section. Short: decision + why.

## Rules

- Bun for everything: runtime, tests (`bun test`), scripts (`scripts/*.ts`), builds (`bun build --compile`). Don't add Node, npm, or bash scripts.
- The daemon (`apps/daemon`) owns all domain logic. The UI (`apps/desktop/src`) and the shell (`apps/desktop/src-tauri`) render state and send intents. Nothing else decides.
- Shared types live only in `packages/contracts` (Effect Schema, `effect@4.1.2`). Change a contract there first, then both sides.
- Effect is **v4** (4.1.2). Its API differs from v3: `Schema.Literals([...])`, `Schema.Union([...])`, no `onExcessProperty: "preserve"`, HTTP lives in `effect/unstable/http`. Read `node_modules/.bun/effect@4.1.2/node_modules/effect/dist/*.d.ts` when unsure; don't guess from v3 memory.
- Pin exact versions (DECISIONS.md G-005).
- Fail open: if the daemon is down, Claude must behave exactly as if no hooks were installed.
- Never install hooks into `~/.claude/settings.json` or load the launchd agent from a test or a script run without `--yes`. Tests use a temp `SESSION_INBOX_HOME` and project-local settings.

## Commands

```bash
bun install
bun test                 # all unit + fixture tests
bun run typecheck
bun run lint
bun scripts/smoke.ts     # end-to-end: daemon + hook + fake payloads, no Claude account needed
```
