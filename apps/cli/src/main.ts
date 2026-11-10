/**
 * session-inbox — install, update and inspect Session Inbox (H-019).
 *   session-inbox install [--from <payload>] [--yes] [--channel ga|beta] [--home <dir>]
 *                         [--settings <path>] [--holds] [--no-app] [--no-launchd] [--no-hooks]
 *                         [--no-path] [--label <reverse.dns>] [--releases-url <url>]
 *                         [--asset-url <url>] [--repo <owner/name>]
 *   session-inbox uninstall [--yes] [--channel] [--home] [--settings] [--app] [--purge]
 *                           [--no-launchd] [--no-hooks] [--label]
 *   session-inbox update [--check] [--json] [--yes] [--to <version>] [--channel ga|beta]
 *   session-inbox doctor [--json] [--channel] [--home] [--label]
 *   session-inbox status [--channel] [--home] [--label] | holds <ga|beta> | open [ga|beta]
 *   session-inbox --version
 * Everything that changes the machine is a dry run unless --yes.
 */
import { spawn } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { basename, dirname } from "node:path"
import { type ParseArgsOptionsConfig, parseArgs } from "node:util"
import { CHANNELS, type Channel, isChannel } from "@session-inbox/contracts/paths"
import { BUILD, VERSION } from "@session-inbox/contracts/version"
import { defaultSettingsPath, parseChannel, type Say, UsageError } from "./common.ts"
import { doctor } from "./doctor.ts"
import { install } from "./install.ts"
import { isLabel } from "./launchd.ts"
import { payloadOfExecutable, readPayload } from "./manifest.ts"
import { installJsonPath, readInstallRecord, writeUpdateState } from "./state.ts"
import { defaultTargets, openInbox, setHolds, status } from "./status.ts"
import { uninstall } from "./uninstall.ts"
import { apply, check, describeCheck } from "./update.ts"

const USAGE = `usage: session-inbox <command>
  install    install this release (dry run unless --yes)
  uninstall  remove hooks, launchd agent and PATH link (--purge: also the data)
  update     check for (--check) or install (--yes) a newer release
  status     both channels: version, daemon, hooks, holds
  doctor     check the setup and say what to fix (--json for the raw report)
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

/**
 * For commands acting on an existing install: --home; else this binary's own home, but only
 * when no --channel is given or that home is the channel asked for; else the channel's
 * default home. So GA's CLI run with `--channel beta` acts on beta, never on itself.
 */
export const resolveTarget = (
  homeFlag: string | undefined,
  channelFlag: string | undefined,
  ownHome: string | null = homeOfSelf(),
) => {
  const wanted: Channel | null = channelFlag === undefined ? null : parseChannel(channelFlag)
  const own = ownHome && (wanted === null || readInstallRecord(ownHome)?.channel === wanted)
  const home0 = homeFlag ?? (own ? ownHome : null)
  const rec = home0 ? readInstallRecord(home0) : null
  const channel: Channel = wanted ?? rec?.channel ?? "ga"
  const home = home0 ?? CHANNELS[channel].home
  return { home, channel, rec: rec ?? readInstallRecord(home) }
}

const parseLabel = (v: string | undefined): string | null => {
  if (v === undefined) return null
  if (!isLabel(v)) throw new UsageError(`--label must look like com.example.name, not ${v}`)
  return v
}

/** `--daemon-env KEY=VALUE` (repeatable, for tests): extra plist environment. */
const parseEnvPairs = (pairs: string[] | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const p of pairs ?? []) {
    const i = p.indexOf("=")
    if (i <= 0) throw new UsageError(`--daemon-env needs KEY=VALUE, not ${p}`)
    out[p.slice(0, i)] = p.slice(i + 1)
  }
  return out
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
    label: { type: "string" },
    "releases-url": { type: "string" },
    "asset-url": { type: "string" },
    repo: { type: "string" },
    "daemon-env": { type: "string", multiple: true },
  })
  const env = process.env
  const payload = values.from ?? (compiled() ? payloadOfExecutable(self()) : null)
  if (!payload)
    throw new UsageError(
      "no payload: pass --from <dir> (an unpacked release) or run the payload's own bin/session-inbox",
    )
  const channel = parseChannel(values.channel)
  const home = values.home ?? CHANNELS[channel].home
  try {
    await install(
      {
        payload,
        apply: values.yes === true,
        channel,
        home,
        settingsPath: values.settings ?? defaultSettingsPath(),
        holds: values.holds === true,
        launchd: !values["no-launchd"],
        hooks: !values["no-hooks"],
        app: !values["no-app"],
        pathLink: !values["no-path"],
        source: "release",
        updating: values.updating === true,
        label: parseLabel(values.label),
        // Install from a mirror: flags win, else the environment install.sh was run with.
        releasesUrl: values["releases-url"] ?? env.SESSION_INBOX_RELEASES_URL ?? null,
        assetUrl: values["asset-url"] ?? env.SESSION_INBOX_ASSET_URL ?? null,
        repo: values.repo ?? env.SESSION_INBOX_REPO ?? null,
        daemonEnv: parseEnvPairs(values["daemon-env"]),
      },
      say,
    )
  } catch (e) {
    // During an update, the updater reads this to say why (e.g. how to load the daemon by hand).
    if (values.updating)
      try {
        writeUpdateState(home, readPayload(payload).version, "failed", (e as Error).message)
      } catch {}
    throw e
  }
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
    label: { type: "string" },
  })
  const { home, channel, rec } = resolveTarget(values.home, values.channel)
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
      label: parseLabel(values.label),
    },
    say,
  )
  return 0
}

/** status/doctor: `--home`/`--label`/`--channel` narrow to one install; none = the defaults. */
const singleTarget = (args: string[]) => {
  const { values } = flagsOf(args, {
    channel: { type: "string" },
    home: { type: "string" },
    label: { type: "string" },
    settings: { type: "string" },
    json: { type: "boolean", default: false },
  })
  const narrowed = values.home !== undefined || values.label !== undefined
  const { home, channel, rec } = resolveTarget(values.home, values.channel)
  return {
    json: values.json === true,
    narrowed: narrowed || values.channel !== undefined,
    target: {
      channel,
      home,
      label: parseLabel(values.label) ?? rec?.label ?? CHANNELS[channel].label,
      settingsPath: values.settings ?? (rec?.settingsPath || defaultSettingsPath()),
    },
  }
}

const cmdStatus = async (args: string[]) => {
  const { narrowed, target } = singleTarget(args)
  await status(say, narrowed ? [target] : defaultTargets())
  return 0
}

const cmdDoctor = async (args: string[]) => {
  const { json, target } = singleTarget(args)
  return doctor(target, { json }, say)
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
      return cmdStatus(rest)
    case "doctor":
      return cmdDoctor(rest)
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
