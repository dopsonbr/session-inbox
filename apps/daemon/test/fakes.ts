/** Fakes for every outside-world service, plus an engine factory on in-memory SQLite. */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDb } from "../src/db/db.ts"
import type { ReadResult } from "../src/domain/preview.ts"
import { Engine } from "../src/engine.ts"
import type {
  ClaudeAuth,
  ClaudeCliShape,
  FilesShape,
  GitInfo,
  GitShape,
  LoggerShape,
  NotifierShape,
  OpenerShape,
  UpdateCheckResult,
  UpdaterShape,
  UpdateStateFile,
} from "../src/services.ts"
import { DEFAULT_SETTINGS, type Settings } from "../src/settings.ts"

export const T0 = 1_800_000_000_000

export class FakeClock {
  t = T0
  now = () => this.t
  advance(ms: number) {
    this.t += ms
  }
}

export class FakeGit implements GitShape {
  calls = 0
  constructor(readonly map: Record<string, GitInfo> = {}) {}
  resolve = async (cwd: string): Promise<GitInfo> => {
    this.calls++
    return this.map[cwd] ?? { root: cwd, worktree: null, branch: "main" }
  }
}

export class FakeClaude implements ClaudeCliShape {
  titles: string[] = []
  resumes: { sessionId: string; cwd: string | null; body: string }[] = []
  titleResult: string | null = "Generated Title"
  failResumes = 0
  auth: ClaudeAuth = { found: true, loggedIn: true, method: "claude.ai", checkedAt: 0 }
  authCalls = 0
  authStatus = async () => {
    this.authCalls++
    return this.auth
  }
  title = async (prompt: string) => {
    this.titles.push(prompt)
    return this.titleResult
  }
  resume = async (sessionId: string, cwd: string | null, body: string) => {
    this.resumes.push({ sessionId, cwd, body })
    if (this.failResumes > 0) {
      this.failResumes--
      throw new Error("boom")
    }
  }
}

export class FakeNotifier implements NotifierShape {
  posted: { title: string; body: string }[] = []
  fallback = async (title: string, body: string) => {
    this.posted.push({ title, body })
  }
}

export class FakeOpener implements OpenerShape {
  opened: string[] = []
  copied: string[] = []
  open = async (url: string) => {
    this.opened.push(url)
  }
  copy = async (text: string) => {
    this.copied.push(text)
  }
}

export class FakeUpdater implements UpdaterShape {
  isSupported = true
  checks = 0
  applied: string[] = []
  result: UpdateCheckResult = {
    current: "0.1.0",
    latest: null,
    available: false,
    notesUrl: null,
    publishedAt: null,
    source: "release",
    error: null,
  }
  failCheck: string | null = null
  failApply: string | null = null
  stateFile: UpdateStateFile | null = null
  onExit: ((code: number | null) => void) | null = null
  offer(version: string, source: "release" | "source" = "release") {
    this.result = {
      ...this.result,
      latest: version,
      available: true,
      source,
      notesUrl: `https://example.test/releases/v${version}`,
      publishedAt: "2026-11-01T00:00:00Z",
    }
  }
  supported = () => this.isSupported
  check = async () => {
    this.checks++
    if (this.failCheck) throw new Error(this.failCheck)
    return this.result
  }
  apply = async (version: string, onExit?: (code: number | null) => void) => {
    this.applied.push(version)
    this.onExit = onExit ?? null
    if (this.failApply) throw new Error(this.failApply)
  }
  readState = () => this.stateFile
}

/** In-memory files: path → text, or "unreadable". Anything else is missing. */
export class FakeFiles implements FilesShape {
  files: Record<string, string | "unreadable"> = {}
  tails: Record<string, string> = {}
  reads: string[] = []
  read = (path: string, maxBytes: number): ReadResult => {
    this.reads.push(path)
    const f = this.files[path]
    if (f === undefined) return { _tag: "missing" }
    if (f === "unreadable") return { _tag: "unreadable", reason: "fake" }
    if (Buffer.byteLength(f) > maxBytes) return { _tag: "unreadable", reason: "too large" }
    return { _tag: "ok", text: f }
  }
  tail = (path: string, bytes: number): string | null => {
    const t = this.tails[path]
    return t === undefined ? null : t.slice(-bytes)
  }
  head = (path: string, bytes: number): string | null => {
    const t = this.tails[path]
    return t === undefined ? null : t.slice(0, bytes)
  }
}

export const silentLog: LoggerShape = { info: () => {}, warn: () => {}, error: () => {} }

export interface Harness {
  engine: Engine
  clock: FakeClock
  git: FakeGit
  claude: FakeClaude
  notifier: FakeNotifier
  opener: FakeOpener
  files: FakeFiles
  claudeDir: string
}

export const makeHarness = (
  opts: { settings?: Partial<Settings>; git?: FakeGit; dbFile?: string } = {},
): Harness => {
  const files = new FakeFiles()
  const clock = new FakeClock()
  const git = opts.git ?? new FakeGit()
  const claude = new FakeClaude()
  const notifier = new FakeNotifier()
  const opener = new FakeOpener()
  const claudeDir = mkdtempSync(join(tmpdir(), "inboxd-claude-"))
  const engine = new Engine({
    db: openDb(opts.dbFile ?? ":memory:"),
    clock,
    git,
    claude,
    notifier,
    opener,
    log: silentLog,
    files,
    claudeConfigDir: claudeDir,
    settings: { ...DEFAULT_SETTINGS, "questions.answerModeByRuntime": {}, ...opts.settings },
  })
  return { engine, clock, git, claude, notifier, opener, files, claudeDir }
}

/**
 * The classic mode, PreToolUse holds (D-074 made answering Claude's PermissionRequest the
 * default). Tests of holds, previews at hold time and lapses run in it explicitly.
 */
export const CLASSIC: Partial<Settings> = { "holds.via": "preToolUse" }
export const makeClassicHarness = (opts: Parameters<typeof makeHarness>[0] = {}): Harness =>
  makeHarness({ ...opts, settings: { ...CLASSIC, ...opts.settings } })

export const env = (entrypoint: string | null = "cli", hostSessionId: string | null = null) => ({
  entrypoint,
  hostSessionId,
  claudePid: 123,
})

export const envelope = (event: string, payload: Record<string, unknown>, e = env()) => ({
  event,
  payload: { hook_event_name: event, ...payload },
  env: e,
  sentAt: T0,
})

/**
 * A hook's long-poll attached to a live request, as a real hook keeps one (D-080): without it a
 * request that sees no poll for 20 s on the fake clock lapses. Returns the detach function.
 */
export const attachPoll = (engine: Engine, requestId: string | null): (() => void) => {
  const ctrl = new AbortController()
  void engine.waitDecision(requestId ?? "", 3600, ctrl.signal)
  return () => ctrl.abort()
}
