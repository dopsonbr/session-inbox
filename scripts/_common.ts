import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Settings } from "../apps/hook/src/settings.ts"

export const LABEL = "com.sessioninbox.inboxd"

export const defaultSettingsPath = () => join(process.env.HOME ?? "", ".claude", "settings.json")
export const plistPath = () =>
  join(process.env.HOME ?? "", "Library", "LaunchAgents", `${LABEL}.plist`)
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
      "diff",
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
