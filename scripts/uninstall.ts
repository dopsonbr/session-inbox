/**
 * Reverse install.ts: remove our hooks and the launchd agent. Binaries and data
 * in <home> are left alone. DRY RUN by default — pass --yes to apply.
 *   --settings <path>  --home <dir>  --no-launchd  --no-hooks
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { serialize, unmergeHooks } from "../apps/hook/src/settings.ts"
import {
  defaultSettingsPath,
  LABEL,
  parseSettings,
  plistPath,
  timestamp,
  uid,
  unifiedDiff,
} from "./_common.ts"

const { values } = parseArgs({
  options: {
    yes: { type: "boolean", default: false },
    settings: { type: "string" },
    home: { type: "string" },
    "no-launchd": { type: "boolean", default: false },
    "no-hooks": { type: "boolean", default: false },
  },
})
const apply = values.yes === true
const settingsPath = values.settings ?? defaultSettingsPath()
const say = (s: string) => console.log(s)
say(apply ? "UNINSTALL (applying changes)" : "DRY RUN (nothing will change; pass --yes to apply)")

if (!values["no-launchd"]) {
  const domain = `gui/${uid()}`
  const target = plistPath()
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
    const after = serialize(unmergeHooks(parseSettings(before, settingsPath)))
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
