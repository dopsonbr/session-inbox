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
} from "node:fs"
import { homedir } from "node:os"
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
import { atomicCopyFile, replaceDir, replaceUserFile } from "./fsx.ts"
import { daemonPath, loadAgent, renderPlist } from "./launchd.ts"
import { PAYLOAD_BINARIES, readPayload } from "./manifest.ts"
import { type InstallSource, mirrorEnv, writeInstallRecord } from "./state.ts"

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
  /** launchd label; null/undefined = the channel's default. A custom one skips PATH and app. */
  label?: string | null
  /** Release source ("install from a mirror"): recorded and written into the plist env. */
  releasesUrl?: string | null
  assetUrl?: string | null
  repo?: string | null
  /** Extra daemon environment for the plist (tests). */
  daemonEnv?: Record<string, string>
}

/** Drop the browser-download quarantine flag so a tarball fetched with Safari still runs. */
export const stripQuarantine = (path: string): void => {
  Bun.spawnSync(["/usr/bin/xattr", "-dr", "com.apple.quarantine", path], {
    stdout: "ignore",
    stderr: "ignore",
  })
}

/** `/Users/me/.local/bin` → `$HOME/.local/bin`, for a line pasted into ~/.zshrc. */
const dollarHome = (dir: string) =>
  dir.startsWith(`${homedir()}/`) ? `$HOME${dir.slice(homedir().length)}` : dir

/** The last lines of a release install: what happens next, in plain words. */
export const nextSteps = (o: {
  channel: Channel
  app: boolean
  /** How to run the CLI: the bare name only when it is on PATH, else its quoted full path. */
  cli: string
  /** The link's directory when it isn't on PATH: one line on adding it (text only). */
  addToPath?: string | null
}): string[] => [
  "",
  "Session Inbox is installed. What happens next:",
  ...(o.app
    ? [
        `  - ${CHANNELS[o.channel].title} is in the menu bar. macOS will ask to allow notifications: click Allow.`,
      ]
    : []),
  "  - Restart any Claude Code sessions that were already open, so they pick up the hooks.",
  `  - Check the setup any time with: ${o.cli} doctor`,
  `  - To remove it: ${o.cli} uninstall --yes   (add --purge to delete the data too)`,
  ...(o.addToPath
    ? [
        `  - To type just ${pathLinkName(o.channel)}, add ${o.addToPath} to your PATH (zsh): ` +
          `echo 'export PATH="${dollarHome(o.addToPath)}:$PATH"' >> ~/.zshrc   (then open a new terminal)`,
      ]
    : []),
]

/** Is `dir` one of the directories on $PATH (compared by realpath)? */
export const onPath = (dir: string, pathVar = process.env.PATH ?? ""): boolean =>
  pathVar.split(":").some((p) => {
    try {
      return p !== "" && realpathSync(p) === realpathSync(dir)
    } catch {
      return false
    }
  })

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

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** `pgrep`/`pkill -f` pattern: `<Title>.app` anywhere, or one exact bundle path (`/….app`). */
const appPattern = (app: string) =>
  `${escapeRegex(app.endsWith(".app") ? app : `${app}.app`)}/Contents/MacOS/`

/** Is `<Title>.app` (or the bundle at that exact path) running? */
export const appRunning = (app: string) =>
  Bun.spawnSync(["/usr/bin/pgrep", "-f", appPattern(app)], { stdout: "ignore" }).exitCode === 0

/**
 * Quit the menu-bar app: ask it, then end the process, because the app keeps running on a
 * plain quit request (it lives in the menu bar). `app` is a title or an exact bundle path;
 * call it only when `appRunning(app)`, since asking a stopped app to quit can launch it.
 */
export const quitApp = (app: string): void => {
  Bun.spawnSync(["/usr/bin/osascript", "-e", `quit app "${app}"`], { stderr: "ignore" })
  Bun.spawnSync(["/usr/bin/pkill", "-f", appPattern(app)], { stderr: "ignore" })
  Bun.sleepSync(500)
}

/** The login item tauri-plugin-autostart writes: `~/Library/LaunchAgents/<Title>.plist`. */
export const loginItemPath = (title: string) =>
  join(homedir(), "Library", "LaunchAgents", `${title}.plist`)

/**
 * Is this login-item plist the one for the app bundle at `bundle`? Only when its
 * ProgramArguments run something inside that bundle; anything unreadable is not ours.
 */
export const loginItemIsFor = (plistFile: string, bundle: string): boolean => {
  if (!existsSync(plistFile)) return false
  const p = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", plistFile], {
    stderr: "ignore",
  })
  if (p.exitCode !== 0) return false
  let args: unknown
  try {
    args = (JSON.parse(p.stdout.toString()) as { ProgramArguments?: unknown }).ProgramArguments
  } catch {
    return false
  }
  if (!Array.isArray(args) || typeof args[0] !== "string") return false
  const prefixes = new Set([`${bundle.replace(/\/+$/, "")}/`])
  try {
    prefixes.add(`${realpathSync(bundle)}/`)
  } catch {}
  return [...prefixes].some((pre) => (args as string[])[0]?.startsWith(pre))
}

export const install = async (o: InstallOptions, say: Say): Promise<void> => {
  const { title } = CHANNELS[o.channel]
  const label = o.label || CHANNELS[o.channel].label
  // A custom label is an isolated extra install: no PATH link, no app in ~/Applications.
  const customLabel = label !== CHANNELS[o.channel].label
  const mirror = {
    releasesUrl: o.releasesUrl || null,
    assetUrl: o.assetUrl || null,
    repo: o.repo || null,
  }
  const daemonEnv = { ...(o.daemonEnv ?? {}), ...mirrorEnv(mirror) }
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
  // Merged now, so a settings file we can't merge into stops the install before anything is copied.
  let settingsAfter: string | null = null
  if (o.hooks) {
    try {
      settingsAfter = serialize(mergeHooks(currentSettings, o.home, otherHomes(o.channel)))
    } catch (e) {
      throw new Error(`${o.settingsPath}: ${(e as Error).message}`)
    }
  }
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
    stripQuarantine(dest)
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
    stripQuarantine(uiDest)
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
      env: daemonEnv,
    })
    if (!apply) {
      say(`would write ${target}`)
      say(`would run: launchctl bootout gui/<uid>/${label}   (ignored if not loaded)`)
      say(`would run: launchctl bootstrap gui/<uid> ${target}`)
    } else await loadAgent(label, target, plist, say)
  }

  // 3. hooks
  if (o.hooks && settingsAfter !== null) {
    const after = settingsAfter
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
      replaceUserFile(o.settingsPath, after)
      say(`updated ${o.settingsPath}`)
    }
  }

  // 4. menu-bar app → ~/Applications (user-owned, stable path for the login item)
  const bundle = o.appBundle ?? join(o.payload, "app", `${title}.app`)
  let installedApp: string | null = null
  if (o.app && customLabel) say(`custom launchd label ${label}: not installing the menu-bar app`)
  else if (o.app) {
    const dest = appPath(title)
    if (!existsSync(bundle)) say(`no ${title}.app in this payload; skipping the menu-bar app`)
    else if (!apply) say(`would install ${dest} (quitting a running copy first)`)
    else {
      const wasRunning = appRunning(title)
      if (wasRunning) quitApp(title)
      replaceDir(bundle, dest)
      stripQuarantine(dest)
      installedApp = dest
      say(`installed ${dest}`)
      if (!o.updating || wasRunning) {
        const open = Bun.spawnSync(["/usr/bin/open", dest])
        say(`open ${dest} -> exit ${open.exitCode}`)
      }
    }
  }

  // 5. ~/.local/bin/session-inbox → <home>/bin/session-inbox, for the default home only
  const linkWanted = o.pathLink && !customLabel && o.home === CHANNELS[o.channel].home
  const link = linkWanted ? linkOnPath(o, apply, say) : null

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
      label: customLabel ? label : null,
      ...mirror,
      daemonEnv: o.daemonEnv ?? {},
    })
    say(`wrote ${join(o.home, "install.json")}`)
  }
  if (apply && o.source === "release" && !o.updating) {
    // A fresh Mac's zsh has no ~/.local/bin on PATH: never print a command the shell can't find.
    const linkDirOnPath = link !== null && onPath(dirname(link))
    const cli = linkDirOnPath
      ? pathLinkName(o.channel)
      : `"${link ?? join(o.home, "bin", "session-inbox")}"`
    const addToPath = link !== null && !linkDirOnPath ? dirname(link) : null
    for (const line of nextSteps({
      channel: o.channel,
      app: installedApp !== null,
      cli,
      addToPath,
    }))
      say(line)
  }
}

/** The link's path when it points at this home's CLI afterwards, else null. */
const linkOnPath = (o: InstallOptions, apply: boolean, say: Say): string | null => {
  const dir = localBin()
  const link = join(dir, pathLinkName(o.channel))
  const target = join(o.home, "bin", "session-inbox")
  let existing: string | null = null
  try {
    const st = lstatSync(link)
    if (!st.isSymbolicLink()) {
      say(`${link} exists and isn't our symlink; leaving it alone`)
      return null
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
      return null
    }
  }
  if (!onPath(dir))
    say(`note: ${dir} is not on your PATH, so ${pathLinkName(o.channel)} alone won't be found`)
  return link
}
