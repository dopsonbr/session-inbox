/**
 * Everything the daemon does to the outside world, as Effect services so tests
 * can swap in fakes (test/fakes.ts). Shapes are plain Promise-returning
 * functions: the engine core is synchronous and calls out only at its edges.
 */
import { closeSync, existsSync, openSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { INTERNAL_ENV } from "@session-inbox/contracts/paths"
import { Context, Layer } from "effect"
import type { ReadResult } from "./domain/preview.ts"
import { cleanGeneratedTitle, readHead, readTail, TITLE_INSTRUCTION } from "./domain/text.ts"

export interface ClockShape {
  readonly now: () => number
}
export const Clock = Context.Service<ClockShape>("inboxd/Clock")

export interface GitInfo {
  /** Main worktree root (parent of the common git dir), or cwd when not a repo. */
  readonly root: string
  /** Linked worktree top-level, when it differs from root. */
  readonly worktree: string | null
  readonly branch: string | null
}
export interface GitShape {
  readonly resolve: (cwd: string) => Promise<GitInfo>
}
export const Git = Context.Service<GitShape>("inboxd/Git")

/**
 * What the `claude` CLI can do here (D-061). `found`: on PATH (or the override exists);
 * `loggedIn`: from `claude auth status`. null = couldn't tell.
 */
export interface ClaudeAuth {
  readonly found: boolean | null
  readonly loggedIn: boolean | null
  readonly method: string | null
  readonly checkedAt: number
}
export const UNKNOWN_AUTH: ClaudeAuth = { found: null, loggedIn: null, method: null, checkedAt: 0 }

export interface ClaudeCliShape {
  /**
   * Cached probe (10 min): `claude auth status` with INTERNAL_ENV, 10 s timeout. Never
   * rejects; unknown on any error.
   */
  readonly authStatus: () => Promise<ClaudeAuth>
  /** 3–6 word title, or null. Must never be ingested (INTERNAL_ENV, hooks disabled). */
  readonly title: (prompt: string) => Promise<string | null>
  /** `claude --resume <id> -p <body>` in cwd. Rejects with a message on failure. */
  readonly resume: (sessionId: string, cwd: string | null, body: string) => Promise<void>
}
export const ClaudeCli = Context.Service<ClaudeCliShape>("inboxd/ClaudeCli")

export interface NotifierShape {
  /** Fallback notification when no shell is connected (osascript). No actions. */
  readonly fallback: (title: string, body: string) => Promise<void>
}
export const Notifier = Context.Service<NotifierShape>("inboxd/Notifier")

export interface OpenerShape {
  readonly open: (url: string) => Promise<void>
  readonly copy: (text: string) => Promise<void>
}
export const Opener = Context.Service<OpenerShape>("inboxd/Opener")

/** One `session-inbox update --check --json` answer. */
export interface UpdateCheckResult {
  readonly current: string
  readonly latest: string | null
  readonly available: boolean
  readonly notesUrl: string | null
  readonly publishedAt: string | null
  readonly source: "release" | "source" | null
  readonly error: string | null
}
/** `<home>/update-state.json`, rewritten atomically by the CLI while it updates. */
export interface UpdateStateFile {
  readonly version: string
  readonly state: "downloading" | "verifying" | "installing" | "done" | "failed"
  readonly error: string | null
  readonly at: number
}
export interface UpdaterShape {
  /** The CLI exists (`<home>/bin/session-inbox`, or SESSION_INBOX_CLI). */
  readonly supported: () => boolean
  /** Runs the check (30 s timeout). Rejects with a message on any failure. */
  readonly check: () => Promise<UpdateCheckResult>
  /**
   * Spawns `update --yes --to <version>` detached (own session/process group) and
   * resolves once it started. `onExit` fires if it exits while this daemon lives.
   */
  readonly apply: (version: string, onExit?: (code: number | null) => void) => Promise<void>
  readonly readState: () => UpdateStateFile | null
}
export const Updater = Context.Service<UpdaterShape>("inboxd/Updater")
/**
 * Reads for approval previews (D-056). Synchronous on purpose: they run inside the ingest
 * transaction, are size-capped, and never throw.
 */
export interface FilesShape {
  /** UTF-8 text of a regular file up to `maxBytes`; bigger or unreadable ⇒ "unreadable". */
  readonly read: (path: string, maxBytes: number) => ReadResult
  /** The last `bytes` of a file (a transcript), or null. */
  readonly tail: (path: string, bytes: number) => string | null
  /** The first `bytes` of a file, or null. */
  readonly head: (path: string, bytes: number) => string | null
}
export const Files = Context.Service<FilesShape>("inboxd/Files")

export interface LoggerShape {
  readonly info: (msg: string, data?: unknown) => void
  readonly warn: (msg: string, data?: unknown) => void
  readonly error: (msg: string, data?: unknown) => void
}
export const Logger = Context.Service<LoggerShape>("inboxd/Logger")

// ---------------------------------------------------------------------------
// Live implementations
// ---------------------------------------------------------------------------

const run = async (
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
) => {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = opts.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : null
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (timer) clearTimeout(timer)
  return { stdout, stderr, code }
}

export const LiveClock: ClockShape = { now: () => Date.now() }

export const LiveGit: GitShape = {
  resolve: async (cwd) => {
    const fallback: GitInfo = { root: cwd, worktree: null, branch: null }
    if (!existsSync(cwd)) return fallback
    try {
      const rp = await run(
        [
          "git",
          "-C",
          cwd,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
          "--show-toplevel",
        ],
        { timeoutMs: 3000 },
      )
      if (rp.code !== 0) return fallback
      const [commonDir, top] = rp.stdout.trim().split("\n")
      if (!commonDir || !top) return fallback
      const common = resolve(cwd, commonDir)
      const root = basename(common) === ".git" ? dirname(common) : top
      const br = await run(["git", "-C", cwd, "branch", "--show-current"], { timeoutMs: 3000 })
      const branch = br.code === 0 ? br.stdout.trim() || null : null
      return { root, worktree: top !== root ? top : null, branch }
    } catch {
      return fallback
    }
  },
}

export const AUTH_CACHE_MS = 10 * 60_000
const AUTH_TIMEOUT_MS = 10_000

/** `claude auth status` output: the JSON object with a boolean `loggedIn`, else null. */
export const parseAuthStatus = (
  stdout: string,
): { loggedIn: boolean; method: string | null } | null => {
  const start = stdout.indexOf("{")
  const end = stdout.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    const o = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>
    if (typeof o.loggedIn !== "boolean") return null
    return { loggedIn: o.loggedIn, method: typeof o.authMethod === "string" ? o.authMethod : null }
  } catch {
    return null
  }
}

const binFound = (bin: string): boolean =>
  bin.includes("/") ? existsSync(bin) : Bun.which(bin) !== null

export const makeLiveClaudeCli = (claudeBin = process.env.SESSION_INBOX_CLAUDE ?? "claude") => {
  let cached: ClaudeAuth | null = null
  let probing: Promise<ClaudeAuth> | null = null
  const probe = async (): Promise<ClaudeAuth> => {
    const checkedAt = Date.now()
    if (!binFound(claudeBin)) return { found: false, loggedIn: null, method: null, checkedAt }
    try {
      const r = await run([claudeBin, "auth", "status"], {
        env: { [INTERNAL_ENV]: "1" },
        timeoutMs: AUTH_TIMEOUT_MS,
      })
      const parsed = parseAuthStatus(r.stdout)
      return {
        found: true,
        loggedIn: parsed?.loggedIn ?? null,
        method: parsed?.method ?? null,
        checkedAt,
      }
    } catch {
      return { found: true, loggedIn: null, method: null, checkedAt }
    }
  }
  const shape: ClaudeCliShape = {
    authStatus: () => {
      if (cached && Date.now() - cached.checkedAt < AUTH_CACHE_MS) return Promise.resolve(cached)
      if (!probing)
        probing = probe()
          .catch((): ClaudeAuth => ({ ...UNKNOWN_AUTH, checkedAt: Date.now() }))
          .then((a) => {
            cached = a
            probing = null
            return a
          })
      return probing
    },
    title: async (prompt) => {
      const r = await run(
        [
          claudeBin,
          "-p",
          "--model",
          "haiku",
          "--settings",
          '{"disableAllHooks":true}',
          TITLE_INSTRUCTION + prompt.slice(0, 2000),
        ],
        { env: { [INTERNAL_ENV]: "1" }, timeoutMs: 60_000 },
      )
      if (r.code !== 0) throw new Error(`claude -p exited ${r.code}: ${r.stderr.slice(0, 200)}`)
      return cleanGeneratedTitle(r.stdout)
    },
    resume: async (sessionId, cwd, body) => {
      const r = await run([claudeBin, "--resume", sessionId, "-p", body], {
        ...(cwd && existsSync(cwd) ? { cwd } : {}),
        timeoutMs: 15 * 60_000,
      })
      if (r.code !== 0)
        throw new Error(`claude --resume exited ${r.code}: ${(r.stderr || r.stdout).slice(0, 300)}`)
    },
  }
  return shape
}

const appleScriptString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

export const LiveNotifier: NotifierShape = {
  fallback: async (title, body) => {
    const script = `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`
    const r = await run(["osascript", "-e", script], { timeoutMs: 5000 })
    if (r.code !== 0) throw new Error(`osascript exited ${r.code}: ${r.stderr.slice(0, 200)}`)
  },
}

export const LiveOpener: OpenerShape = {
  open: async (url) => {
    const r = await run(["open", url], { timeoutMs: 5000 })
    if (r.code !== 0) throw new Error(`open exited ${r.code}: ${r.stderr.slice(0, 200)}`)
  },
  copy: async (text) => {
    const proc = Bun.spawn(["pbcopy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
    proc.stdin.write(text)
    await proc.stdin.end()
    await proc.exited
  },
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null)

/** The last stdout line that is a JSON object with the check fields; throws otherwise. */
export const parseCheckOutput = (stdout: string): UpdateCheckResult => {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
  for (const l of lines.reverse()) {
    let v: unknown
    try {
      v = JSON.parse(l)
    } catch {
      continue
    }
    if (!v || typeof v !== "object") continue
    const o = v as Record<string, unknown>
    if (typeof o.current !== "string" || typeof o.available !== "boolean") continue
    const latest = str(o.latest)
    return {
      current: o.current,
      latest,
      available: o.available && latest !== null,
      notesUrl: str(o.notesUrl),
      publishedAt: str(o.publishedAt),
      source: o.source === "release" || o.source === "source" ? o.source : null,
      error: str(o.error),
    }
  }
  throw new Error(`unrecognised output: ${stdout.trim().slice(0, 200) || "(empty)"}`)
}

const UPDATE_STATES = new Set(["downloading", "verifying", "installing", "done", "failed"])

export const parseStateFile = (text: string): UpdateStateFile | null => {
  try {
    const o = JSON.parse(text) as Record<string, unknown> | null
    if (!o || typeof o !== "object") return null
    if (typeof o.version !== "string" || typeof o.state !== "string") return null
    if (!UPDATE_STATES.has(o.state)) return null
    return {
      version: o.version,
      state: o.state as UpdateStateFile["state"],
      error: str(o.error),
      at: typeof o.at === "number" ? o.at : 0,
    }
  } catch {
    return null
  }
}

export const CHECK_TIMEOUT_MS = 30_000

/**
 * The updater over `<home>/bin/session-inbox` (override: SESSION_INBOX_CLI). The CLI
 * downloads, installs and restarts; the daemon only decides when (D-035).
 */
export const makeLiveUpdater = (opts: {
  home: string
  channel?: string
  cliPath?: string
  timeoutMs?: number
}): UpdaterShape => {
  const cli =
    opts.cliPath ?? process.env.SESSION_INBOX_CLI ?? join(opts.home, "bin", "session-inbox")
  const env: Record<string, string> = {
    SESSION_INBOX_HOME: opts.home,
    ...(opts.channel ? { SESSION_INBOX_CHANNEL: opts.channel } : {}),
  }
  const stateFile = join(opts.home, "update-state.json")
  return {
    supported: () => existsSync(cli),
    check: async () => {
      const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS
      const started = Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      // The race also covers a grandchild that keeps stdout open after the kill.
      const r = await Promise.race([
        run([cli, "update", "--check", "--json"], { env, timeoutMs }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`update check timed out after ${timeoutMs / 1000} s`)),
            timeoutMs + 1000,
          )
        }),
      ]).finally(() => clearTimeout(timer))
      if (r.code !== 0) {
        const timedOut = Date.now() - started >= timeoutMs
        throw new Error(
          timedOut
            ? `update check timed out after ${Math.round(timeoutMs / 1000)} s`
            : `update check exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`,
        )
      }
      return parseCheckOutput(r.stdout)
    },
    apply: async (version, onExit) => {
      const fd = openSync(join(opts.home, "update.log"), "a")
      try {
        // detached = setsid(): launchd stopping the daemon's process group spares it.
        const proc = Bun.spawn([cli, "update", "--yes", "--to", version], {
          env: { ...process.env, ...env },
          stdin: "ignore",
          stdout: fd,
          stderr: fd,
          detached: true,
        })
        proc.unref()
        proc.exited.then(
          (code) => onExit?.(code),
          () => onExit?.(null),
        )
      } finally {
        closeSync(fd)
      }
    },
    readState: () => {
      try {
        return existsSync(stateFile) ? parseStateFile(readFileSync(stateFile, "utf8")) : null
      } catch {
        return null
      }
    },
  }
}

export const LiveFiles: FilesShape = {
  read: (path, maxBytes) => {
    try {
      const st = statSync(path, { throwIfNoEntry: false })
      if (!st) return { _tag: "missing" }
      if (!st.isFile()) return { _tag: "unreadable", reason: "not a regular file" }
      if (st.size > maxBytes) return { _tag: "unreadable", reason: `larger than ${maxBytes} bytes` }
      return { _tag: "ok", text: readFileSync(path, "utf8") }
    } catch (e) {
      return { _tag: "unreadable", reason: e instanceof Error ? e.message : String(e) }
    }
  },
  tail: (path, bytes) => readTail(path, bytes),
  head: (path, bytes) => readHead(path, bytes),
}

const line = (level: string, msg: string, data?: unknown) => {
  const extra =
    data === undefined ? "" : ` ${data instanceof Error ? data.message : JSON.stringify(data)}`
  process.stderr.write(`${new Date().toISOString()} ${level} ${msg}${extra}\n`)
}
export const StderrLogger: LoggerShape = {
  info: (m, d) => line("INFO", m, d),
  warn: (m, d) => line("WARN", m, d),
  error: (m, d) => line("ERROR", m, d),
}

export const LiveServices = Layer.mergeAll(
  Layer.succeed(Clock)(LiveClock),
  Layer.succeed(Git)(LiveGit),
  Layer.succeed(ClaudeCli)(makeLiveClaudeCli()),
  Layer.succeed(Notifier)(LiveNotifier),
  Layer.succeed(Opener)(LiveOpener),
  Layer.succeed(Files)(LiveFiles),
  Layer.succeed(Logger)(StderrLogger),
)
