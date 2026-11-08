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
import { paths } from "@session-inbox/contracts/paths"
import { Effect, Schedule } from "effect"
import { openDb } from "./db/db.ts"
import { Engine } from "./engine.ts"
import { hookHandler, type ServerContext, uiHandler, VERSION } from "./server.ts"
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
} from "./services.ts"
import { loadSettings, type Settings } from "./settings.ts"

export interface DaemonOptions {
  readonly home: string
  /** 0 = random. */
  readonly port: number
  readonly uiDir: string
  readonly claudeConfigDir: string
  readonly settings?: Partial<Settings>
}

export interface DaemonServices {
  readonly clock: ClockShape
  readonly git: GitShape
  readonly claude: ClaudeCliShape
  readonly notifier: NotifierShape
  readonly opener: OpenerShape
  readonly log: LoggerShape
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
  const settings = loadSettings(db, opts.settings)
  const engine = new Engine({ db, ...svc, claudeConfigDir: opts.claudeConfigDir, settings })
  engine.recover()
  const token = loadToken(p.home)
  const ctx: ServerContext = { engine, token, uiDir: resolve(opts.uiDir), port: 0 }

  if (existsSync(p.socket)) rmSync(p.socket)
  const sock = Bun.serve({ unix: p.socket, fetch: hookHandler(ctx) })
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
  }
  writeSecret(p.connection, `${JSON.stringify(conn, null, 2)}\n`)
  svc.log.info(`inboxd ${VERSION} listening`, {
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
