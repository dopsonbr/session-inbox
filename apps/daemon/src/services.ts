/**
 * Everything the daemon does to the outside world, as Effect services so tests
 * can swap in fakes (test/fakes.ts). Shapes are plain Promise-returning
 * functions: the engine core is synchronous and calls out only at its edges.
 */
import { existsSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { INTERNAL_ENV } from "@session-inbox/contracts/paths"
import { Context, Layer } from "effect"
import { cleanGeneratedTitle, TITLE_INSTRUCTION } from "./domain/text.ts"

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

export interface ClaudeCliShape {
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

export const makeLiveClaudeCli = (claudeBin = process.env.SESSION_INBOX_CLAUDE ?? "claude") => {
  const shape: ClaudeCliShape = {
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
  Layer.succeed(Logger)(StderrLogger),
)
