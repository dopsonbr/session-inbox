/**
 * Install Session Inbox: build, copy binaries, launchd agent, Claude hooks, menu-bar app.
 * DRY RUN by default — pass --yes to change anything.
 *   --channel ga|beta  which install (default ga). Beta lives beside GA with its own home,
 *                      launchd label, port and app (H-014); build it from your working checkout.
 *   --settings <path>  target Claude settings file (default ~/.claude/settings.json)
 *   --home <dir>       Session Inbox home (default per channel, under Application Support)
 *   --holds            hold hooks even if another channel's hooks are installed (H-016)
 *   --app              also build the menu-bar app and install it in ~/Applications (slow)
 *   --no-launchd       skip plist + launchctl
 *   --no-hooks         skip settings.json
 */
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import { hookHome, mergeHooks, serialize } from "../apps/hook/src/settings.ts"
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
  xmlEscape,
} from "./_common.ts"
import { build } from "./build.ts"

const { values } = parseArgs({
  options: {
    yes: { type: "boolean", default: false },
    channel: { type: "string" },
    settings: { type: "string" },
    home: { type: "string" },
    holds: { type: "boolean", default: false },
    app: { type: "boolean", default: false },
    "no-launchd": { type: "boolean", default: false },
    "no-hooks": { type: "boolean", default: false },
  },
})

const apply = values.yes === true
const channel = parseChannel(values.channel)
const { label, title } = CHANNELS[channel]
const home = values.home ?? CHANNELS[channel].home
const settingsPath = values.settings ?? defaultSettingsPath()
const root = join(import.meta.dir, "..")
const dist = join(root, "dist")
const say = (s: string) => console.log(s)

say(
  `${apply ? "INSTALL (applying changes)" : "DRY RUN (nothing will change; pass --yes to apply)"}: ${channel} → ${home}`,
)

const settingsBefore = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null
const currentSettings = parseSettings(settingsBefore, settingsPath)

// Another channel already hooked into the same settings file? Then only one may hold (H-016).
const others = otherHomes(channel)
const otherInstalled = Object.values(currentSettings.hooks ?? {}).some(
  (groups) =>
    Array.isArray(groups) &&
    groups.some((g) =>
      g?.hooks?.some((h) => {
        const hh = hookHome(h?.command)
        return hh !== null && others.includes(hh)
      }),
    ),
)
const observer = otherInstalled && !values.holds
// Observers still notify, so both apps can be compared (user's call, H-016).
const settingDefaults = observer ? { "holds.enabled": false } : {}
if (observer)
  say(
    "another channel's hooks are installed: this one observes (shows and notifies, never holds).\n" +
      "  switch which channel holds with: bun scripts/channels.ts holds <ga|beta>",
  )

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
  // Replace rather than overwrite: a running hook keeps its old inode.
  rmSync(dest, { force: true })
  copyFileSync(src, dest)
  chmodSync(dest, 0o755)
  say(`copied ${dest}`)
  if (b === "inbox-hook") {
    // First exec of a new binary pays a one-off macOS scan; pay it now, not on Claude's first hook.
    Bun.spawnSync([dest, "warmup"], { env: { SESSION_INBOX_INTERNAL: "1" }, stdin: "ignore" })
  }
}

// 1b. UI assets the daemon serves
const uiSrc = join(dist, "ui")
const uiDest = join(home, "ui")
if (!apply) say(`would copy ${uiSrc} -> ${uiDest}`)
else if (existsSync(uiSrc)) {
  rmSync(uiDest, { recursive: true, force: true })
  cpSync(uiSrc, uiDest, { recursive: true })
  say(`copied ${uiDest}`)
}

// 2. launchd
if (!values["no-launchd"]) {
  const template = readFileSync(
    join(root, "ops/launchd/com.sessioninbox.inboxd.plist.template"),
    "utf8",
  )
  // launchd's PATH is /usr/bin:/bin:/usr/sbin:/sbin; the daemon spawns `claude` (outbox, titles).
  const claudeDir = dirname(Bun.which("claude") ?? join(homedir(), ".local/bin/claude"))
  const path = [
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
  const plist = template
    .replaceAll("{{LABEL}}", label)
    .replaceAll("{{HOME}}", xmlEscape(home))
    .replaceAll("{{PATH}}", xmlEscape(path))
    .replaceAll("{{CHANNEL}}", channel)
    .replaceAll("{{SETTINGS}}", xmlEscape(JSON.stringify(settingDefaults)))
  const target = plistPath(label)
  const domain = `gui/${uid()}`
  if (!apply) {
    say(`would write ${target}`)
    say(`would run: launchctl bootout ${domain}/${label}   (ignored if not loaded)`)
    say(`would run: launchctl bootstrap ${domain} ${target}`)
    say(`would run: launchctl kickstart -k ${domain}/${label}`)
  } else {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, plist)
    say(`wrote ${target}`)
    Bun.spawnSync(["launchctl", "bootout", `${domain}/${label}`], { stderr: "ignore" })
    // bootout returns before the service is gone; bootstrap then fails with exit 5 (H-018).
    const loaded = () =>
      Bun.spawnSync(["launchctl", "print", `${domain}/${label}`], {
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode === 0
    for (let i = 0; i < 50 && loaded(); i++) await Bun.sleep(100)
    let code = -1
    for (let attempt = 0; attempt < 5 && code !== 0; attempt++) {
      if (attempt > 0) await Bun.sleep(500)
      code = Bun.spawnSync(["launchctl", "bootstrap", domain, target]).exitCode
    }
    say(`launchctl bootstrap ${domain} ${target} -> exit ${code}`)
    if (code !== 0) throw new Error("launchctl bootstrap failed; see `launchctl print` and the log")
  }
}

// 3. hooks
if (!values["no-hooks"]) {
  const after = serialize(mergeHooks(currentSettings, home, others))
  const diff = unifiedDiff(settingsBefore ?? "", after, settingsPath)
  if (diff === "") {
    say(`${settingsPath}: hooks already installed; no change`)
  } else if (!apply) {
    say(`${settingsPath} would change:\n${diff}`)
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true })
    if (settingsBefore !== null) {
      const bak = `${settingsPath}.bak-${timestamp()}`
      copyFileSync(settingsPath, bak)
      say(`backed up to ${bak}`)
    }
    writeFileSync(settingsPath, after)
    say(`updated ${settingsPath}`)
  }
}

// 4. menu-bar app → ~/Applications (user-owned, stable path for the login item)
if (values.app) {
  const dest = join(homedir(), "Applications", `${title}.app`)
  if (!apply) say(`would build the ${channel} menu-bar app and install ${dest}`)
  else {
    const b = Bun.spawnSync(["bun", join(root, "scripts/build-shell.ts"), "--channel", channel], {
      cwd: root,
      stdout: "pipe",
      stderr: "inherit",
    })
    const built = b.stdout.toString().trim().split("\n").at(-1) ?? ""
    if (b.exitCode !== 0 || !built.endsWith(".app") || !existsSync(built))
      throw new Error(`menu-bar app build failed (${built || `exit ${b.exitCode}`})`)
    Bun.spawnSync(["osascript", "-e", `quit app "${title}"`], { stderr: "ignore" })
    Bun.spawnSync(["pkill", "-f", `${title}.app/Contents/MacOS/`], { stderr: "ignore" })
    await Bun.sleep(500)
    mkdirSync(dirname(dest), { recursive: true })
    rmSync(dest, { recursive: true, force: true })
    cpSync(built, dest, { recursive: true, verbatimSymlinks: true })
    say(`installed ${dest}`)
    const o = Bun.spawnSync(["open", dest])
    say(`open ${dest} -> exit ${o.exitCode}`)
  }
}
