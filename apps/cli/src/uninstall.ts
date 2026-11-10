/**
 * Reverse install: hooks, launchd agent, PATH link, optionally the app; with `purge`
 * also the home dir (binaries, database, logs). DRY RUN unless `apply`.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { CHANNELS, type Channel } from "@session-inbox/contracts/paths"
import { serialize, unmergeHooks } from "../../hook/src/settings.ts"
import {
  appPath,
  localBin,
  otherHomes,
  parseSettings,
  pathLinkName,
  plistPath,
  type Say,
  timestamp,
  unifiedDiff,
} from "./common.ts"
import { unloadAgent } from "./launchd.ts"
import { installJsonPath, readInstallRecord } from "./state.ts"

export type UninstallOptions = {
  apply: boolean
  channel: Channel
  home: string
  /** Defaults to the one recorded in install.json, else ~/.claude/settings.json. */
  settingsPath: string
  launchd: boolean
  hooks: boolean
  /** Remove the menu-bar app (also done when install.json says it was installed). */
  app: boolean
  purge: boolean
  /** launchd label; default: install.json's, else the channel's. */
  label?: string | null
}

export const uninstall = (o: UninstallOptions, say: Say): void => {
  const { title } = CHANNELS[o.channel]
  const apply = o.apply
  const rec = readInstallRecord(o.home)
  const label = o.label || rec?.label || CHANNELS[o.channel].label
  const customLabel = label !== CHANNELS[o.channel].label
  say(apply ? "UNINSTALL (applying changes)" : "DRY RUN (nothing will change; pass --yes to apply)")
  // Keep the other channels' hooks, unless --home points this run at one of them.
  const keep = otherHomes(o.channel).filter((h) => h !== o.home)

  if (o.launchd) {
    const target = plistPath(label)
    if (!apply) {
      say(`would run: launchctl bootout gui/<uid>/${label}`)
      say(`would remove ${target}`)
    } else unloadAgent(label, target, say)
  }

  if (o.hooks) {
    if (!existsSync(o.settingsPath)) say(`${o.settingsPath} does not exist; nothing to do`)
    else {
      const before = readFileSync(o.settingsPath, "utf8")
      const after = serialize(unmergeHooks(parseSettings(before, o.settingsPath), keep))
      const diff = unifiedDiff(before, after, o.settingsPath)
      if (diff === "") say(`${o.settingsPath}: no Session Inbox hooks found`)
      else if (!apply) say(`${o.settingsPath} would change:\n${diff}`)
      else {
        const bak = `${o.settingsPath}.bak-${timestamp()}`
        copyFileSync(o.settingsPath, bak)
        writeFileSync(o.settingsPath, after)
        say(`backed up to ${bak}; updated ${o.settingsPath}`)
      }
    }
  }

  // The PATH link, only if it points into this home (a custom-label install never made one).
  const link = join(localBin(), pathLinkName(o.channel))
  try {
    if (
      !customLabel &&
      lstatSync(link).isSymbolicLink() &&
      readlinkSync(link).startsWith(`${o.home}/`)
    ) {
      if (!apply) say(`would remove ${link}`)
      else {
        rmSync(link, { force: true })
        say(`removed ${link}`)
      }
    }
  } catch {}

  if (!customLabel && (o.app || rec?.app)) {
    const app = rec?.appPath ?? appPath(title)
    if (!apply) say(`would quit and remove ${app}`)
    else {
      Bun.spawnSync(["/usr/bin/osascript", "-e", `quit app "${title}"`], { stderr: "ignore" })
      rmSync(app, { recursive: true, force: true })
      say(`removed ${app}`)
    }
  }

  if (o.purge) {
    // Only delete a dir that is recognisably a Session Inbox home.
    const ours = ["install.json", "inbox.db", "bin/inbox-hook", "bin/inboxd"].some((f) =>
      existsSync(join(o.home, f)),
    )
    if (!existsSync(o.home)) say(`${o.home} does not exist`)
    else if (!ours) say(`${o.home} doesn't look like a Session Inbox home; not deleting it`)
    else if (!apply) say(`would delete ${o.home} (binaries, database, logs)`)
    else {
      rmSync(o.home, { recursive: true, force: true })
      say(`deleted ${o.home}`)
    }
  } else if (existsSync(installJsonPath(o.home))) {
    if (!apply)
      say(`would remove ${installJsonPath(o.home)} (binaries and data stay; --purge deletes them)`)
    else rmSync(installJsonPath(o.home), { force: true })
  }
}
