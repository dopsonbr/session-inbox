/** Small helpers shared by install, uninstall, status and update. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { CHANNELS, type Channel, isChannel } from "@session-inbox/contracts/paths"
import type { Settings } from "../../hook/src/settings.ts"

/** Everything derived from the user's home goes through `homedir()`, which honours $HOME. */
export const defaultSettingsPath = () => join(homedir(), ".claude", "settings.json")
export const plistPath = (label: string) =>
  join(homedir(), "Library", "LaunchAgents", `${label}.plist`)
export const appPath = (title: string) => join(homedir(), "Applications", `${title}.app`)
export const localBin = () => join(homedir(), ".local", "bin")
/** The PATH symlink name for a channel: `session-inbox` (GA) or `session-inbox-beta`. */
export const pathLinkName = (channel: Channel) =>
  channel === "ga" ? "session-inbox" : `session-inbox-${channel}`

export const parseChannel = (v: string | undefined): Channel => {
  const c = v ?? "ga"
  if (!isChannel(c)) throw new UsageError(`--channel must be ga or beta, not ${c}`)
  return c
}
/** The other channels' default homes: their hooks are left alone (H-014). */
export const otherHomes = (channel: Channel): string[] =>
  (Object.keys(CHANNELS) as Channel[]).filter((c) => c !== channel).map((c) => CHANNELS[c].home)

export const xmlEscape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
export const uid = () => process.getuid?.() ?? 501

export const parseSettings = (text: string | null, path: string): Settings => {
  if (text === null || text.trim() === "") return {}
  try {
    const v = JSON.parse(text)
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object")
    return v as Settings
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${(e as Error).message}); refusing to touch it`)
  }
}

/** Unified diff of two strings via the system `diff`. Empty string when equal. */
export const unifiedDiff = (a: string, b: string, label: string): string => {
  if (a === b) return ""
  const dir = mkdtempSync(join(tmpdir(), "sih-diff-"))
  try {
    writeFileSync(join(dir, "a"), a)
    writeFileSync(join(dir, "b"), b)
    const p = Bun.spawnSync([
      "/usr/bin/diff",
      "-u",
      "-L",
      `${label} (current)`,
      "-L",
      `${label} (new)`,
      join(dir, "a"),
      join(dir, "b"),
    ])
    return p.stdout.toString()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-")

/** A bad command line: main prints the message and exits 2. */
export class UsageError extends Error {}

export type Say = (line: string) => void
