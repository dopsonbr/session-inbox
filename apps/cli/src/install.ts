/**
 * Install a payload into a Session Inbox home (H-019..H-022). The one install path:
 * `session-inbox install` (release tarball) and `scripts/install.ts` (source build) both
 * end here. DRY RUN unless `apply`.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { CHANNELS, type Channel } from "@session-inbox/contracts/paths"
import { hookHome, mergeHooks, serialize } from "../../hook/src/settings.ts"
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
import { atomicCopyFile, replaceDir } from "./fsx.ts"
import { daemonPath, loadAgent, renderPlist } from "./launchd.ts"
import { PAYLOAD_BINARIES, readPayload } from "./manifest.ts"
import { type InstallSource, writeInstallRecord } from "./state.ts"

export type InstallOptions = {
  payload: string
  apply: boolean
  channel: Channel
  home: string
  settingsPath: string
  /** Hold hooks even if another channel's hooks are installed (H-016). */
  holds: boolean
  launchd: boolean
  hooks: boolean
  /** Install the menu-bar app (the payload's `app/<title>.app`, or `appBundle`). */
  app: boolean
  /** A built .app to install instead of the payload's (source installs). */
  appBundle?: string | null
  /** Link ~/.local/bin/session-inbox[-beta]; only ever done for the channel's default home. */
  pathLink: boolean
  source: InstallSource
  /** During an update: reopen the app only if it was running (H-024). */
  updating: boolean
}

/** Does the settings file hold another channel's hooks? Then this one only observes (H-016). */
export const otherChannelHooked = (settingsText: string | null, path: string, channel: Channel) => {
  const settings = parseSettings(settingsText, path)
  const others = otherHomes(channel)
  return Object.values(settings.hooks ?? {}).some(
    (groups) =>
      Array.isArray(groups) &&
      groups.some((g) =>
        g?.hooks?.some((h) => {
          const hh = hookHome(h?.command)
          return hh !== null && others.includes(hh)
        }),
      ),
  )
}

const appRunning = (title: string) =>
  Bun.spawnSync(["/usr/bin/pgrep", "-f", `${title}.app/Contents/MacOS/`], { stdout: "ignore" })
    .exitCode === 0

export const install = async (o: InstallOptions, say: Say): Promise<void> => {
  const { label, title } = CHANNELS[o.channel]
  const apply = o.apply
  // A dry run may describe a payload that isn't built yet (scripts/install.ts builds on --yes).
  const built = apply || existsSync(join(o.payload, "manifest.json"))
  const manifest = built ? readPayload(o.payload) : null
  const what = manifest ? `${manifest.version} (${manifest.build})` : "unbuilt payload"
  say(
    `${apply ? "INSTALL (applying changes)" : "DRY RUN (nothing will change; pass --yes to apply)"}: ` +
      `${what}, ${o.channel} → ${o.home}`,
  )

  const settingsBefore = existsSync(o.settingsPath) ? readFileSync(o.settingsPath, "utf8") : null
  const currentSettings = parseSettings(settingsBefore, o.settingsPath)
  const observer = otherChannelHooked(settingsBefore, o.settingsPath, o.channel) && !o.holds
  // Observers still notify, so both apps can be compared (user's call, H-016).
  const settingDefaults = observer ? { "holds.enabled": false } : {}
  if (observer)
    say(
      "another channel's hooks are installed: this one observes (shows and notifies, never holds).\n" +
        "  switch which channel holds with: session-inbox holds <ga|beta>",
    )

  // 1. binaries: copy beside, rename over (H-021). A running hook keeps its old inode.
  const bin = join(o.home, "bin")
  for (const b of PAYLOAD_BINARIES) {
    const src = join(o.payload, "bin", b)
    const dest = join(bin, b)
    if (!apply) {
      say(`would copy ${src} -> ${dest}`)
      continue
    }
    atomicCopyFile(src, dest)
    say(`copied ${dest}`)
    if (b === "inbox-hook") {
      // First exec of a new binary pays a one-off macOS scan; pay it now (H-005).
      Bun.spawnSync([dest, "warmup"], { env: { SESSION_INBOX_INTERNAL: "1" }, stdin: "ignore" })
    }
  }

  // 1b. UI assets the daemon serves (H-012)
  const uiDest = join(o.home, "ui")
  if (!apply) say(`would copy ${join(o.payload, "ui")} -> ${uiDest}`)
  else {
    replaceDir(join(o.payload, "ui"), uiDest)
    say(`copied ${uiDest}`)
  }

  // 2. launchd
  const target = plistPath(label)
  if (o.launchd) {
    const plist = renderPlist({
      label,
      home: o.home,
      path: daemonPath(),
      channel: o.channel,
      settingDefaults,
    })
    if (!apply) {
      say(`would write ${target}`)
      say(`would run: launchctl bootout gui/<uid>/${label}   (ignored if not loaded)`)
      say(`would run: launchctl bootstrap gui/<uid> ${target}`)
    } else await loadAgent(label, target, plist, say)
  }

  // 3. hooks
  if (o.hooks) {
    const after = serialize(mergeHooks(currentSettings, o.home, otherHomes(o.channel)))
    const diff = unifiedDiff(settingsBefore ?? "", after, o.settingsPath)
    if (diff === "") say(`${o.settingsPath}: hooks already installed; no change`)
    else if (!apply) say(`${o.settingsPath} would change:\n${diff}`)
    else {
      mkdirSync(dirname(o.settingsPath), { recursive: true })
      if (settingsBefore !== null) {
        const bak = `${o.settingsPath}.bak-${timestamp()}`
        copyFileSync(o.settingsPath, bak)
        say(`backed up to ${bak}`)
      }
      writeFileSync(o.settingsPath, after)
      say(`updated ${o.settingsPath}`)
    }
  }

  // 4. menu-bar app → ~/Applications (user-owned, stable path for the login item)
  const bundle = o.appBundle ?? join(o.payload, "app", `${title}.app`)
  let installedApp: string | null = null
  if (o.app) {
    const dest = appPath(title)
    if (!existsSync(bundle)) say(`no ${title}.app in this payload; skipping the menu-bar app`)
    else if (!apply) say(`would install ${dest} (quitting a running copy first)`)
    else {
      const wasRunning = appRunning(title)
      if (wasRunning) {
        Bun.spawnSync(["/usr/bin/osascript", "-e", `quit app "${title}"`], { stderr: "ignore" })
        Bun.spawnSync(["/usr/bin/pkill", "-f", `${title}.app/Contents/MacOS/`], {
          stderr: "ignore",
        })
        await Bun.sleep(500)
      }
      replaceDir(bundle, dest)
      installedApp = dest
      say(`installed ${dest}`)
      if (!o.updating || wasRunning) {
        const open = Bun.spawnSync(["/usr/bin/open", dest])
        say(`open ${dest} -> exit ${open.exitCode}`)
      }
    }
  }

  // 5. ~/.local/bin/session-inbox → <home>/bin/session-inbox, for the default home only
  if (o.pathLink && o.home === CHANNELS[o.channel].home) linkOnPath(o, apply, say)

  // 6. what was installed, so `update` can redo it the same way
  if (!apply || !manifest) say(`would write ${join(o.home, "install.json")}`)
  else {
    writeInstallRecord(o.home, {
      version: manifest.version,
      build: manifest.build,
      channel: o.channel,
      source: o.source,
      home: o.home,
      settingsPath: o.settingsPath,
      launchd: o.launchd,
      hooks: o.hooks,
      app: installedApp !== null,
      appPath: installedApp,
      installedAt: new Date().toISOString(),
    })
    say(`wrote ${join(o.home, "install.json")}`)
  }
}

const linkOnPath = (o: InstallOptions, apply: boolean, say: Say) => {
  const dir = localBin()
  const link = join(dir, pathLinkName(o.channel))
  const target = join(o.home, "bin", "session-inbox")
  let existing: string | null = null
  try {
    const st = lstatSync(link)
    if (!st.isSymbolicLink()) {
      say(`${link} exists and isn't our symlink; leaving it alone`)
      return
    }
    existing = readlinkSync(link)
  } catch {}
  if (existing === target) say(`${link} already links to ${target}`)
  else if (!apply) say(`would link ${link} -> ${target}`)
  else {
    try {
      mkdirSync(dir, { recursive: true })
      if (existing !== null) rmSync(link, { force: true })
      symlinkSync(target, link)
      say(`linked ${link} -> ${target}`)
    } catch (e) {
      say(`could not link ${link} (${(e as Error).message}); run ${target} directly`)
      return
    }
  }
  const onPath = (process.env.PATH ?? "").split(":").some((p) => {
    try {
      return p !== "" && realpathSync(p) === realpathSync(dir)
    } catch {
      return false
    }
  })
  if (!onPath)
    say(
      `note: ${dir} is not on your PATH; add it (e.g. in ~/.zshrc) to run ${pathLinkName(o.channel)}`,
    )
}
