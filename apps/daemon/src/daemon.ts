/**
 * Wiring: open the DB, build the engine, start both listeners, write
 * connection.json. `daemonProgram` is the Effect entry (timers as fibers);
 * `startDaemon` is the plain core it wraps, reused by API tests.
 */
import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { Connection } from "@session-inbox/contracts"
import { CHANNELS, type Channel, paths } from "@session-inbox/contracts/paths"
import { Effect, Option, Schedule } from "effect"
import { openDb } from "./db/db.ts"
import { Engine } from "./engine.ts"
import { BUILD, hookHandler, type ServerContext, uiHandler, VERSION } from "./server.ts"
import {
  ClaudeCli,
  type ClaudeCliShape,
  Clock,
  type ClockShape,
  Git,
  type GitShape,
  Logger,
  type LoggerShape,
  Notifier,
  type NotifierShape,
  Opener,
  type OpenerShape,
  Updater,
  type UpdaterShape,
} from "./services.ts"
import { DEFAULT_SETTINGS, loadSettings, type Settings } from "./settings.ts"
import { attachUpdates, fileMemo } from "./updates.ts"

export interface DaemonOptions {
  readonly home: string
  /** 0 = random. */
  readonly port: number
  readonly uiDir: string
  readonly claudeConfigDir: string
  readonly settings?: Partial<Settings>
  /** Defaults that DB rows override (from SESSION_INBOX_SETTINGS; H-016). */
  readonly settingDefaults?: Partial<Settings>
  readonly channel?: Channel
  /** Home of the other channel, for the Settings pane's two-holders caveat (H-016); null = none. */
  readonly otherChannelHome?: string | null
}

export interface DaemonServices {
  readonly clock: ClockShape
  readonly git: GitShape
  readonly claude: ClaudeCliShape
  readonly notifier: NotifierShape
  readonly opener: OpenerShape
  readonly log: LoggerShape
  /** Absent (dev runs, most tests) ⇒ updates are "unsupported" (D-035). */
  readonly updater?: UpdaterShape | null
}

export interface DaemonHandle {
  readonly engine: Engine
  readonly socketPath: string
  readonly port: number
  readonly token: string
  readonly stop: () => Promise<void>
}

export const DEFAULT_UI_DIR = resolve(import.meta.dir, "../../desktop/dist")
export const DEFAULT_CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")

const writeSecret = (file: string, content: string) => {
  writeFileSync(file, content, { mode: 0o600 })
  chmodSync(file, 0o600)
}

/** Per-install bearer token, generated once, stored 0600 at <home>/token. */
export const loadToken = (home: string): string => {
  const file = join(home, "token")
  if (existsSync(file)) {
    const t = readFileSync(file, "utf8").trim()
    if (t.length >= 32) return t
  }
  const t = randomBytes(32).toString("hex")
  writeSecret(file, `${t}\n`)
  return t
}

export const startDaemon = async (
  opts: DaemonOptions,
  svc: DaemonServices,
): Promise<DaemonHandle> => {
  const p = paths(opts.home)
  mkdirSync(p.home, { recursive: true, mode: 0o700 })
  const db = openDb(p.db)
  const settings = loadSettings(db, opts.settings, opts.settingDefaults)
  const settingDefaults = { ...DEFAULT_SETTINGS, ...opts.settingDefaults }
  const engine = new Engine({
    db,
    ...svc,
    claudeConfigDir: opts.claudeConfigDir,
    settings,
    settingDefaults,
  })
  engine.recover()
  engine.hub.info = { version: VERSION, build: BUILD }
  attachUpdates(engine, {
    updater: svc.updater ?? null,
    version: VERSION,
    build: BUILD,
    memo: fileMemo(join(p.home, "update-memo.json")),
  })
  const token = loadToken(p.home)
  const channel = opts.channel ?? "ga"
  const other: Channel = channel === "ga" ? "beta" : "ga"
  const otherHome =
    opts.otherChannelHome === undefined ? CHANNELS[other].home : opts.otherChannelHome
  const ctx: ServerContext = {
    engine,
    token,
    uiDir: resolve(opts.uiDir),
    channel,
    title: CHANNELS[channel].title,
    port: 0,
    otherChannel: () =>
      otherHome !== null &&
      resolve(otherHome) !== resolve(p.home) &&
      existsSync(paths(otherHome).db)
        ? other
        : null,
  }

  if (existsSync(p.socket)) rmSync(p.socket)
  // idleTimeout 0: decision long-polls last up to 110 s (Bun's types omit it for unix; runtime honours it).
  const sockOptions: unknown = { unix: p.socket, fetch: hookHandler(ctx), idleTimeout: 0 }
  const sock = Bun.serve(sockOptions as Parameters<typeof Bun.serve>[0])
  chmodSync(p.socket, 0o600)
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    fetch: uiHandler(ctx),
    idleTimeout: 0,
  })
  const port = http.port ?? opts.port
  ctx.port = port

  const conn: Connection = {
    socketPath: p.socket,
    httpPort: port,
    token,
    pid: process.pid,
    version: VERSION,
    channel,
    build: BUILD,
  }
  writeSecret(p.connection, `${JSON.stringify(conn, null, 2)}\n`)
  svc.log.info(`inboxd ${VERSION} (${channel}, ${BUILD}) listening`, {
    socket: p.socket,
    http: `http://127.0.0.1:${port}/`,
  })

  return {
    engine,
    socketPath: p.socket,
    port,
    token,
    stop: async () => {
      sock.stop(true)
      http.stop(true)
      await engine.idle()
      if (existsSync(p.socket)) rmSync(p.socket)
      db.close()
    },
  }
}

/** The daemon as an Effect: services from the environment, timers as scoped fibers. */
export const daemonProgram = (opts: DaemonOptions) =>
  Effect.gen(function* () {
    const svc: DaemonServices = {
      clock: yield* Clock,
      git: yield* Git,
      claude: yield* ClaudeCli,
      notifier: yield* Notifier,
      opener: yield* Opener,
      log: yield* Logger,
      updater: Option.getOrNull(yield* Effect.serviceOption(Updater)),
    }
    const handle = yield* Effect.acquireRelease(
      Effect.promise(() => startDaemon(opts, svc)),
      (h) => Effect.promise(() => h.stop()),
    )
    const tick = Effect.sync(() => {
      try {
        handle.engine.tick()
      } catch (e) {
        svc.log.error("tick failed", e)
      }
    })
    yield* Effect.forkScoped(Effect.repeat(tick, Schedule.spaced("1 second")))
    yield* Effect.forkScoped(
      Effect.repeat(
        Effect.sync(() => handle.engine.hub.heartbeat()),
        Schedule.spaced("15 seconds"),
      ),
    )
    return yield* Effect.never
  })
