/**
 * Install Session Inbox: build, copy binaries, launchd agent, Claude hooks.
 * DRY RUN by default — pass --yes to change anything.
 *   --settings <path>  target Claude settings file (default ~/.claude/settings.json)
 *   --home <dir>       Session Inbox home (default ~/Library/Application Support/SessionInbox)
 *   --no-launchd       skip plist + launchctl
 *   --no-hooks         skip settings.json
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import { mergeHooks, serialize } from "../apps/hook/src/settings.ts"
import { DEFAULT_HOME } from "../packages/contracts/src/paths.ts"
import {
  defaultSettingsPath,
  LABEL,
  parseSettings,
  plistPath,
  timestamp,
  uid,
  unifiedDiff,
} from "./_common.ts"
import { build } from "./build.ts"

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
const home = values.home ?? DEFAULT_HOME
const settingsPath = values.settings ?? defaultSettingsPath()
const root = join(import.meta.dir, "..")
const dist = join(root, "dist")
const say = (s: string) => console.log(s)

say(apply ? "INSTALL (applying changes)" : "DRY RUN (nothing will change; pass --yes to apply)")

// 1. build + copy
const binaries = ["inbox-hook", "inboxd"]
if (apply) {
  await build()
  mkdirSync(join(home, "bin"), { recursive: true })
}
for (const b of binaries) {
  const src = join(dist, b)
  const dest = join(home, "bin", b)
  if (!apply) {
    say(`would build + copy ${src} -> ${dest}${existsSync(src) ? "" : " (not built yet)"}`)
    continue
  }
  if (!existsSync(src)) {
    say(`skip ${b}: not built`)
    continue
  }
  copyFileSync(src, dest)
  chmodSync(dest, 0o755)
  say(`copied ${dest}`)
  if (b === "inbox-hook") {
    // First exec of a new binary pays a one-off macOS scan; pay it now, not on Claude's first hook.
    Bun.spawnSync([dest, "warmup"], { env: { SESSION_INBOX_INTERNAL: "1" }, stdin: "ignore" })
  }
}

// 2. launchd
if (!values["no-launchd"]) {
  const template = readFileSync(
    join(root, "ops/launchd/com.sessioninbox.inboxd.plist.template"),
    "utf8",
  )
  const plist = template.replaceAll("{{HOME}}", home)
  const target = plistPath()
  const domain = `gui/${uid()}`
  if (!apply) {
    say(`would write ${target}`)
    say(`would run: launchctl bootout ${domain}/${LABEL}   (ignored if not loaded)`)
    say(`would run: launchctl bootstrap ${domain} ${target}`)
    say(`would run: launchctl kickstart -k ${domain}/${LABEL}`)
  } else {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, plist)
    say(`wrote ${target}`)
    Bun.spawnSync(["launchctl", "bootout", `${domain}/${LABEL}`], { stderr: "ignore" })
    for (const args of [
      ["bootstrap", domain, target],
      ["kickstart", "-k", `${domain}/${LABEL}`],
    ]) {
      const p = Bun.spawnSync(["launchctl", ...args])
      say(`launchctl ${args.join(" ")} -> exit ${p.exitCode}`)
    }
  }
}

// 3. hooks
if (!values["no-hooks"]) {
  const before = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null
  const current = parseSettings(before, settingsPath)
  const after = serialize(mergeHooks(current, home))
  const diff = unifiedDiff(before ?? "", after, settingsPath)
  if (diff === "") {
    say(`${settingsPath}: hooks already installed; no change`)
  } else if (!apply) {
    say(`${settingsPath} would change:\n${diff}`)
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true })
    if (before !== null) {
      const bak = `${settingsPath}.bak-${timestamp()}`
      copyFileSync(settingsPath, bak)
      say(`backed up to ${bak}`)
    }
    writeFileSync(settingsPath, after)
    say(`updated ${settingsPath}`)
  }
}
