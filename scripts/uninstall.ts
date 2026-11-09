/**
 * Reverse install.ts: remove our hooks and the launchd agent. Binaries and data
 * in <home> are left alone. DRY RUN by default — pass --yes to apply.
 *   --channel ga|beta (default ga; the other channel's hooks are kept)
 *   --settings <path>  --home <dir>  --no-launchd  --no-hooks  --app (also remove ~/Applications/<app>)
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { serialize, unmergeHooks } from "../apps/hook/src/settings.ts"
import { CHANNELS } from "../packages/contracts/src/paths.ts"
import {
  defaultSettingsPath,
  otherHomes,
  parseChannel,
  parseSettings,
  plistPath,
  timestamp,
  uid,
  unifiedDiff,
} from "./_common.ts"

const { values } = parseArgs({
  options: {
    yes: { type: "boolean", default: false },
    channel: { type: "string" },
    app: { type: "boolean", default: false },
    settings: { type: "string" },
    home: { type: "string" },
    "no-launchd": { type: "boolean", default: false },
    "no-hooks": { type: "boolean", default: false },
  },
})
const apply = values.yes === true
const settingsPath = values.settings ?? defaultSettingsPath()
const channel = parseChannel(values.channel)
const { label: LABEL, title } = CHANNELS[channel]
// Keep the other channels' hooks, unless --home points this run at one of them.
const keep = otherHomes(channel).filter((h) => h !== values.home)
const say = (s: string) => console.log(s)
say(apply ? "UNINSTALL (applying changes)" : "DRY RUN (nothing will change; pass --yes to apply)")

if (!values["no-launchd"]) {
  const domain = `gui/${uid()}`
  const target = plistPath(LABEL)
  if (!apply) {
    say(`would run: launchctl bootout ${domain}/${LABEL}`)
    say(`would remove ${target}`)
  } else {
    Bun.spawnSync(["launchctl", "bootout", `${domain}/${LABEL}`], { stderr: "ignore" })
    rmSync(target, { force: true })
    say(`unloaded agent and removed ${target}`)
  }
}

if (!values["no-hooks"]) {
  if (!existsSync(settingsPath)) {
    say(`${settingsPath} does not exist; nothing to do`)
  } else {
    const before = readFileSync(settingsPath, "utf8")
    const after = serialize(unmergeHooks(parseSettings(before, settingsPath), keep))
    const diff = unifiedDiff(before, after, settingsPath)
    if (diff === "") say(`${settingsPath}: no Session Inbox hooks found`)
    else if (!apply) say(`${settingsPath} would change:\n${diff}`)
    else {
      const bak = `${settingsPath}.bak-${timestamp()}`
      copyFileSync(settingsPath, bak)
      writeFileSync(settingsPath, after)
      say(`backed up to ${bak}; updated ${settingsPath}`)
    }
  }
}

if (values.app) {
  const app = join(homedir(), "Applications", `${title}.app`)
  if (!apply) say(`would quit and remove ${app}`)
  else {
    Bun.spawnSync(["osascript", "-e", `quit app "${title}"`], { stderr: "ignore" })
    rmSync(app, { recursive: true, force: true })
    say(`removed ${app}`)
  }
}
