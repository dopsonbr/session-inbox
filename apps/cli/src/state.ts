/**
 * Files the CLI keeps in `<home>`:
 *   install.json       how this home was installed, so `update` re-applies the same choices (H-022)
 *   update-state.json  progress of the running/last update; the daemon reads it (H-023)
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type Channel, isChannel } from "@session-inbox/contracts/paths"
import { atomicWriteFile } from "./fsx.ts"

export type InstallSource = "release" | "source"

export type InstallRecord = {
  version: string
  build: string
  channel: Channel
  source: InstallSource
  /** The home as given at install time (hook commands use this spelling, not a realpath). */
  home: string
  settingsPath: string
  launchd: boolean
  hooks: boolean
  app: boolean
  appPath: string | null
  installedAt: string
  /** The launchd label when it isn't the channel's default (an isolated third install). */
  label: string | null
  /** Where releases come from when not GitHub ("install from a mirror"); null = default. */
  releasesUrl: string | null
  assetUrl: string | null
  repo: string | null
  /** Extra daemon environment written into the plist (tests: CLAUDE_CONFIG_DIR and friends). */
  daemonEnv: Record<string, string>
}

/** The release-source part of an install record, as environment variables. */
export const mirrorEnv = (rec: {
  releasesUrl: string | null
  assetUrl: string | null
  repo: string | null
}): Record<string, string> => ({
  ...(rec.releasesUrl ? { SESSION_INBOX_RELEASES_URL: rec.releasesUrl } : {}),
  ...(rec.assetUrl ? { SESSION_INBOX_ASSET_URL: rec.assetUrl } : {}),
  ...(rec.repo ? { SESSION_INBOX_REPO: rec.repo } : {}),
})

export const installJsonPath = (home: string) => join(home, "install.json")
export const updateStatePath = (home: string) => join(home, "update-state.json")
export const updateLogPath = (home: string) => join(home, "update.log")
export const updatesDir = (home: string) => join(home, "updates")

export const writeInstallRecord = (home: string, rec: InstallRecord): void =>
  atomicWriteFile(installJsonPath(home), `${JSON.stringify(rec, null, 2)}\n`)

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null)
const strings = (v: unknown): Record<string, string> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      )
    : {}

/** The record, or null when absent or unreadable (an older install.ts never wrote one). */
export const readInstallRecord = (home: string): InstallRecord | null => {
  const file = installJsonPath(home)
  if (!existsSync(file)) return null
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    if (typeof v.version !== "string" || !isChannel(v.channel)) return null
    return {
      version: v.version,
      build: typeof v.build === "string" ? v.build : "unknown",
      channel: v.channel,
      source: v.source === "release" ? "release" : "source",
      home: typeof v.home === "string" ? v.home : home,
      settingsPath: typeof v.settingsPath === "string" ? v.settingsPath : "",
      launchd: v.launchd !== false,
      hooks: v.hooks !== false,
      app: v.app === true,
      appPath: typeof v.appPath === "string" ? v.appPath : null,
      installedAt: typeof v.installedAt === "string" ? v.installedAt : "",
      label: str(v.label),
      releasesUrl: str(v.releasesUrl),
      assetUrl: str(v.assetUrl),
      repo: str(v.repo),
      daemonEnv: strings(v.daemonEnv),
    }
  } catch {
    return null
  }
}

export type UpdatePhase = "downloading" | "verifying" | "installing" | "done" | "failed"
export type UpdateState = { version: string; state: UpdatePhase; error: string | null; at: number }

export const writeUpdateState = (
  home: string,
  version: string,
  state: UpdatePhase,
  error: string | null = null,
  now: () => number = Date.now,
): UpdateState => {
  const s: UpdateState = { version, state, error, at: now() }
  atomicWriteFile(updateStatePath(home), `${JSON.stringify(s)}\n`)
  return s
}

export const readUpdateState = (home: string): UpdateState | null => {
  try {
    return JSON.parse(readFileSync(updateStatePath(home), "utf8")) as UpdateState
  } catch {
    return null
  }
}
