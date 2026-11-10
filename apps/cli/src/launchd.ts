/// <reference path="../../../packages/contracts/src/text-modules.d.ts" />
/** The daemon's launchd agent (H-009, H-013, H-018). The template is compiled in. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Channel } from "@session-inbox/contracts/paths"
import template from "../../../ops/launchd/com.sessioninbox.inboxd.plist.template" with {
  type: "text",
}
import { type Say, uid, xmlEscape } from "./common.ts"

/** launchd's PATH is /usr/bin:/bin:/usr/sbin:/sbin; the daemon spawns `claude` (outbox, titles). */
export const daemonPath = (): string => {
  const claudeDir = dirname(Bun.which("claude") ?? join(homedir(), ".local/bin/claude"))
  return [
    ...new Set([
      claudeDir,
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]),
  ].join(":")
}

export const renderPlist = (o: {
  label: string
  home: string
  path: string
  channel: Channel
  settingDefaults: Record<string, unknown>
}): string =>
  template
    .replaceAll("{{LABEL}}", o.label)
    .replaceAll("{{HOME}}", xmlEscape(o.home))
    .replaceAll("{{PATH}}", xmlEscape(o.path))
    .replaceAll("{{CHANNEL}}", o.channel)
    .replaceAll("{{SETTINGS}}", xmlEscape(JSON.stringify(o.settingDefaults)))

/** A setting default baked into an installed plist's SESSION_INBOX_SETTINGS, if any. */
export const plistDefault = (plistFile: string, key: string): unknown => {
  try {
    const xml = readFileSync(plistFile, "utf8")
    const m = /<key>SESSION_INBOX_SETTINGS<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)
    const json = (m?.[1] ?? "{}").replaceAll("&quot;", '"').replaceAll("&amp;", "&")
    return (JSON.parse(json) as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

const launchctl = (...args: string[]) =>
  Bun.spawnSync(["/bin/launchctl", ...args], { stdout: "ignore", stderr: "ignore" }).exitCode

export const isLoaded = (label: string) => launchctl("print", `gui/${uid()}/${label}`) === 0

/**
 * Write the plist and (re)load the agent. bootout returns before the service is gone and
 * an immediate bootstrap fails with exit 5, so wait and retry (H-018). RunAtLoad starts it.
 */
export const loadAgent = async (label: string, target: string, plist: string, say: Say) => {
  const domain = `gui/${uid()}`
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, plist)
  say(`wrote ${target}`)
  launchctl("bootout", `${domain}/${label}`)
  for (let i = 0; i < 50 && isLoaded(label); i++) await Bun.sleep(100)
  let code = -1
  for (let attempt = 0; attempt < 5 && code !== 0; attempt++) {
    if (attempt > 0) await Bun.sleep(500)
    code = Bun.spawnSync(["/bin/launchctl", "bootstrap", domain, target]).exitCode
  }
  say(`launchctl bootstrap ${domain} ${target} -> exit ${code}`)
  if (code !== 0) throw new Error("launchctl bootstrap failed; see `launchctl print` and the log")
}

export const unloadAgent = (label: string, target: string, say: Say) => {
  launchctl("bootout", `gui/${uid()}/${label}`)
  const had = existsSync(target)
  rmSync(target, { force: true })
  say(`unloaded agent${had ? ` and removed ${target}` : ""}`)
}

export const kickstart = (label: string) => launchctl("kickstart", "-k", `gui/${uid()}/${label}`)
