/**
 * GA and beta side by side (H-014, H-016, H-017): status, which channel holds, open.
 * `holds` writes `holds.enabled` rows (they beat the plist defaults) and restarts both
 * daemons so they re-read settings.
 */
import { Database } from "bun:sqlite"
import { existsSync, readFileSync } from "node:fs"
import { CHANNELS, type Channel, paths } from "@session-inbox/contracts/paths"
import { hookHome } from "../../hook/src/settings.ts"
import { defaultSettingsPath, parseSettings, plistPath, type Say, uid } from "./common.ts"
import { kickstart, plistDefault } from "./launchd.ts"
import { readInstallRecord } from "./state.ts"

const channels = Object.keys(CHANNELS) as Channel[]

type Conn = { socketPath: string; httpPort: number; token: string }
export const connection = (home: string): Conn | null => {
  try {
    return JSON.parse(readFileSync(paths(home).connection, "utf8")) as Conn
  } catch {
    return null
  }
}

export const hookedHomes = (settingsPath: string = defaultSettingsPath()): Set<string> => {
  const s = parseSettings(
    existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null,
    settingsPath,
  )
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

export const settingRow = (home: string, key: string): unknown => {
  const db = paths(home).db
  if (!existsSync(db)) return undefined
  try {
    const d = new Database(db, { readonly: true })
    try {
      const r = d.query("SELECT value_json FROM settings WHERE key = ?").get(key) as {
        value_json: string
      } | null
      return r ? JSON.parse(r.value_json) : undefined
    } finally {
      d.close()
    }
  } catch {
    return undefined
  }
}

/** Does this channel hold hooks? Settings row, else plist default, else yes (H-016). */
export const holdsNow = (channel: Channel, home: string = CHANNELS[channel].home): boolean =>
  (settingRow(home, "holds.enabled") ??
    plistDefault(plistPath(CHANNELS[channel].label), "holds.enabled") ??
    true) === true

export const status = async (say: Say): Promise<void> => {
  const hooked = hookedHomes()
  for (const c of channels) {
    const { home, label, title } = CHANNELS[c]
    const installed = existsSync(plistPath(label))
    const rec = readInstallRecord(home)
    say(`\n${title} (${c})`)
    if (!installed && !hooked.has(home) && !rec) {
      say("  not installed")
      continue
    }
    const lc = Bun.spawnSync(["/bin/launchctl", "print", `gui/${uid()}/${label}`]).stdout.toString()
    const pid = /\bpid = (\d+)/.exec(lc)?.[1]
    say(`  version  ${rec ? `${rec.version} (${rec.build}, from ${rec.source})` : "unknown"}`)
    say(
      `  launchd  ${installed ? (pid ? `running (pid ${pid})` : "loaded, not running") : "no agent"}`,
    )
    say(`  hooks    ${hooked.has(home) ? "in ~/.claude/settings.json" : "not installed"}`)
    say(`  holds    ${holdsNow(c) ? "yes" : "no (observer)"}`)
    const conn = connection(home)
    if (!conn) continue
    try {
      const h = (await (
        await fetch("http://localhost/v1/health", {
          unix: conn.socketPath,
          signal: AbortSignal.timeout(1000),
        })
      ).json()) as { version?: string; build?: string; shellConnected: boolean }
      const snap = (await (
        await fetch(`http://127.0.0.1:${conn.httpPort}/v1/snapshot`, {
          headers: { authorization: `Bearer ${conn.token}` },
          signal: AbortSignal.timeout(1000),
        })
      ).json()) as { sessions: unknown[]; counts: Record<string, number> }
      say(`  daemon   ${h.version ?? "?"} (${h.build ?? "?"})`)
      say(`  app      ${h.shellConnected ? "connected" : "not connected"}`)
      say(
        `  inbox    ${snap.sessions.length} sessions · ${snap.counts.needsYou ?? 0} need you · ${snap.counts.review ?? 0} to review`,
      )
      say(`  url      http://127.0.0.1:${conn.httpPort}/`)
    } catch (e) {
      say(`  daemon   unreachable (${(e as Error).message})`)
    }
  }
}

export const setHolds = (holder: Channel, say: Say): void => {
  for (const c of channels) {
    const db = paths(CHANNELS[c].home).db
    if (!existsSync(db)) continue
    const on = c === holder
    const d = new Database(db)
    d.exec("PRAGMA busy_timeout = 2000")
    d.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)").run(
      "holds.enabled",
      JSON.stringify(on),
    )
    d.close()
    say(`${c}: holds ${on ? "on" : "off"}; restart -> exit ${kickstart(CHANNELS[c].label)}`)
  }
}

export const openInbox = (channel: Channel): void => {
  const conn = connection(CHANNELS[channel].home)
  if (!conn) throw new Error(`${channel} is not running`)
  Bun.spawnSync(["/usr/bin/open", `http://127.0.0.1:${conn.httpPort}/`])
}
