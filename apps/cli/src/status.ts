/**
 * GA and beta side by side (H-014, H-016, H-017): status, which channel holds, open.
 * `holds` writes `holds.enabled` rows (they beat the plist defaults) and restarts both
 * daemons so they re-read settings.
 */
import { Database } from "bun:sqlite"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { CHANNELS, type Channel, paths } from "@session-inbox/contracts/paths"
import { hookHome } from "../../hook/src/settings.ts"
import { defaultSettingsPath, parseSettings, plistPath, type Say } from "./common.ts"
import { jobState, kickstart, plistDefault } from "./launchd.ts"
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
export const holdsNow = (
  channel: Channel,
  home: string = CHANNELS[channel].home,
  label: string | null = null,
): boolean =>
  (settingRow(home, "holds.enabled") ??
    plistDefault(plistPath(label || CHANNELS[channel].label), "holds.enabled") ??
    true) === true

/** One install to describe: a channel's default, or `--home`/`--label` for a custom one. */
export type StatusTarget = {
  channel: Channel
  home: string
  label: string
  settingsPath: string
}

export const defaultTargets = (): StatusTarget[] =>
  channels.map((c) => {
    const rec = readInstallRecord(CHANNELS[c].home)
    return {
      channel: c,
      home: CHANNELS[c].home,
      label: rec?.label || CHANNELS[c].label,
      settingsPath: rec?.settingsPath || defaultSettingsPath(),
    }
  })

export const STATUS_FOOTER = "\nSomething off? `session-inbox doctor` checks the whole setup."

export const status = async (
  say: Say,
  targets: StatusTarget[] = defaultTargets(),
): Promise<void> => {
  for (const t of targets) await describeInstall(t, say)
  say(STATUS_FOOTER)
}

const describeInstall = async (t: StatusTarget, say: Say): Promise<void> => {
  const { home, label, channel: c } = t
  const { title } = CHANNELS[c]
  const hooked = hookedHomes(t.settingsPath)
  const installed = existsSync(plistPath(label))
  const rec = readInstallRecord(home)
  say(`\n${title} (${c}${label !== CHANNELS[c].label ? `, ${label}` : ""})`)
  if (!installed && !hooked.has(home) && !rec) {
    say("  not installed")
    return
  }
  const { pid } = jobState(label)
  say(`  version  ${rec ? `${rec.version} (${rec.build}, from ${rec.source})` : "unknown"}`)
  say(
    `  launchd  ${installed ? (pid ? `running (pid ${pid})` : "loaded, not running") : "no agent"}`,
  )
  say(`  hooks    ${hooked.has(home) ? `in ${tildify(t.settingsPath)}` : "not installed"}`)
  say(`  holds    ${holdsNow(c, home, label) ? "yes" : "no (observer)"}`)
  if (rec?.releasesUrl || rec?.assetUrl || rec?.repo)
    say(`  updates  from ${rec.releasesUrl ?? rec.assetUrl ?? rec.repo}`)
  const conn = connection(home)
  if (!conn) return
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
    // The page only loads for a request that carries the token (D-095); don't print the token.
    say(
      `  url      http://127.0.0.1:${conn.httpPort}/  (open it with: session-inbox open${c === "beta" ? " beta" : ""})`,
    )
  } catch (e) {
    say(`  daemon   unreachable (${(e as Error).message})`)
  }
}

const tildify = (p: string) => (p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p)

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

/** The inbox page for a browser: the token rides along as `k`, or the daemon serves a notice (D-095). */
export const inboxUrl = (conn: { httpPort: number; token: string }): string =>
  `http://127.0.0.1:${conn.httpPort}/?k=${encodeURIComponent(conn.token)}`

export const openInbox = (channel: Channel): void => {
  const conn = connection(CHANNELS[channel].home)
  if (!conn) throw new Error(`${channel} is not running`)
  Bun.spawnSync(["/usr/bin/open", inboxUrl(conn)])
}
