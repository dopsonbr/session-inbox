/** Fakes for every outside-world service, plus an engine factory on in-memory SQLite. */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDb } from "../src/db/db.ts"
import { Engine } from "../src/engine.ts"
import type {
  ClaudeCliShape,
  GitInfo,
  GitShape,
  LoggerShape,
  NotifierShape,
  OpenerShape,
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

export const silentLog: LoggerShape = { info: () => {}, warn: () => {}, error: () => {} }

export interface Harness {
  engine: Engine
  clock: FakeClock
  git: FakeGit
  claude: FakeClaude
  notifier: FakeNotifier
  opener: FakeOpener
  claudeDir: string
}

export const makeHarness = (
  opts: { settings?: Partial<Settings>; git?: FakeGit; dbFile?: string } = {},
): Harness => {
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
    claudeConfigDir: claudeDir,
    settings: { ...DEFAULT_SETTINGS, "questions.answerModeByRuntime": {}, ...opts.settings },
  })
  return { engine, clock, git, claude, notifier, opener, claudeDir }
}

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
