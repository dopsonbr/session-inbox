/**
 * GA and beta side by side (H-014, H-016).
 *   bun scripts/channels.ts               status of both channels
 *   bun scripts/channels.ts holds <ga|beta>   that channel holds hooks; the other observes
 *   bun scripts/channels.ts open <ga|beta>    open that channel's inbox in the browser
 * `holds` writes `holds.enabled` rows (they beat the plist
 * defaults) and restarts both daemons so they re-read settings.
 */
import { Database } from "bun:sqlite"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { hookHome } from "../apps/hook/src/settings.ts"
import { CHANNELS, type Channel, isChannel, paths } from "../packages/contracts/src/paths.ts"
import { defaultSettingsPath, parseSettings, plistPath, uid } from "./_common.ts"

const channels = Object.keys(CHANNELS) as Channel[]
const [cmd = "status", arg] = process.argv.slice(2)

type Conn = { socketPath: string; httpPort: number; token: string }
const connection = (c: Channel): Conn | null => {
  try {
    return JSON.parse(readFileSync(paths(CHANNELS[c].home).connection, "utf8")) as Conn
  } catch {
    return null
  }
}

const hookedHomes = (): Set<string> => {
  const file = defaultSettingsPath()
  const s = parseSettings(existsSync(file) ? readFileSync(file, "utf8") : null, file)
  const homes = new Set<string>()
  for (const groups of Object.values(s.hooks ?? {}))
    if (Array.isArray(groups))
      for (const g of groups)
        for (const h of g?.hooks ?? []) {
          const home = hookHome(h?.command)
          if (home) homes.add(home)
        }
  return homes
}

const settingRow = (c: Channel, key: string): unknown => {
  const db = paths(CHANNELS[c].home).db
  if (!existsSync(db)) return undefined
  const d = new Database(db, { readonly: true })
  try {
    const r = d.query("SELECT value_json FROM settings WHERE key = ?").get(key) as {
      value_json: string
    } | null
    return r ? JSON.parse(r.value_json) : undefined
  } catch {
    return undefined
  } finally {
    d.close()
  }
}

const plistDefault = (c: Channel, key: string): unknown => {
  try {
    const xml = readFileSync(plistPath(CHANNELS[c].label), "utf8")
    const m = /<key>SESSION_INBOX_SETTINGS<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)
    const json = (m?.[1] ?? "{}").replaceAll("&quot;", '"').replaceAll("&amp;", "&")
    return (JSON.parse(json) as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

const status = async () => {
  const hooked = hookedHomes()
  for (const c of channels) {
    const { home, label, title } = CHANNELS[c]
    const installed = existsSync(plistPath(label))
    console.log(`\n${title} (${c})`)
    if (!installed && !hooked.has(home)) {
      console.log("  not installed")
      continue
    }
    const lc = Bun.spawnSync(["launchctl", "print", `gui/${uid()}/${label}`]).stdout.toString()
    const pid = /\bpid = (\d+)/.exec(lc)?.[1]
    const holds = settingRow(c, "holds.enabled") ?? plistDefault(c, "holds.enabled") ?? true
    console.log(
      `  launchd  ${installed ? (pid ? `running (pid ${pid})` : "loaded, not running") : "no agent"}`,
    )
    console.log(`  hooks    ${hooked.has(home) ? "in ~/.claude/settings.json" : "not installed"}`)
    console.log(`  holds    ${holds ? "yes" : "no (observer)"}`)
    const conn = connection(c)
    if (!conn) continue
    try {
      const h = (await (
        await fetch("http://localhost/v1/health", {
          unix: conn.socketPath,
          signal: AbortSignal.timeout(1000),
        })
      ).json()) as { build?: string; shellConnected: boolean }
      const snap = (await (
        await fetch(`http://127.0.0.1:${conn.httpPort}/v1/snapshot`, {
          headers: { authorization: `Bearer ${conn.token}` },
          signal: AbortSignal.timeout(1000),
        })
      ).json()) as { sessions: unknown[]; counts: Record<string, number> }
      console.log(`  build    ${h.build ?? "?"}`)
      console.log(`  app      ${h.shellConnected ? "connected" : "not connected"}`)
      console.log(
        `  inbox    ${snap.sessions.length} sessions · ${snap.counts.needsYou ?? 0} need you · ${snap.counts.review ?? 0} to review`,
      )
      console.log(`  url      http://127.0.0.1:${conn.httpPort}/`)
    } catch (e) {
      console.log(`  daemon   unreachable (${(e as Error).message})`)
    }
  }
}

const setHolds = (holder: Channel) => {
  for (const c of channels) {
    const db = paths(CHANNELS[c].home).db
    if (!existsSync(db)) continue
    const on = c === holder
    const d = new Database(db)
    d.exec("PRAGMA busy_timeout = 2000")
    const put = d.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)")
    put.run("holds.enabled", JSON.stringify(on))
    d.close()
    const k = Bun.spawnSync(["launchctl", "kickstart", "-k", `gui/${uid()}/${CHANNELS[c].label}`])
    console.log(`${c}: holds ${on ? "on" : "off"}; restart -> exit ${k.exitCode}`)
  }
}

if (cmd === "status") await status()
else if (cmd === "holds" && isChannel(arg)) setHolds(arg)
else if (cmd === "open" && isChannel(arg)) {
  const conn = connection(arg)
  if (!conn) throw new Error(`${arg} is not running`)
  Bun.spawnSync(["open", `http://127.0.0.1:${conn.httpPort}/`])
} else {
  console.error("usage: bun scripts/channels.ts [status | holds <ga|beta> | open <ga|beta>]")
  process.exit(1)
}
