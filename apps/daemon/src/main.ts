/**
 * inboxd entry. `--home <dir>` (default SESSION_INBOX_HOME or Application Support),
 * `--port <n>` (default random), `--ui-dir <dir>` (default SESSION_INBOX_UI_DIR or
 * apps/desktop/dist), `--dev` (fixed port 7357 unless --port, verbose).
 * Logs go to stderr (launchd captures them).
 */
import { BunRuntime } from "@effect/platform-bun"
import { DEFAULT_HOME } from "@session-inbox/contracts/paths"
import { Effect } from "effect"
import { DEFAULT_CLAUDE_DIR, DEFAULT_UI_DIR, daemonProgram } from "./daemon.ts"
import { LiveServices } from "./services.ts"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? null) : null
}
const dev = args.includes("--dev")
const home = flag("--home") ?? process.env.SESSION_INBOX_HOME ?? DEFAULT_HOME
const portArg = flag("--port")
const port = portArg !== null ? Number(portArg) : dev ? 7357 : 0
const uiDir = flag("--ui-dir") ?? process.env.SESSION_INBOX_UI_DIR ?? DEFAULT_UI_DIR

daemonProgram({ home, port, uiDir, claudeConfigDir: DEFAULT_CLAUDE_DIR }).pipe(
  Effect.scoped,
  Effect.provide(LiveServices),
  BunRuntime.runMain,
)
