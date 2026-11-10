/**
 * session-inbox — install, update and inspect Session Inbox (H-019).
 *   session-inbox install [--from <payload>] [--yes] [--channel ga|beta] [--home <dir>]
 *                         [--settings <path>] [--holds] [--no-app] [--no-launchd] [--no-hooks]
 *                         [--no-path]
 *   session-inbox uninstall [--yes] [--channel] [--home] [--settings] [--app] [--purge]
 *                           [--no-launchd] [--no-hooks]
 *   session-inbox update [--check] [--json] [--yes] [--to <version>] [--channel ga|beta]
 *   session-inbox status | holds <ga|beta> | open [ga|beta] | --version
 * Everything that changes the machine is a dry run unless --yes.
 */
import { spawn } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { basename, dirname } from "node:path"
import { type ParseArgsOptionsConfig, parseArgs } from "node:util"
import { CHANNELS, type Channel, isChannel } from "@session-inbox/contracts/paths"
import { BUILD, VERSION } from "@session-inbox/contracts/version"
import { defaultSettingsPath, parseChannel, type Say, UsageError } from "./common.ts"
import { install } from "./install.ts"
import { payloadOfExecutable } from "./manifest.ts"
import { installJsonPath, readInstallRecord } from "./state.ts"
import { openInbox, setHolds, status } from "./status.ts"
import { uninstall } from "./uninstall.ts"
import { apply, check, describeCheck } from "./update.ts"

const USAGE = `usage: session-inbox <command>
  install    install this release (dry run unless --yes)
  uninstall  remove hooks, launchd agent and PATH link (--purge: also the data)
  update     check for (--check) or install (--yes) a newer release
  status     both channels: version, daemon, hooks, holds
  holds <ga|beta>   make that channel hold; the other observes
  open [ga|beta]    open the inbox in the browser
  --version`

/** Best effort: the daemon that started an update may be gone, and its pipe with it. */
const say: Say = (line) => {
  try {
    process.stdout.write(`${line}\n`)
  } catch {}
}

const self = (): string => {
  try {
    return realpathSync(process.execPath)
  } catch {
    return process.execPath
  }
}
const compiled = () => Bun.main.startsWith("/$bunfs/")

/** `<home>/bin/session-inbox` → `<home>`, when that home has an install.json. */
const homeOfSelf = (): string | null => {
  if (!compiled()) return null
  const exe = self()
  if (basename(exe) !== "session-inbox" || basename(dirname(exe)) !== "bin") return null
  const found = dirname(dirname(exe))
  if (!existsSync(installJsonPath(found))) return null
  // The exe path may be a realpath (/private/tmp vs /tmp); the hooks use the home as installed.
  const recorded = readInstallRecord(found)?.home
  try {
    if (recorded && realpathSync(recorded) === realpathSync(found)) return recorded
  } catch {}
  return found
}

/** For commands acting on an existing install: --home, else this binary's home, else default. */
const resolveTarget = (homeFlag: string | undefined, channelFlag: string | undefined) => {
  const home0 = homeFlag ?? homeOfSelf()
  const rec = home0 ? readInstallRecord(home0) : null
  const channel: Channel = channelFlag ? parseChannel(channelFlag) : (rec?.channel ?? "ga")
  return { home: home0 ?? CHANNELS[channel].home, channel }
}

const flagsOf = <T extends ParseArgsOptionsConfig>(args: string[], options: T) =>
  parseArgs({ args, options, allowPositionals: false, strict: true })

const cmdInstall = async (args: string[]) => {
  const { values } = flagsOf(args, {
    from: { type: "string" },
    yes: { type: "boolean", default: false },
    channel: { type: "string" },
    home: { type: "string" },
    settings: { type: "string" },
    holds: { type: "boolean", default: false },
    "no-app": { type: "boolean", default: false },
    "no-launchd": { type: "boolean", default: false },
    "no-hooks": { type: "boolean", default: false },
    "no-path": { type: "boolean", default: false },
    updating: { type: "boolean", default: false },
  })
  const payload = values.from ?? (compiled() ? payloadOfExecutable(self()) : null)
  if (!payload)
    throw new UsageError(
      "no payload: pass --from <dir> (an unpacked release) or run the payload's own bin/session-inbox",
    )
  const channel = parseChannel(values.channel)
  await install(
    {
      payload,
      apply: values.yes === true,
      channel,
      home: values.home ?? CHANNELS[channel].home,
      settingsPath: values.settings ?? defaultSettingsPath(),
      holds: values.holds === true,
      launchd: !values["no-launchd"],
      hooks: !values["no-hooks"],
      app: !values["no-app"],
      pathLink: !values["no-path"],
      source: "release",
      updating: values.updating === true,
    },
    say,
  )
  return 0
}

const cmdUninstall = async (args: string[]) => {
  const { values } = flagsOf(args, {
    yes: { type: "boolean", default: false },
    channel: { type: "string" },
    home: { type: "string" },
    settings: { type: "string" },
    app: { type: "boolean", default: false },
    purge: { type: "boolean", default: false },
    "no-launchd": { type: "boolean", default: false },
    "no-hooks": { type: "boolean", default: false },
  })
  const { home, channel } = resolveTarget(values.home, values.channel)
  const rec = readInstallRecord(home)
  uninstall(
    {
      apply: values.yes === true,
      channel,
      home,
      settingsPath: values.settings ?? (rec?.settingsPath || defaultSettingsPath()),
      launchd: !values["no-launchd"],
      hooks: !values["no-hooks"],
      app: values.app === true,
      purge: values.purge === true,
    },
    say,
  )
  return 0
}

/** Re-run this update in its own session, so launchd stopping the daemon can't take it along. */
const detachedSelf = (args: string[]): Promise<number> =>
  new Promise((resolve) => {
    const argv = compiled() ? args : [Bun.main, ...args]
    const child = spawn(process.execPath, argv, {
      detached: true,
      stdio: "inherit",
      env: { ...process.env, SESSION_INBOX_UPDATE_DETACHED: "1" },
    })
    child.on("exit", (code) => resolve(code ?? 1))
    child.on("error", () => resolve(1))
  })

const cmdUpdate = async (args: string[]) => {
  const { values } = flagsOf(args, {
    check: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    to: { type: "string" },
    channel: { type: "string" },
    home: { type: "string" },
  })
  const { home, channel } = resolveTarget(values.home, values.channel)
  const ctx = { home, channel, env: process.env, say }
  const to = values.to ?? null
  if (values.check) {
    const r = await check(ctx, to)
    say(values.json ? JSON.stringify(r) : describeCheck(r))
    return values.json || r.error === null ? 0 : 1
  }
  if (values.yes && process.env.SESSION_INBOX_UPDATE_DETACHED !== "1" && channel !== "beta")
    return detachedSelf(["update", ...args])
  return apply(ctx, { to, yes: values.yes === true })
}

const main = async (argv: string[]): Promise<number> => {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case "--version":
    case "-v":
    case "version":
      say(`session-inbox ${VERSION} (${BUILD})`)
      return 0
    case "install":
      return cmdInstall(rest)
    case "uninstall":
      return cmdUninstall(rest)
    case "update":
      return cmdUpdate(rest)
    case "status":
      await status(say)
      return 0
    case "holds":
      if (!isChannel(rest[0])) throw new UsageError("usage: session-inbox holds <ga|beta>")
      setHolds(rest[0], say)
      return 0
    case "open":
      openInbox(
        rest[0] === undefined ? resolveTarget(undefined, undefined).channel : parseChannel(rest[0]),
      )
      return 0
    case undefined:
    case "help":
    case "--help":
    case "-h":
      say(USAGE)
      return cmd === undefined ? 2 : 0
    default:
      throw new UsageError(`unknown command ${cmd}\n${USAGE}`)
  }
}

if (import.meta.main) {
  // An update outlives the daemon that started it (H-023).
  process.on("SIGHUP", () => {})
  process.on("SIGPIPE", () => {})
  process.stdout.on?.("error", () => {})
  process.stderr.on?.("error", () => {})
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      try {
        process.stderr.write(`session-inbox: ${(e as Error).message}\n`)
      } catch {}
      process.exit(
        e instanceof UsageError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
          ? 2
          : 1,
      )
    },
  )
}

export { main }
