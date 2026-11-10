/**
 * inboxd entry. `--home <dir>` (default SESSION_INBOX_HOME or Application Support),
 * `--port <n>` (default random), `--ui-dir <dir>` (default SESSION_INBOX_UI_DIR or
 * apps/desktop/dist), `--dev` (fixed port 7357 unless --port, verbose).
 * Logs go to stderr (launchd captures them).
 */
import { BunRuntime } from "@effect/platform-bun"
import { DEFAULT_HOME, isChannel } from "@session-inbox/contracts/paths"
import { Effect, Layer } from "effect"
import { DEFAULT_CLAUDE_DIR, DEFAULT_UI_DIR, daemonProgram } from "./daemon.ts"
import { LiveServices, makeLiveUpdater, Updater } from "./services.ts"

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
const channelArg = flag("--channel") ?? process.env.SESSION_INBOX_CHANNEL ?? "ga"
const channel = isChannel(channelArg) ? channelArg : "ga"
/** JSON object of setting defaults; rows in the settings table still win (H-016). */
const settingDefaults = (() => {
  const raw = process.env.SESSION_INBOX_SETTINGS
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === "object" && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
})()

daemonProgram({
  home,
  port,
  uiDir,
  claudeConfigDir: DEFAULT_CLAUDE_DIR,
  channel,
  settingDefaults,
}).pipe(
  Effect.scoped,
  Effect.provide(LiveServices),
  // Unsupported (no checks, no UI) unless <home>/bin/session-inbox exists (D-035).
  Effect.provide(Layer.succeed(Updater)(makeLiveUpdater({ home, channel }))),
  BunRuntime.runMain,
)
