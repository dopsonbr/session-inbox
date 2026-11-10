/**
 * Update policy (D-035..D-039). The daemon decides when to check and when to
 * install; `<home>/bin/session-inbox` does the downloading, installing and
 * restarting. Status lives in memory, plus what the CLI's state file says.
 * Nothing here may block a tick or a hook: checks are async and fail quiet.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import type { UpdateStatus } from "@session-inbox/contracts"
import { ApiFailure, type Engine } from "./engine.ts"
import type { ClockShape, LoggerShape, UpdateCheckResult, UpdaterShape } from "./services.ts"
import type { Settings } from "./settings.ts"

/** First check this long after startup. */
export const STARTUP_CHECK_DELAY_MS = 60_000
/** No hook event for this long counts as quiet. */
export const QUIET_MS = 30_000
/** `updating` with no state-file change for this long ⇒ failed. */
export const STALL_MS = 10 * 60_000
/** After the CLI exited 0 and we're still alive, wait this long for the restart. */
const RESTART_GRACE_MS = 60_000
/** A failed update reported by the state file at startup is shown if this recent. */
const STARTUP_FAILURE_WINDOW_MS = 3600_000

/** What survives restarts: which version we announced, and which one ran last. */
export interface UpdateMemo {
  readonly announced: string | null
  readonly lastRun: string | null
  /** `<version>@<at>` of the last failure we recorded, so a restart doesn't repeat it. */
  readonly lastFailure: string | null
}
export interface UpdateMemoStore {
  readonly read: () => UpdateMemo
  readonly write: (m: UpdateMemo) => void
}
const EMPTY_MEMO: UpdateMemo = { announced: null, lastRun: null, lastFailure: null }

export const fileMemo = (file: string): UpdateMemoStore => ({
  read: () => {
    try {
      if (!existsSync(file)) return EMPTY_MEMO
      const o = JSON.parse(readFileSync(file, "utf8")) as Partial<UpdateMemo>
      const s = (v: unknown) => (typeof v === "string" ? v : null)
      return { announced: s(o.announced), lastRun: s(o.lastRun), lastFailure: s(o.lastFailure) }
    } catch {
      return EMPTY_MEMO
    }
  },
  write: (m) => {
    try {
      writeFileSync(file, `${JSON.stringify(m)}\n`)
    } catch {
      // best effort
    }
  },
})

export const memoryMemo = (
  initial: Partial<UpdateMemo> = {},
): UpdateMemoStore & {
  value: UpdateMemo
} => {
  const store = {
    value: { ...EMPTY_MEMO, ...initial },
    read: () => store.value,
    write: (m: UpdateMemo) => {
      store.value = m
    },
  }
  return store
}

export interface UpdateDeps {
  readonly updater: UpdaterShape | null
  readonly clock: ClockShape
  readonly log: LoggerShape
  readonly settings: () => Settings
  readonly version: string
  readonly build: string
  readonly memo: UpdateMemoStore
  /** Why restarting now would hurt (live hold, outbox busy, recent hook), or null. */
  readonly busy: () => string | null
  /** Append a `daemon:*` event; returns its seq. */
  readonly event: (hook: string, payload: unknown) => number
  readonly currentSeq: () => number
  readonly publish: (status: UpdateStatus, seq: number) => void
}

/** Build the manager over an engine: events, quietness, ticks and the stream greeting. */
export const attachUpdates = (
  engine: Engine,
  o: { updater: UpdaterShape | null; version: string; build: string; memo: UpdateMemoStore },
): UpdateManager => {
  const m = new UpdateManager({
    ...o,
    clock: engine.deps.clock,
    log: engine.deps.log,
    settings: () => engine.settings,
    busy: () => engine.busyReason(QUIET_MS),
    event: (hook, payload) => engine.daemonEvent(hook, payload),
    currentSeq: () => engine.store.maxSeq(),
    publish: (status, seq) => engine.hub.publish({ _tag: "update", seq, status }),
  })
  engine.updates = m
  engine.hub.greeting = () =>
    m.supported ? { _tag: "update", seq: engine.store.maxSeq(), status: m.status() } : null
  return m
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const stateKey = (s: ReturnType<UpdaterShape["readState"]>) =>
  s ? `${s.version}|${s.state}|${s.at}|${s.error ?? ""}` : ""

export class UpdateManager {
  private readonly s: Mutable<Omit<UpdateStatus, "auto">>
  private nextCheckAt: number
  private checkInFlight: Promise<void> | null = null
  /** Latest version we appended `daemon:update-available` for. */
  private announcedAvailable: string | null = null
  /** A failed version is never auto-applied again (only by hand). */
  private failedVersion: string | null = null
  private watch = { key: "", seenAt: 0, deadline: STALL_MS }
  private readonly inflight = new Set<Promise<unknown>>()

  constructor(private readonly deps: UpdateDeps) {
    const now = deps.clock.now()
    let supported = false
    try {
      supported = deps.updater?.supported() ?? false
    } catch {
      supported = false
    }
    this.s = {
      state: supported ? "idle" : "unsupported",
      current: deps.version,
      build: deps.build,
      latest: null,
      available: false,
      notesUrl: null,
      publishedAt: null,
      checkedAt: null,
      error: null,
      source: null,
      target: null,
      progress: null,
      justUpdatedFrom: null,
      updatedAt: null,
    }
    this.nextCheckAt = now + STARTUP_CHECK_DELAY_MS
    if (supported) this.startup(now)
  }

  get supported(): boolean {
    return this.s.state !== "unsupported"
  }

  status(): UpdateStatus {
    const auto = this.deps.settings()["updates.auto"] && this.s.source === "release"
    return { ...this.s, auto }
  }

  /** Resolves once no check or apply spawn is pending (tests). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight])
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p)
    p.finally(() => this.inflight.delete(p)).catch(() => {})
    return p
  }

  private publish(seq?: number) {
    this.deps.publish(this.status(), seq ?? this.deps.currentSeq())
  }

  private get updater(): UpdaterShape {
    return this.deps.updater as UpdaterShape
  }

  /** The state file left by the CLI tells us how the last update went. */
  private startup(now: number) {
    const memo = this.deps.memo.read()
    const v = this.deps.version
    this.deps.memo.write({ ...memo, lastRun: v })
    const st = this.updater.readState()
    if (!st) return
    if (st.state === "done" && st.version === v && memo.announced !== v) {
      const from = memo.lastRun && memo.lastRun !== v ? memo.lastRun : null
      this.deps.event("daemon:updated", { version: v, from })
      this.s.justUpdatedFrom = from
      this.s.updatedAt = now
      this.deps.memo.write({ ...memo, lastRun: v, announced: v })
      this.deps.log.info(`updated to ${v}${from ? ` from ${from}` : ""}`)
      return
    }
    if (st.version === v) return
    if (st.state === "failed" && now - st.at < STARTUP_FAILURE_WINDOW_MS) {
      this.s.state = "failed"
      this.s.target = st.version
      this.s.error = st.error ?? "update failed"
      this.failedVersion = st.version
      const key = `${st.version}@${st.at}`
      if (memo.lastFailure !== key) {
        this.deps.event("daemon:update-failed", { version: st.version, error: this.s.error })
        this.deps.memo.write({ ...this.deps.memo.read(), lastFailure: key })
      }
      return
    }
    if (st.state !== "done" && st.state !== "failed" && now - st.at < STALL_MS) {
      // An update is still running (it may restart us again when it's done).
      this.s.state = "updating"
      this.s.target = st.version
      this.s.progress = st.state
      this.watch = { key: stateKey(st), seenAt: now, deadline: STALL_MS }
    }
  }

  /** Called from the engine's 1 s tick. Never blocks: checks and spawns run async. */
  tick(): void {
    if (this.s.state === "unsupported") return
    const now = this.deps.clock.now()
    if (this.s.state === "updating") {
      this.watchState(now)
      return
    }
    if (this.deps.settings()["updates.check"] && !this.checkInFlight && now >= this.nextCheckAt)
      void this.runCheck()
    this.maybeAutoApply()
  }

  /** POST /v1/update/check. */
  async checkNow(): Promise<UpdateStatus> {
    if (this.s.state === "unsupported")
      throw new ApiFailure(409, "conflict", "updates aren't supported by this install")
    if (this.s.state !== "updating") await this.runCheck()
    return this.status()
  }

  private runCheck(): Promise<void> {
    if (this.checkInFlight) return this.checkInFlight
    const interval = Math.max(60_000, this.deps.settings()["updates.checkIntervalMs"])
    this.nextCheckAt = this.deps.clock.now() + interval
    if (this.s.state === "idle") {
      this.s.state = "checking"
      this.publish()
    }
    const p = (async () => {
      let seq: number | undefined
      try {
        seq = this.onResult(await this.updater.check())
      } catch (e) {
        this.onCheckError(e instanceof Error ? e.message : String(e))
      } finally {
        this.checkInFlight = null
      }
      if (this.s.state === "checking") this.s.state = "idle"
      this.publish(seq)
    })()
    this.checkInFlight = p
    return this.track(p)
  }

  private onResult(r: UpdateCheckResult): number | undefined {
    if (this.s.state === "updating") return undefined
    this.s.checkedAt = this.deps.clock.now()
    this.s.source = r.source
    this.s.latest = r.latest
    this.s.available = r.available
    this.s.notesUrl = r.notesUrl
    this.s.publishedAt = r.publishedAt
    if (r.available && this.s.state === "failed" && r.latest === this.failedVersion) {
      return undefined // keep showing the failure (and its error) for that version
    }
    this.s.error = r.error
    if (!r.available) {
      this.s.state = "idle"
      this.s.target = null
      return undefined
    }
    this.s.state = "available"
    this.s.target = null
    if (this.announcedAvailable === r.latest) return undefined
    this.announcedAvailable = r.latest
    this.deps.log.info(`update available: ${r.latest} (running ${this.deps.version})`)
    return this.deps.event("daemon:update-available", {
      version: r.latest,
      current: this.deps.version,
      source: r.source,
    })
  }

  private onCheckError(message: string) {
    this.deps.log.warn("update check failed", message)
    this.s.checkedAt = this.deps.clock.now()
    if (this.s.state !== "failed") this.s.error = message
  }

  private maybeAutoApply() {
    if (this.s.state !== "available" || this.s.latest === null) return
    if (!this.status().auto || this.s.latest === this.failedVersion) return
    if (this.deps.busy() !== null) return
    this.start(this.s.latest, "auto")
  }

  /** POST /v1/update/apply: works regardless of quietness; the user asked. */
  apply(version?: string): UpdateStatus {
    if (this.s.state === "unsupported")
      throw new ApiFailure(409, "conflict", "updates aren't supported by this install")
    if (this.s.state === "updating")
      throw new ApiFailure(409, "conflict", "an update is already running")
    const offered = this.s.available ? this.s.latest : null
    const retry = this.s.state === "failed" ? this.s.target : null
    const target = version ?? offered ?? retry
    if (target === null || (target !== offered && target !== retry))
      throw new ApiFailure(409, "conflict", "no update is available")
    this.start(target, "manual")
    return this.status()
  }

  private start(version: string, trigger: "auto" | "manual") {
    const now = this.deps.clock.now()
    this.s.state = "updating"
    this.s.target = version
    this.s.progress = null
    this.s.error = null
    // Only changes after this point count (a stale file may still say "failed").
    this.watch = { key: stateKey(this.updater.readState()), seenAt: now, deadline: STALL_MS }
    const seq = this.deps.event("daemon:update-started", {
      version,
      from: this.deps.version,
      trigger,
    })
    this.deps.log.info(`installing update ${version} (${trigger})`)
    this.publish(seq)
    this.track(
      this.updater
        .apply(version, (code) => this.onExit(version, code))
        .catch((e) => this.fail(version, e instanceof Error ? e.message : String(e))),
    )
  }

  private onExit(version: string, code: number | null) {
    if (this.s.state !== "updating" || this.s.target !== version) return
    if (code === 0) {
      // It should have restarted us; give launchd a moment before calling it failed.
      this.watch = {
        ...this.watch,
        seenAt: this.deps.clock.now(),
        deadline: RESTART_GRACE_MS,
      }
      return
    }
    const st = this.updater.readState()
    const fromFile = st && st.version === version && st.state === "failed" ? st.error : null
    this.fail(
      version,
      fromFile ?? `session-inbox update exited ${code ?? "abnormally"}; see update.log`,
    )
  }

  private watchState(now: number) {
    const st = this.updater.readState()
    const key = stateKey(st)
    const target = this.s.target
    if (key !== this.watch.key) {
      this.watch = { key, seenAt: now, deadline: this.watch.deadline }
      if (st && st.version === target) {
        if (st.state === "failed") {
          this.fail(target, st.error ?? "update failed")
          return
        }
        this.s.progress = st.state
        this.publish()
      }
    }
    if (now - this.watch.seenAt > this.watch.deadline && target !== null) {
      this.fail(
        target,
        this.watch.deadline === STALL_MS
          ? "the update stalled (no progress for 10 minutes); see update.log"
          : `installed ${target}, but Session Inbox didn't restart`,
      )
    }
  }

  private fail(version: string, error: string) {
    if (this.s.state !== "updating" || this.s.target !== version) return
    this.deps.log.warn(`update to ${version} failed`, error)
    this.s.state = "failed"
    this.s.error = error
    this.s.progress = null
    this.failedVersion = version
    const at = this.updater.readState()?.at
    if (at !== undefined) {
      this.deps.memo.write({ ...this.deps.memo.read(), lastFailure: `${version}@${at}` })
    }
    const seq = this.deps.event("daemon:update-failed", { version, error })
    this.publish(seq)
  }
}
