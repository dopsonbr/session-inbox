/**
 * The daemon's core: hook ingest, classification, holds, user intents,
 * notification policy, outbox and timers. Every mutation runs in one
 * synchronous SQLite transaction that appends an event (so seq is monotonic and
 * every delta carries the seq that caused it); side effects (waking long-polls,
 * notifications, spawning claude) run after commit.
 */
import type { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { basename } from "node:path"
import {
  type ActionResponse,
  type Answer,
  type AttentionKind,
  type Decision,
  decodeHookPayload,
  type HookDecision,
  type HookEnv,
  HookEnvelope,
  HookEvent,
  type HookIngestResponse,
  type ItemDetail,
  type NotificationAction,
  NotificationPayload,
  type NotifyPayload,
  PostToolUsePayload,
  PreToolUsePayload,
  type Session,
  SessionEndPayload,
  SessionStartPayload,
  type Snapshot,
  StopPayload,
  SubagentPayload,
  type TimelineEntry,
  USER_SETTING_KEYS,
  UserPromptSubmitPayload,
  type UserSettingKey,
  type UserSettings,
  type UserSettingsPatch,
} from "@session-inbox/contracts"
import { Result, Schema } from "effect"
import { computePreview } from "./approvalPreview.ts"
import {
  type LifecycleEvent,
  type LifecycleState,
  stateFromRow,
  transition,
} from "./domain/lifecycle.ts"
import { allowAlwaysRule, appendAllowRule, ruleVerdict } from "./domain/permissions.ts"
import {
  type AnswerMode,
  encodeLiveAnswers,
  formatAnswersReply,
  parseQuestions,
  validateAnswers,
} from "./domain/questions.ts"
import {
  firstLine,
  lastTurnErrored,
  permissionSummary,
  provisionalTitle,
  toolLine,
} from "./domain/text.ts"
import type {
  ClaudeCliShape,
  ClockShape,
  FilesShape,
  GitInfo,
  GitShape,
  LoggerShape,
  NotifierShape,
  OpenerShape,
} from "./services.ts"
import { DEFAULT_SETTINGS, type Settings } from "./settings.ts"
import {
  type AgentRow,
  type ApprovalRow,
  type EventRow,
  type ItemRow,
  type NotificationRow,
  type OutboxRow,
  type SessionRow,
  Store,
  toAgent,
  toApproval,
  toItem,
  toOutbox,
  toProject,
  toQuestion,
  toSession,
} from "./store.ts"
import { StreamHub } from "./stream.ts"
import type { UpdateManager } from "./updates.ts"
import { normalizeSetting, pickUserSettings } from "./userSettings.ts"

export interface EngineDeps {
  readonly db: Database
  readonly clock: ClockShape
  readonly git: GitShape
  readonly claude: ClaudeCliShape
  readonly notifier: NotifierShape
  readonly opener: OpenerShape
  readonly log: LoggerShape
  /** Preview reads (D-056); the live filesystem when omitted. */
  readonly files?: FilesShape
  /** Usually ~/.claude; injectable so tests never read the real one. */
  readonly claudeConfigDir: string
  readonly settings: Settings
  /** What a reset key goes back to: code defaults + install defaults (D-045). */
  readonly settingDefaults?: Settings
}

/** Thrown by intents; the HTTP layer maps it to a status + ApiError. */
export class ApiFailure extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: "bad_request" | "not_found" | "conflict",
    message: string,
  ) {
    super(message)
  }
}
const notFound = (what: string) => new ApiFailure(404, "not_found", `${what} not found`)
const conflict = (msg: string) => new ApiFailure(409, "conflict", msg)
const badRequest = (msg: string) => new ApiFailure(400, "bad_request", msg)

/** Per-transaction change set. */
class Changes {
  seq = 0
  readonly projects = new Set<string>()
  readonly sessions = new Set<string>()
  readonly agents = new Set<string>()
  readonly items = new Set<string>()
  readonly after: Array<() => void> = []
}

/** Normal SessionEnd reasons; anything else is "abnormal" ⇒ failed. TODO-SPIKE: confirm. */
const NORMAL_END_REASONS = new Set([
  "clear",
  "logout",
  "prompt_input_exit",
  "other",
  "resume",
  "compact",
])
/** Events that show the session moved on: they supersede stale items. */
const ACTIVITY = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
])

const PERMISSION_NOTIFICATIONS = new Set(["permission_prompt", "worker_permission_prompt"])
const INPUT_NOTIFICATIONS = new Set(["idle_prompt", "agent_needs_input"])

const mainAgentId = (sessionId: string) => `${sessionId}:main`
const subAgentId = (sessionId: string, agentId: string) => `${sessionId}:${agentId}`
const projectIdFor = (root: string) =>
  `p_${createHash("sha256").update(root).digest("hex").slice(0, 12)}`
const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`

const runtimeOf = (entrypoint: string | null): Session["runtime"] | null => {
  if (entrypoint === null) return null
  if (entrypoint === "claude-desktop") return "desktop"
  if (entrypoint === "cli") return "cli"
  return "unknown"
}

const SHELL_META = /[;&|<>`$()\\\n]/

const payloadSchema = {
  SessionStart: SessionStartPayload,
  UserPromptSubmit: UserPromptSubmitPayload,
  Notification: NotificationPayload,
  PreToolUse: PreToolUsePayload,
  PostToolUse: PostToolUsePayload,
  SubagentStart: SubagentPayload,
  SubagentStop: SubagentPayload,
  Stop: StopPayload,
  SessionEnd: SessionEndPayload,
} as const

type Payload = Record<string, unknown> & {
  session_id: string
  cwd?: string
  transcript_path?: string
  permission_mode?: string
  hook_event_name: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LOCAL_ID = /^local_[A-Za-z0-9-]{1,64}$/

/**
 * THE place "Open in Claude" URLs are computed (spike P-006, static evidence):
 * desktop id → continue that exact session; CLI uuid → import/resume it in the
 * desktop app; otherwise a new session in the folder.
 */
export const openUrlFor = (session: Session): string | null => {
  if (session.hostSessionId && LOCAL_ID.test(session.hostSessionId))
    return `claude://code/continue?session=${encodeURIComponent(session.hostSessionId)}`
  if (UUID.test(session.id)) return `claude://resume?session=${encodeURIComponent(session.id)}`
  if (session.cwd) return `claude://code/new?folder=${encodeURIComponent(session.cwd)}`
  return null
}

export const resumeCommandFor = (session: Session): string =>
  `${session.cwd ? `cd ${JSON.stringify(session.cwd)} && ` : ""}claude --resume ${session.id}`

/** One timeline line for a stored event (activity hooks, plus the source events of items). */
const timelineText = (hook: string, p: Record<string, unknown>): string => {
  switch (hook) {
    case "PostToolUse":
      return toolLine(String(p.tool_name ?? "tool"), p.tool_input)
    case "PreToolUse": {
      const tool = String(p.tool_name ?? "tool")
      if (tool === "AskUserQuestion") {
        const qs = (p.tool_input as { questions?: unknown } | null)?.questions
        const n = Array.isArray(qs) ? qs.length : 0
        return n === 1 ? "Asked 1 question" : n > 1 ? `Asked ${n} questions` : "Asked a question"
      }
      return permissionSummary(tool, p.tool_input)
    }
    case "Notification":
      return firstLine(typeof p.message === "string" ? p.message : null) ?? "Needs your input"
    case "SubagentStart":
      return `Started ${String(p.agent_type ?? "a subagent")}`
    case "SubagentStop":
      return `${String(p.agent_type ?? "Subagent")} finished`
    case "UserPromptSubmit":
      return `Prompt: ${provisionalTitle(String(p.prompt ?? "")) ?? ""}`
    case "SessionEnd":
      return "Session ended"
    default:
      return "Stopped"
  }
}

export class Engine {
  readonly store: Store
  readonly hub: StreamHub
  readonly startedAt: number
  private readonly gitCache = new Map<string, GitInfo>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly inflight = new Set<Promise<unknown>>()
  private readonly sendingSessions = new Set<string>()
  private lastBadge = -1

  constructor(readonly deps: EngineDeps) {
    this.store = new Store(deps.db)
    this.hub = new StreamHub(this.store.maxSeq())
    this.startedAt = deps.clock.now()
    this.hub.onShellChange = (connected) => {
      if (connected) this.flushPendingNotifications()
    }
    this.lastBadge = this.store.counts().needsYou
  }

  get settings(): Settings {
    return this.deps.settings
  }
  private now() {
    return this.deps.clock.now()
  }

  // -------------------------------------------------------------------------
  // Transactions, events, deltas
  // -------------------------------------------------------------------------

  private tx<T>(fn: (c: Changes) => T): T {
    const c = new Changes()
    const result = this.deps.db.transaction(() => fn(c))()
    this.publish(c)
    for (const f of c.after) {
      try {
        f()
      } catch (e) {
        this.deps.log.error("after-commit hook failed", e)
      }
    }
    return result
  }

  private appendEvent(
    c: Changes,
    e: {
      sessionId: string | null
      agentId?: string | null
      hook: string
      payload: unknown
      env?: unknown
      decodeError?: string | null
    },
  ): number {
    const r = this.deps.db
      .query(
        `INSERT INTO events (session_id, agent_id, hook, payload_json, env_json, decode_error, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      )
      .get(
        e.sessionId,
        e.agentId ?? null,
        e.hook,
        JSON.stringify(e.payload ?? null),
        e.env === undefined ? null : JSON.stringify(e.env),
        e.decodeError ?? null,
        this.now(),
      ) as { seq: number }
    c.seq = r.seq
    return r.seq
  }

  private publish(c: Changes) {
    const touched = c.projects.size + c.sessions.size + c.agents.size + c.items.size
    const counts = this.store.counts()
    if (touched > 0 && c.seq > 0) {
      for (const sid of c.sessions) {
        const s = this.store.session(sid)
        if (s) c.projects.add(s.project_id)
      }
      const pick = <R, O>(ids: Set<string>, get: (id: string) => R | null, map: (r: R) => O) =>
        [...ids].flatMap((id) => {
          const r = get(id)
          return r ? [map(r)] : []
        })
      this.hub.publish({
        _tag: "delta",
        seq: c.seq,
        projects: pick(c.projects, (id) => this.store.project(id), toProject),
        sessions: pick(c.sessions, (id) => this.store.session(id), toSession),
        agents: pick(c.agents, (id) => this.store.agent(id), toAgent),
        items: pick(
          c.items,
          (id) => this.store.item(id),
          (r) => this.store.itemView(r),
        ),
        counts,
      })
    }
    if (counts.needsYou !== this.lastBadge && c.seq > 0) {
      this.lastBadge = counts.needsYou
      this.hub.publish({ _tag: "badge", seq: c.seq, count: counts.needsYou })
    }
  }

  /** Track a background promise so tests (and shutdown) can await quiescence. */
  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p)
    p.finally(() => this.inflight.delete(p)).catch(() => {})
    return p
  }

  /** Resolves once no background work (titles, outbox sends, notifications) is pending. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight])
  }

  // -------------------------------------------------------------------------
  // Item lifecycle helpers
  // -------------------------------------------------------------------------

  private apply(c: Changes, row: ItemRow, event: LifecycleEvent): LifecycleState | null {
    const r = transition({ kind: row.kind as AttentionKind, state: stateFromRow(row) }, event)
    if (Result.isFailure(r)) {
      this.deps.log.warn("illegal transition ignored", {
        item: row.id,
        from: r.failure.from,
        event: r.failure.event,
        reason: r.failure.reason,
      })
      return null
    }
    const next = r.success
    const now = this.now()
    this.store.run(
      `UPDATE attention_items SET state = ?, snooze_until = ?, answered_at = ?, unconfirmed = ?,
         answered_seq = COALESCE(?, answered_seq), updated_at = ? WHERE id = ?`,
      next._tag,
      next._tag === "snoozed" ? next.until : null,
      next._tag === "answered" ? next.at : row.answered_at,
      next._tag === "answered" && next.unconfirmed ? 1 : 0,
      event._tag === "Answer" ? c.seq : null,
      now,
      row.id,
    )
    c.items.add(row.id)
    return next
  }

  private dedupeKey(
    sessionId: string,
    agentId: string | null,
    kind: AttentionKind,
    extra?: string,
  ) {
    return `${sessionId}|${agentId ?? "-"}|${kind}${extra ? `|${extra}` : ""}`
  }

  /** Open a new item, or refresh the open one with the same dedupe key (no re-notify). */
  private openItem(
    c: Changes,
    o: {
      sessionId: string
      agentId: string | null
      kind: AttentionKind
      dedupeKey: string
      summary: string | null
    },
  ): { row: ItemRow; created: boolean } {
    const now = this.now()
    const existing = this.store.one<ItemRow>(
      "SELECT * FROM attention_items WHERE dedupe_key = ? AND state IN ('open','snoozed')",
      o.dedupeKey,
    )
    if (existing) {
      this.apply(c, existing, { _tag: "Refresh" })
      this.store.run(
        "UPDATE attention_items SET summary = COALESCE(?, summary), source_seq = ?, updated_at = ? WHERE id = ?",
        o.summary,
        c.seq,
        now,
        existing.id,
      )
      c.items.add(existing.id)
      return { row: this.store.item(existing.id) as ItemRow, created: false }
    }
    const id = newId("it")
    this.store.run(
      `INSERT INTO attention_items (id, session_id, agent_id, kind, state, dedupe_key, summary, source_seq,
         unread, unconfirmed, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, 1, 0, ?, ?)`,
      id,
      o.sessionId,
      o.agentId,
      o.kind,
      o.dedupeKey,
      o.summary,
      c.seq,
      now,
      now,
    )
    c.items.add(id)
    return { row: this.store.item(id) as ItemRow, created: true }
  }

  // -------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------

  private async gitFor(cwd: string, refresh: boolean): Promise<GitInfo> {
    const cached = this.gitCache.get(cwd)
    if (cached && !refresh) return cached
    const info = await this.deps.git.resolve(cwd)
    this.gitCache.set(cwd, info)
    return info
  }

  /** POST /v1/hooks/:event. Never throws: every body is stored, failures included. */
  async ingest(eventParam: string, body: unknown): Promise<HookIngestResponse> {
    const store = (hook: string, payload: unknown, env: unknown, decodeError: string | null) => {
      const sid =
        payload &&
        typeof payload === "object" &&
        typeof (payload as Payload).session_id === "string"
          ? (payload as Payload).session_id
          : null
      return this.tx((c) => {
        const seq = this.appendEvent(c, { sessionId: sid, hook, payload, env, decodeError })
        // Unknown session ids are kept on the event only (no FK); nothing else changes.
        return { seq, requestId: null }
      })
    }

    const env = Schema.decodeUnknownResult(HookEnvelope)(body)
    if (Result.isFailure(env)) {
      this.deps.log.warn(`hook envelope failed to decode (${eventParam})`, env.failure.message)
      return store(eventParam, body, null, `envelope: ${env.failure.message}`)
    }
    const envelope = env.success
    const event = envelope.event || eventParam
    if (!Schema.is(HookEvent)(event)) {
      return store(event, envelope.payload, envelope.env, null)
    }
    let payload: Payload
    try {
      payload = decodeHookPayload(payloadSchema[event], envelope.payload) as unknown as Payload
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.deps.log.warn(`hook payload failed to decode (${event})`, msg)
      return store(event, envelope.payload, envelope.env, msg)
    }

    let git: GitInfo | null = null
    if (payload.cwd) {
      try {
        git = await this.gitFor(payload.cwd, event === "SessionStart")
      } catch (e) {
        this.deps.log.warn("git resolve failed", e)
      }
    }
    try {
      return this.tx((c) => this.applyHook(c, event, payload, envelope.env, git))
    } catch (e) {
      this.deps.log.error(`applying ${event} failed; stored raw`, e)
      return store(
        event,
        envelope.payload,
        envelope.env,
        `apply: ${e instanceof Error ? e.message : e}`,
      )
    }
  }

  private upsertSession(c: Changes, p: Payload, env: HookEnv, git: GitInfo | null): SessionRow {
    const now = this.now()
    const existing = this.store.session(p.session_id)
    let projectId = existing?.project_id
    if (!existing || (git && !existing.cwd)) {
      const root = git?.root ?? p.cwd ?? "(unknown)"
      projectId = projectIdFor(root)
      this.store.run(
        "INSERT INTO projects (id, root_path, name, muted, created_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(id) DO NOTHING",
        projectId,
        root,
        basename(root) || root,
        now,
      )
      c.projects.add(projectId)
    }
    const runtime = runtimeOf(env.entrypoint)
    if (!existing) {
      this.store.run(
        `INSERT INTO sessions (id, project_id, title, runtime, host_session_id, cwd, branch, worktree,
           transcript_path, permission_mode, state, created_at, last_event_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
        p.session_id,
        projectId,
        runtime ?? "unknown",
        env.hostSessionId,
        p.cwd ?? null,
        git?.branch ?? null,
        git?.worktree ?? null,
        p.transcript_path ?? null,
        p.permission_mode ?? null,
        now,
        now,
      )
    } else {
      this.store.run(
        `UPDATE sessions SET project_id = ?,
           runtime = CASE WHEN runtime = 'unknown' AND ? IN ('desktop','cli') THEN ? ELSE runtime END,
           host_session_id = COALESCE(?, host_session_id), cwd = COALESCE(?, cwd),
           branch = COALESCE(?, branch), worktree = CASE WHEN ? THEN ? ELSE worktree END,
           transcript_path = COALESCE(?, transcript_path), permission_mode = COALESCE(?, permission_mode),
           last_event_at = ? WHERE id = ?`,
        projectId,
        runtime,
        runtime,
        env.hostSessionId,
        p.cwd ?? null,
        git?.branch ?? null,
        git ? 1 : 0,
        git?.worktree ?? null,
        p.transcript_path ?? null,
        p.permission_mode ?? null,
        now,
        p.session_id,
      )
    }
    c.sessions.add(p.session_id)
    const main = mainAgentId(p.session_id)
    if (!this.store.agent(main)) {
      this.store.run(
        "INSERT INTO agents (id, session_id, parent_agent_id, name, state, started_at) VALUES (?, ?, NULL, 'main', 'running', ?)",
        main,
        p.session_id,
        now,
      )
      c.agents.add(main)
    }
    return this.store.session(p.session_id) as SessionRow
  }

  private setSessionState(c: Changes, sessionId: string, state: Session["state"]) {
    this.store.run("UPDATE sessions SET state = ? WHERE id = ?", state, sessionId)
    c.sessions.add(sessionId)
  }

  private setAgentState(c: Changes, agentId: string, state: string, ended = false) {
    const a = this.store.agent(agentId)
    if (!a || (a.state === state && !ended)) return
    this.store.run(
      "UPDATE agents SET state = ?, ended_at = CASE WHEN ? THEN ? ELSE ended_at END WHERE id = ?",
      state,
      ended ? 1 : 0,
      this.now(),
      agentId,
    )
    c.agents.add(agentId)
  }

  private ensureSubagent(
    c: Changes,
    sessionId: string,
    rawAgentId: string,
    type: string | undefined,
  ) {
    const id = subAgentId(sessionId, rawAgentId)
    const existing = this.store.agent(id)
    if (!existing) {
      this.store.run(
        "INSERT INTO agents (id, session_id, parent_agent_id, name, state, started_at) VALUES (?, ?, ?, ?, 'running', ?)",
        id,
        sessionId,
        mainAgentId(sessionId),
        type ?? "subagent",
        this.now(),
      )
      c.agents.add(id)
    } else if (type && existing.name === "subagent") {
      this.store.run("UPDATE agents SET name = ? WHERE id = ?", type, id)
      c.agents.add(id)
    }
    return id
  }

  private applyHook(
    c: Changes,
    event: HookEvent,
    p: Payload,
    env: HookEnv,
    git: GitInfo | null,
  ): HookIngestResponse {
    const session = this.upsertSession(c, p, env, git)
    const sid = session.id
    const rawAgent = typeof p.agent_id === "string" ? p.agent_id : null
    const agentType = typeof p.agent_type === "string" ? p.agent_type : undefined
    const agentId = rawAgent ? this.ensureSubagent(c, sid, rawAgent, agentType) : mainAgentId(sid)
    const seq = this.appendEvent(c, {
      sessionId: sid,
      agentId,
      hook: event,
      payload: p,
      env,
    })

    // AskUserQuestion answered through the hook: check the answers really landed (P-004).
    const unlanded =
      event === "PostToolUse" && p.tool_name === "AskUserQuestion"
        ? this.checkAnswersLanded(c, session, p)
        : null
    // Confirmation: a later hook event shows an answer/decision landed.
    if (event !== "Notification") this.confirmAnswered(c, sid, seq, unlanded)
    // Activity supersedes stale items (review always; failed on a new prompt).
    if (ACTIVITY.has(event)) this.supersedeStale(c, sid, event === "UserPromptSubmit")

    let requestId: string | null = null
    switch (event) {
      case "SessionStart": {
        if (session.state === "ended") this.setSessionState(c, sid, "idle")
        const t = typeof p.session_title === "string" ? provisionalTitle(p.session_title) : null
        if (t && session.title_source !== "claude") {
          this.store.run(
            "UPDATE sessions SET title = ?, title_source = 'claude' WHERE id = ?",
            t,
            sid,
          )
        }
        break
      }
      case "UserPromptSubmit": {
        this.setSessionState(c, sid, "running")
        this.setAgentState(c, mainAgentId(sid), "running")
        if (session.title === null) {
          const t = provisionalTitle(String(p.prompt ?? ""))
          if (t) {
            this.store.run(
              "UPDATE sessions SET title = ?, title_source = 'prompt' WHERE id = ?",
              t,
              sid,
            )
            if (this.settings["titles.generate"]) {
              const prompt = String(p.prompt)
              c.after.push(() => this.generateTitle(sid, prompt))
            }
          }
        }
        break
      }
      case "Notification":
        this.onNotification(c, session, agentId, p)
        break
      case "PreToolUse":
        this.setSessionState(c, sid, "running")
        this.setAgentState(c, agentId, "running")
        requestId = this.onPreToolUse(c, session, agentId, p)
        break
      case "PostToolUse":
        this.setSessionState(c, sid, "running")
        this.setAgentState(c, agentId, "running")
        break
      case "SubagentStart":
        this.setSessionState(c, sid, "running")
        break
      case "SubagentStop":
        if (rawAgent) this.setAgentState(c, agentId, "done", true)
        break
      case "Stop": {
        this.releaseLiveHolds(c, sid)
        this.setSessionState(c, sid, "idle")
        const lastMessage =
          typeof p.last_assistant_message === "string" ? p.last_assistant_message : null
        const errored =
          (lastMessage !== null && /^API Error/i.test(lastMessage.trim())) ||
          lastTurnErrored(p.transcript_path ?? session.transcript_path)
        this.setAgentState(c, mainAgentId(sid), errored ? "failed" : "done")
        const main = mainAgentId(sid)
        if (errored) {
          const { row, created } = this.openItem(c, {
            sessionId: sid,
            agentId: main,
            kind: "failed",
            dedupeKey: this.dedupeKey(sid, main, "failed"),
            summary: firstLine(lastMessage) ?? "Stopped with errors",
          })
          if (created) this.queueNotification(c, row)
        } else {
          const { row, created } = this.openItem(c, {
            sessionId: sid,
            agentId: main,
            kind: "review",
            dedupeKey: this.dedupeKey(sid, main, "review"),
            summary: firstLine(lastMessage) ?? "Ready to review",
          })
          if (created) this.queueNotification(c, row)
        }
        c.after.push(() => this.kickOutbox())
        break
      }
      case "SessionEnd": {
        this.releaseLiveHolds(c, sid)
        this.setSessionState(c, sid, "ended")
        for (const a of this.store.all<AgentRow>(
          "SELECT * FROM agents WHERE session_id = ? AND state IN ('running','waiting')",
          sid,
        ))
          this.setAgentState(c, a.id, "done", true)
        const reason = typeof p.reason === "string" ? p.reason : null
        if (reason !== null && !NORMAL_END_REASONS.has(reason)) {
          const main = mainAgentId(sid)
          const { row, created } = this.openItem(c, {
            sessionId: sid,
            agentId: main,
            kind: "failed",
            dedupeKey: this.dedupeKey(sid, main, "failed"),
            summary: `Session ended: ${reason}`,
          })
          if (created) this.queueNotification(c, row)
        }
        c.after.push(() => this.kickOutbox())
        break
      }
    }
    return { seq: c.seq, requestId }
  }

  /**
   * Compare PostToolUse(AskUserQuestion).tool_response.answers with what we sent in
   * updatedInput. On a mismatch, switch this runtime to denyWithReason (persisted)
   * and flag the item unconfirmed. Returns the mismatched item id, if any.
   */
  private checkAnswersLanded(c: Changes, session: SessionRow, p: Payload): string | null {
    const toolUseId = typeof p.tool_use_id === "string" ? p.tool_use_id : null
    const a = this.store.one<ApprovalRow>(
      `SELECT a.* FROM approvals a JOIN attention_items i ON i.id = a.item_id
         WHERE i.session_id = ? AND a.tool = 'AskUserQuestion' AND a.updated_input_json IS NOT NULL
           AND (? IS NULL OR a.tool_use_id IS NULL OR a.tool_use_id = ?)
         ORDER BY a.decided_at DESC LIMIT 1`,
      session.id,
      toolUseId,
      toolUseId,
    )
    if (!a?.updated_input_json) return null
    const sent =
      (JSON.parse(a.updated_input_json) as { answers?: Record<string, string> }).answers ?? {}
    const resp = p.tool_response as { answers?: Record<string, unknown> } | null | undefined
    const got = resp && typeof resp === "object" ? (resp.answers ?? {}) : {}
    const landed = Object.entries(sent).every(([q, ans]) => got[q] === ans)
    if (landed) return null
    const runtime = session.runtime
    this.deps.log.warn(
      `AskUserQuestion answers did not land via updatedInput; ${runtime} → denyWithReason`,
    )
    this.setAnswerMode(runtime, "denyWithReason")
    const item = this.store.item(a.item_id)
    if (item?.state === "answered") this.apply(c, item, { _tag: "MarkUnconfirmed" })
    return a.item_id
  }

  answerModeFor(runtime: string): AnswerMode {
    return (
      this.settings["questions.answerModeByRuntime"][runtime] ??
      this.settings["questions.answerMode"]
    )
  }

  private setAnswerMode(runtime: string, mode: AnswerMode) {
    const byRuntime = { ...this.settings["questions.answerModeByRuntime"], [runtime]: mode }
    this.settings["questions.answerModeByRuntime"] = byRuntime
    this.store.run(
      "INSERT INTO settings (key, value_json) VALUES ('questions.answerModeByRuntime', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
      JSON.stringify(byRuntime),
    )
  }

  private confirmAnswered(c: Changes, sessionId: string, seq: number, except: string | null) {
    const rows = this.store.all<ItemRow>(
      `SELECT * FROM attention_items i WHERE session_id = ? AND state = 'answered'
         AND COALESCE(answered_seq, 0) < ?
         AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.item_id = i.id AND o.state = 'queued')`,
      sessionId,
      seq,
    )
    for (const r of rows) if (r.id !== except) this.apply(c, r, { _tag: "Confirm" })
  }

  private supersedeStale(c: Changes, sessionId: string, includeFailed: boolean) {
    const kinds = includeFailed
      ? "('review','question','permission','failed')"
      : "('review','question','permission')"
    const rows = this.store.all<ItemRow>(
      `SELECT * FROM attention_items i WHERE session_id = ? AND state IN ('open','snoozed') AND kind IN ${kinds}
         AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.item_id = i.id AND a.live = 1)`,
      sessionId,
    )
    for (const r of rows) this.apply(c, r, { _tag: "Supersede" })
  }

  private onNotification(c: Changes, session: SessionRow, agentId: string, p: Payload) {
    const type = typeof p.notification_type === "string" ? p.notification_type : ""
    const message = typeof p.message === "string" ? p.message : ""
    // Spike P-003: classify by notification_type only; unknown types are never an alert.
    const isPermission = PERMISSION_NOTIFICATIONS.has(type)
    const isInput = INPUT_NOTIFICATIONS.has(type)
    if (!isPermission && !isInput) return

    this.setSessionState(c, session.id, "waiting")
    if (isPermission) {
      // Already tracked: a live hold, or one that just lapsed into Claude's own prompt. A lapsed
      // AskUserQuestion hold also reaches us as a permission prompt (D-034).
      const recent = this.store.one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM attention_items WHERE session_id = ? AND kind IN ('permission','question')
           AND (state IN ('open','snoozed') OR updated_at > ?)`,
        session.id,
        this.now() - 30_000,
      )
      if ((recent?.n ?? 0) > 0) return
      const { row, created } = this.openItem(c, {
        sessionId: session.id,
        agentId,
        kind: "permission",
        dedupeKey: this.dedupeKey(session.id, agentId, "permission", "prompt"),
        summary: message || "Needs your permission",
      })
      if (created) this.queueNotification(c, row)
      return
    }
    // "Waiting for your input" after a clean stop is covered by the review item.
    const open = this.store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM attention_items WHERE session_id = ? AND state IN ('open','snoozed')",
      session.id,
    )
    if ((open?.n ?? 0) > 0) return
    const { row, created } = this.openItem(c, {
      sessionId: session.id,
      agentId,
      kind: "question",
      dedupeKey: this.dedupeKey(session.id, agentId, "question"),
      summary: message || "Waiting for your input",
    })
    if (created) this.queueNotification(c, row)
  }

  /** Would Claude ask here? Holding also needs `holds.enabled` (an observer channel only shows it). */
  private wouldAsk(session: SessionRow, project: { muted: number; root_path: string }, p: Payload) {
    const tool = String(p.tool_name)
    if (project.muted === 1) return false
    if (tool === "AskUserQuestion") return true
    if (!this.settings["holds.tools"].includes(tool)) return false
    const mode = p.permission_mode ?? "default"
    if (mode !== "default") return false
    if (tool === "Bash") {
      const cmd = String((p.tool_input as Record<string, unknown> | null)?.command ?? "").trim()
      if (
        cmd &&
        !SHELL_META.test(cmd) &&
        this.settings["holds.safeBashPrefixes"].some(
          (pre) => cmd === pre || cmd.startsWith(`${pre} `),
        )
      )
        return false
    }
    const dirs = [project.root_path, session.worktree, session.cwd].filter(
      (d): d is string => typeof d === "string" && d.startsWith("/"),
    )
    return ruleVerdict(this.deps.claudeConfigDir, dirs, tool, p.tool_input) === "none"
  }

  private onPreToolUse(
    c: Changes,
    session: SessionRow,
    agentId: string,
    p: Payload,
  ): string | null {
    const tool = String(p.tool_name)
    const project = this.store.project(session.project_id)
    if (!project) return null
    const toolUseId = typeof p.tool_use_id === "string" ? p.tool_use_id : null
    const isQuestion = tool === "AskUserQuestion"
    const asks = this.wouldAsk(session, project, p)
    // Observer channel (H-016): same item, not live; another channel's daemon holds the hook.
    const hold = asks && this.settings["holds.enabled"]
    if (!isQuestion && !asks) return null

    const questions = isQuestion ? parseQuestions(p.tool_input) : []
    const summary = isQuestion
      ? questions.length === 0
        ? "Claude has a question"
        : questions.length === 1
          ? (questions[0]?.text ?? null)
          : questions.map((q) => q.header ?? q.text).join(" · ")
      : permissionSummary(tool, p.tool_input)
    // Preview now, before Claude can touch the file (D-056). Never throws; bounded reads.
    const pv =
      hold && !isQuestion
        ? computePreview(this.deps.files, this.deps.log, {
            tool,
            input: p.tool_input,
            cwd: p.cwd ?? session.cwd,
            roots: [session.worktree, project.root_path],
            transcriptPath: p.transcript_path ?? session.transcript_path,
            toolUseId,
          })
        : null
    const kind: AttentionKind = isQuestion ? "question" : "permission"
    const { row, created } = this.openItem(c, {
      sessionId: session.id,
      agentId,
      kind,
      dedupeKey: isQuestion
        ? this.dedupeKey(session.id, agentId, "question")
        : this.dedupeKey(session.id, agentId, "permission", toolUseId ?? newId("tu")),
      summary: pv?.summary ?? summary,
    })
    if (isQuestion) {
      this.store.run("DELETE FROM questions WHERE item_id = ?", row.id)
      for (const q of questions)
        this.store.run(
          "INSERT INTO questions (item_id, idx, header, text, options_json, multi) VALUES (?, ?, ?, ?, ?, ?)",
          row.id,
          q.idx,
          q.header ?? null,
          q.text,
          JSON.stringify(q.options),
          q.multi ? 1 : 0,
        )
    }
    let requestId: string | null = null
    if (hold) {
      requestId = newId("rq")
      this.store.run(
        `INSERT OR REPLACE INTO approvals (item_id, hook_request_id, tool, input_json, tool_use_id, decision,
           reason, updated_input_json, live, decided_at, expires_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 1, NULL, ?)`,
        row.id,
        requestId,
        tool,
        JSON.stringify(p.tool_input ?? null),
        toolUseId,
        this.now() + this.settings["holds.budgetMs"],
      )
      if (pv?.preview || pv?.context)
        this.store.run(
          "UPDATE approvals SET preview_json = ?, context = ? WHERE item_id = ?",
          pv.preview ? JSON.stringify(pv.preview) : null,
          pv.context,
          row.id,
        )
      this.setSessionState(c, session.id, "waiting")
      this.setAgentState(c, agentId, "waiting")
    }
    if (created) this.queueNotification(c, row)
    return requestId
  }

  /** Release any held hooks of a session with `ask` (they are stale: the turn moved on). */
  private releaseLiveHolds(c: Changes, sessionId: string) {
    for (const a of this.store.all<ApprovalRow>(
      "SELECT a.* FROM approvals a JOIN attention_items i ON i.id = a.item_id WHERE i.session_id = ? AND a.live = 1",
      sessionId,
    ))
      this.expireHold(c, a)
  }

  /** Hold budget lapsed (or the hold went stale): decision `ask`; permission items expire. */
  private expireHold(c: Changes, a: ApprovalRow) {
    this.store.run(
      "UPDATE approvals SET decision = 'ask', live = 0, decided_at = ? WHERE item_id = ?",
      this.now(),
      a.item_id,
    )
    const item = this.store.item(a.item_id)
    if (item) {
      c.items.add(item.id)
      if (item.kind === "permission") this.apply(c, item, { _tag: "Expire" })
      this.setAgentState(c, item.agent_id ?? mainAgentId(item.session_id), "waiting")
    }
    this.clearNotifications(a.item_id)
    c.after.push(() => this.wake(a.hook_request_id))
  }

  // -------------------------------------------------------------------------
  // Long-poll decisions
  // -------------------------------------------------------------------------

  private wake(requestId: string) {
    const set = this.waiters.get(requestId)
    if (!set) return
    this.waiters.delete(requestId)
    for (const f of set) f()
  }

  private hookResponse(a: ApprovalRow): HookDecision {
    switch (a.decision as Decision | null) {
      case "allow":
      case "allow-always":
        return a.updated_input_json
          ? { decision: "allow", updatedInput: JSON.parse(a.updated_input_json) as unknown }
          : { decision: "allow" }
      case "deny":
        return a.reason ? { decision: "deny", reason: a.reason } : { decision: "deny" }
      case "ask":
        return { decision: "ask" }
      default:
        return a.live === 1 ? { decision: "pending" } : { decision: "ask" }
    }
  }

  /** GET /v1/hooks/decision/:requestId?wait=s */
  async waitDecision(requestId: string, waitSeconds: number): Promise<HookDecision> {
    const first = this.store.approvalByRequest(requestId)
    if (!first) return { decision: "ask" } // unknown (e.g. replaced): let Claude ask
    if (first.decision !== null || first.live === 0) return this.hookResponse(first)
    const remaining = first.expires_at - this.now()
    const waitMs = Math.max(0, Math.min(waitSeconds * 1000, remaining))
    if (waitMs > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          this.waiters.get(requestId)?.delete(done)
          resolve()
        }
        const timer = setTimeout(done, waitMs)
        let set = this.waiters.get(requestId)
        if (!set) {
          set = new Set()
          this.waiters.set(requestId, set)
        }
        set.add(done)
      })
    }
    let a = this.store.approvalByRequest(requestId)
    if (!a) return { decision: "ask" }
    if (a.live === 1 && a.decision === null && this.now() >= a.expires_at) {
      this.tx((c) => {
        this.appendEvent(c, {
          sessionId: this.store.item(a?.item_id ?? "")?.session_id ?? null,
          hook: "daemon:hold-expired",
          payload: { requestId },
        })
        if (a) this.expireHold(c, a)
      })
      a = this.store.approvalByRequest(requestId) as ApprovalRow
    }
    return this.hookResponse(a)
  }

  // -------------------------------------------------------------------------
  // Intents
  // -------------------------------------------------------------------------

  private idempotent<T>(key: string | null, kind: string, itemId: string | null, fn: () => T): T {
    if (key) {
      const prev = this.store.one<{ result_json: string; kind: string }>(
        "SELECT result_json, kind FROM intents WHERE idempotency_key = ?",
        key,
      )
      if (prev) return JSON.parse(prev.result_json) as T
    }
    const result = fn()
    if (key)
      this.store.run(
        "INSERT OR IGNORE INTO intents (idempotency_key, item_id, kind, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
        key,
        itemId,
        kind,
        JSON.stringify(result),
        this.now(),
      )
    return result
  }

  private requireItem(id: string): ItemRow {
    const r = this.store.item(id)
    if (!r) throw notFound("item")
    return r
  }

  private respond(itemId: string): ActionResponse {
    return { ok: true, item: this.store.itemOut(itemId) }
  }

  private projectDirFor(sessionId: string): string | null {
    const s = this.store.session(sessionId)
    if (!s) return null
    if (s.worktree) return s.worktree
    const p = this.store.project(s.project_id)
    return p?.root_path.startsWith("/") ? p.root_path : (s.cwd ?? null)
  }

  /** Decide a held approval. Shared by the UI, notifications and "open". */
  private decideIn(
    c: Changes,
    item: ItemRow,
    decision: Decision,
    source: string,
    extra: { reason?: string; updatedInput?: unknown } = {},
  ) {
    const a = this.store.approval(item.id)
    if (!a) throw conflict("item has no approval")
    if (a.decision !== null) {
      if (a.decision === decision) return
      throw conflict(`already decided: ${a.decision}`)
    }
    if (a.live === 0) throw conflict("hook is no longer held")
    this.appendEvent(c, {
      sessionId: item.session_id,
      agentId: item.agent_id,
      hook: "daemon:decision",
      payload: { itemId: item.id, decision, source },
    })
    if (decision === "allow-always") {
      const dir = this.projectDirFor(item.session_id)
      const rule = allowAlwaysRule(a.tool, JSON.parse(a.input_json))
      if (dir) {
        try {
          appendAllowRule(dir, rule)
        } catch (e) {
          this.deps.log.error("allow-always: could not write settings.local.json", e)
        }
      }
    }
    this.store.run(
      "UPDATE approvals SET decision = ?, reason = ?, updated_input_json = ?, live = 0, decided_at = ? WHERE item_id = ?",
      decision,
      extra.reason ?? null,
      extra.updatedInput === undefined ? null : JSON.stringify(extra.updatedInput),
      this.now(),
      item.id,
    )
    const fresh = this.store.item(item.id) as ItemRow
    if (fresh.state === "open" || fresh.state === "snoozed")
      this.apply(c, fresh, { _tag: "Answer", at: this.now() })
    else c.items.add(item.id)
    this.setSessionState(c, item.session_id, decision === "ask" ? "waiting" : "running")
    this.setAgentState(
      c,
      item.agent_id ?? mainAgentId(item.session_id),
      decision === "ask" ? "waiting" : "running",
    )
    this.clearNotifications(item.id)
    c.after.push(() => this.wake(a.hook_request_id))
  }

  private clearNotifications(itemId: string) {
    this.store.run(
      "UPDATE notifications SET state = 'cleared' WHERE item_id = ? AND state IN ('pending','posted')",
      itemId,
    )
  }

  decide(
    itemId: string,
    decision: Decision,
    idempotencyKey: string | null,
    source = "ui",
  ): ActionResponse {
    return this.tx((c) =>
      this.idempotent(idempotencyKey, "decision", itemId, () => {
        const item = this.requireItem(itemId)
        this.decideIn(c, item, decision, source)
        return this.respond(itemId)
      }),
    )
  }

  answers(itemId: string, idempotencyKey: string, answers: ReadonlyArray<Answer>): ActionResponse {
    const existing = this.store.one<OutboxRow>(
      "SELECT * FROM outbox WHERE idempotency_key = ?",
      idempotencyKey,
    )
    if (existing) return this.respond(existing.item_id ?? itemId)
    const result = this.tx((c) =>
      this.idempotent(idempotencyKey, "answers", itemId, () => {
        const item = this.requireItem(itemId)
        if (item.kind !== "question") throw badRequest("not a question item")
        const questions = this.store.questions(itemId).map(toQuestion)
        const invalid = validateAnswers(questions, answers)
        if (invalid) throw badRequest(invalid)
        if (item.state !== "open" && item.state !== "snoozed")
          throw conflict(`item is ${item.state}`)
        for (const a of answers)
          this.store.run(
            "UPDATE questions SET answer_json = ? WHERE item_id = ? AND idx = ?",
            JSON.stringify(a),
            itemId,
            a.idx,
          )
        this.store.run("DELETE FROM drafts WHERE item_id = ?", itemId)
        if (this.store.isLive(itemId)) {
          const a = this.store.approval(itemId) as ApprovalRow
          const enc = encodeLiveAnswers(
            this.answerModeFor(this.store.session(item.session_id)?.runtime ?? "unknown"),
            JSON.parse(a.input_json),
            questions,
            answers,
          )
          this.decideIn(c, item, enc.decision === "deny" ? "deny" : "allow", "answers", {
            ...(enc.reason === undefined ? {} : { reason: enc.reason }),
            ...(enc.updatedInput === undefined ? {} : { updatedInput: enc.updatedInput }),
          })
        } else {
          this.appendEvent(c, {
            sessionId: item.session_id,
            agentId: item.agent_id,
            hook: "daemon:answers",
            payload: { itemId, answers },
          })
          this.enqueueOutbox(c, item, formatAnswersReply(questions, answers), idempotencyKey)
          this.apply(c, this.store.item(itemId) as ItemRow, { _tag: "Answer", at: this.now() })
        }
        return this.respond(itemId)
      }),
    )
    this.kickOutbox()
    return result
  }

  reply(itemId: string, idempotencyKey: string, body: string): ActionResponse {
    const text = body.trim()
    if (!text) throw badRequest("empty reply")
    const existing = this.store.one<OutboxRow>(
      "SELECT * FROM outbox WHERE idempotency_key = ?",
      idempotencyKey,
    )
    if (existing) return this.respond(existing.item_id ?? itemId)
    const result = this.tx((c) =>
      this.idempotent(idempotencyKey, "reply", itemId, () => {
        const item = this.requireItem(itemId)
        this.store.run("DELETE FROM drafts WHERE item_id = ?", itemId)
        if (this.store.isLive(itemId)) {
          // Never `--resume` into a session whose hook we hold: send the text back as the deny reason.
          this.decideIn(c, item, "deny", "reply", { reason: `The user replied: ${text}` })
          return this.respond(itemId)
        }
        this.appendEvent(c, {
          sessionId: item.session_id,
          agentId: item.agent_id,
          hook: "daemon:reply",
          payload: { itemId, body: text },
        })
        this.enqueueOutbox(c, item, text, idempotencyKey)
        if (item.state === "open" || item.state === "snoozed")
          this.apply(c, item, { _tag: "Answer", at: this.now() })
        return this.respond(itemId)
      }),
    )
    this.kickOutbox()
    return result
  }

  snooze(itemId: string, until: number): ActionResponse {
    return this.tx((c) => {
      const item = this.requireItem(itemId)
      if (until <= this.now()) throw badRequest("until must be in the future")
      this.appendEvent(c, {
        sessionId: item.session_id,
        hook: "daemon:snooze",
        payload: { itemId, until },
      })
      if (!this.apply(c, item, { _tag: "Snooze", until }))
        throw conflict(`cannot snooze a ${item.state} item`)
      return this.respond(itemId)
    })
  }

  dismiss(itemId: string): ActionResponse {
    return this.tx((c) => {
      const item = this.requireItem(itemId)
      this.appendEvent(c, {
        sessionId: item.session_id,
        hook: "daemon:dismiss",
        payload: { itemId },
      })
      if (this.store.isLive(itemId)) this.decideIn(c, item, "ask", "dismiss")
      const fresh = this.store.item(itemId) as ItemRow
      if (!this.apply(c, fresh, { _tag: "Dismiss" }))
        throw conflict(`cannot dismiss a ${fresh.state} item`)
      this.clearNotifications(itemId)
      return this.respond(itemId)
    })
  }

  read(itemId: string): ActionResponse {
    return this.tx((c) => {
      const item = this.requireItem(itemId)
      if (item.unread === 1) {
        this.appendEvent(c, {
          sessionId: item.session_id,
          hook: "daemon:read",
          payload: { itemId },
        })
        this.store.run("UPDATE attention_items SET unread = 0 WHERE id = ?", itemId)
        c.items.add(itemId)
      }
      return this.respond(itemId)
    })
  }

  /** Drafts are autosaved every ~500 ms; they are not domain state, so no event / delta. */
  draft(itemId: string, body: unknown): ActionResponse {
    this.requireItem(itemId)
    this.store.run(
      "INSERT INTO drafts (item_id, body_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET body_json = excluded.body_json, updated_at = excluded.updated_at",
      itemId,
      JSON.stringify(body ?? null),
      this.now(),
    )
    return this.respond(itemId)
  }

  async open(itemId: string): Promise<{ url: string | null }> {
    const item = this.requireItem(itemId)
    this.tx((c) => {
      this.appendEvent(c, { sessionId: item.session_id, hook: "daemon:open", payload: { itemId } })
      if (this.store.isLive(itemId)) this.decideIn(c, item, "ask", "open")
      this.store.run("UPDATE attention_items SET unread = 0 WHERE id = ?", itemId)
      c.items.add(itemId)
    })
    const s = this.store.session(item.session_id)
    if (!s) return { url: null }
    const session = toSession(s)
    const url = openUrlFor(session)
    try {
      // Anything but an exact desktop session also gets the terminal command on the clipboard.
      if (session.runtime !== "desktop" || !session.hostSessionId)
        await this.deps.opener.copy(resumeCommandFor(session))
      if (url) await this.deps.opener.open(url)
    } catch (e) {
      this.deps.log.warn("open in Claude failed", e)
    }
    return { url }
  }

  async notificationActed(id: string, action: NotificationAction): Promise<ActionResponse> {
    const n = this.store.notification(id)
    if (!n) throw notFound("notification")
    // Decide first: a rejected decision (e.g. 409, no approval) must not mark the notification acted.
    const decided =
      action === "allow" || action === "deny"
        ? await this.decide(n.item_id, action, `notif:${id}:${action}`, "notification")
        : null
    this.tx((c) => {
      const item = this.store.item(n.item_id)
      this.appendEvent(c, {
        sessionId: item?.session_id ?? null,
        hook: "daemon:notification-acted",
        payload: { id, action },
      })
      this.store.run(
        "UPDATE notifications SET state = ?, acted_at = ?, action = ? WHERE id = ?",
        action === "click" ? "clicked" : "acted",
        this.now(),
        action,
        id,
      )
      if (item && (action === "click" || action === "answer") && item.unread === 1) {
        this.store.run("UPDATE attention_items SET unread = 0 WHERE id = ?", item.id)
        c.items.add(item.id)
      }
    })
    if (decided) return decided
    if (action === "open") await this.open(n.item_id)
    return this.respond(n.item_id)
  }

  mute(projectId: string, muted: boolean) {
    return this.tx((c) => {
      const p = this.store.project(projectId)
      if (!p) throw notFound("project")
      this.appendEvent(c, { sessionId: null, hook: "daemon:mute", payload: { projectId, muted } })
      this.store.run("UPDATE projects SET muted = ? WHERE id = ?", muted ? 1 : 0, projectId)
      c.projects.add(projectId)
      if (muted) {
        for (const a of this.store.all<ApprovalRow>(
          `SELECT a.* FROM approvals a JOIN attention_items i ON i.id = a.item_id
             JOIN sessions s ON s.id = i.session_id WHERE s.project_id = ? AND a.live = 1`,
          projectId,
        ))
          this.expireHold(c, a)
      }
      return { ok: true, project: toProject(this.store.project(projectId) as never) }
    })
  }

  /** The Settings pane's view of the running settings (C-016). */
  userSettings(): { settings: UserSettings; defaults: UserSettings } {
    return {
      settings: pickUserSettings(this.settings),
      defaults: pickUserSettings(this.deps.settingDefaults ?? DEFAULT_SETTINGS),
    }
  }

  /**
   * PUT /v1/settings: persist rows, apply to the running engine, append `daemon:settings`
   * (D-045). `null` deletes the row (back to the default). Turning holds off releases
   * live holds with `ask`, as muting does, so no session stays frozen.
   */
  updateSettings(patch: UserSettingsPatch) {
    const defaults = this.deps.settingDefaults ?? DEFAULT_SETTINGS
    const next: Array<[UserSettingKey, unknown, boolean]> = []
    for (const key of USER_SETTING_KEYS) {
      const raw = patch[key]
      if (raw === undefined) continue
      next.push(
        raw === null ? [key, defaults[key], true] : [key, normalizeSetting(key, raw), false],
      )
    }
    if (next.length === 0) return this.userSettings()
    const live = this.settings as unknown as Record<string, unknown>
    this.tx((c) => {
      const changed: Record<string, unknown> = {}
      for (const [key, value, reset] of next) {
        if (reset) this.store.run("DELETE FROM settings WHERE key = ?", key)
        else
          this.store.run(
            "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
            key,
            JSON.stringify(value),
          )
        live[key] = value
        changed[key] = value
      }
      this.appendEvent(c, {
        sessionId: null,
        hook: "daemon:settings",
        payload: { changed, reset: next.filter(([, , r]) => r).map(([k]) => k) },
      })
      if (this.settings["holds.enabled"] === false)
        for (const a of this.store.all<ApprovalRow>("SELECT * FROM approvals WHERE live = 1")) {
          this.expireHold(c, a)
          const item = this.store.item(a.item_id)
          if (item) this.setSessionState(c, item.session_id, "waiting")
        }
    })
    return this.userSettings()
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  snapshot(): Snapshot {
    const since = this.now() - 24 * 3600_000
    const items = this.store.all<ItemRow>(
      "SELECT * FROM attention_items WHERE state IN ('open','snoozed','answered') OR updated_at > ? ORDER BY created_at",
      since,
    )
    const sessions = this.store.all<SessionRow>(
      `SELECT * FROM sessions WHERE state != 'ended' OR last_event_at > ?
         OR id IN (SELECT session_id FROM attention_items WHERE state IN ('open','snoozed','answered'))
         ORDER BY last_event_at DESC`,
      since,
    )
    const sids = new Set(sessions.map((s) => s.id))
    const pids = new Set(sessions.map((s) => s.project_id))
    const live = new Set(
      this.store
        .all<{ item_id: string }>("SELECT item_id FROM approvals WHERE live = 1")
        .map((r) => r.item_id),
    )
    const qn = new Map(
      this.store
        .all<{ item_id: string; n: number }>(
          "SELECT item_id, COUNT(*) AS n FROM questions GROUP BY item_id",
        )
        .map((r) => [r.item_id, r.n] as const),
    )
    return {
      seq: this.store.maxSeq(),
      projects: this.store
        .all<Parameters<typeof toProject>[0]>("SELECT * FROM projects ORDER BY name")
        .filter((p) => pids.has(p.id))
        .map(toProject),
      sessions: sessions.map(toSession),
      agents: this.store
        .all<AgentRow>("SELECT * FROM agents ORDER BY started_at")
        .filter((a) => sids.has(a.session_id))
        .map(toAgent),
      items: items
        .filter((i) => sids.has(i.session_id))
        .map((i) => toItem(i, live.has(i.id), qn.get(i.id) ?? 0)),
      counts: this.store.counts(),
    }
  }

  itemDetail(itemId: string): ItemDetail {
    const r = this.requireItem(itemId)
    const s = this.store.session(r.session_id)
    const p = s ? this.store.project(s.project_id) : null
    if (!s || !p) throw notFound("session")
    const a = this.store.approval(itemId)
    const draft = this.store.one<{ body_json: string }>(
      "SELECT body_json FROM drafts WHERE item_id = ?",
      itemId,
    )
    const session = toSession(s)
    return {
      item: toItem(r, a?.live === 1, this.store.questionCount(itemId)),
      session,
      project: toProject(p),
      questions: this.store.questions(itemId).map(toQuestion),
      approval: a ? toApproval(a) : null,
      timeline: this.timeline(r.session_id, 50, r.source_seq),
      outbox: this.store
        .all<OutboxRow>("SELECT * FROM outbox WHERE item_id = ? ORDER BY created_at", itemId)
        .map(toOutbox),
      draft: draft ? (JSON.parse(draft.body_json) as unknown) : null,
      openUrl: openUrlFor(session),
    }
  }

  /**
   * Last `limit` activity lines, newest first. With `sourceSeq`, the event that created the
   * item is always included (even a PreToolUse/Notification that isn't activity, or one older
   * than the window) and flagged `isSource` (D-030).
   */
  timeline(sessionId: string, limit = 50, sourceSeq: number | null = null): TimelineEntry[] {
    const rows = this.store.all<EventRow>(
      `SELECT * FROM events WHERE session_id = ? AND decode_error IS NULL
         AND hook IN ('PostToolUse','SubagentStart','SubagentStop','UserPromptSubmit','Stop')
         ORDER BY seq DESC LIMIT ?`,
      sessionId,
      limit,
    )
    if (sourceSeq !== null && !rows.some((e) => e.seq === sourceSeq)) {
      const src = this.store.one<EventRow>(
        "SELECT * FROM events WHERE seq = ? AND session_id = ? AND decode_error IS NULL",
        sourceSeq,
        sessionId,
      )
      if (src) {
        rows.push(src)
        rows.sort((a, b) => b.seq - a.seq)
      }
    }
    return rows.map((e) => {
      const p = JSON.parse(e.payload_json) as Record<string, unknown>
      const entry: TimelineEntry = {
        seq: e.seq,
        at: e.received_at,
        hook: e.hook,
        agentId: e.agent_id,
        text: timelineText(e.hook, p),
      }
      return e.seq === sourceSeq ? { ...entry, isSource: true } : entry
    })
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  private notificationContent(item: ItemRow): Omit<NotifyPayload, "id"> {
    const s = this.store.session(item.session_id)
    const p = s ? this.store.project(s.project_id) : null
    const title = [p?.name, s?.title].filter(Boolean).join(" · ") || "Claude"
    const kind = item.kind as AttentionKind
    const qn = kind === "question" ? this.store.questions(item.id).length : 0
    const body =
      kind === "question"
        ? qn > 1
          ? `Claude has ${qn} questions: ${item.summary ?? ""}`
          : (item.summary ?? "Claude has a question")
        : kind === "permission"
          ? (item.summary ?? "Needs your permission")
          : kind === "failed"
            ? (item.summary ?? "Stopped with errors")
            : (item.summary ?? "Ready to review")
    const live = this.store.isLive(item.id)
    const actions: NotificationAction[] =
      kind === "question"
        ? ["answer", "open"]
        : kind === "permission"
          ? live
            ? ["allow", "deny", "open"]
            : ["open"]
          : ["open"]
    return { itemId: item.id, title, body, actions, critical: kind === "permission" }
  }

  private isMuted(item: ItemRow): boolean {
    const s = this.store.session(item.session_id)
    return s ? this.store.project(s.project_id)?.muted === 1 : false
  }

  /** Notification policy: muted never; review is grouped; the rest go out at once. */
  private queueNotification(c: Changes, item: ItemRow) {
    if (this.isMuted(item)) return
    if (item.kind === "review") {
      // Persisted so a restart inside the window still sends the group (D-031).
      this.store.run(
        "INSERT OR IGNORE INTO review_group (item_id, added_at) VALUES (?, ?)",
        item.id,
        this.now(),
      )
      return
    }
    const id = this.insertNotification(item, this.notificationContent(item))
    c.after.push(() => this.dispatch(id))
  }

  private insertNotification(item: ItemRow, n: Omit<NotifyPayload, "id">): string {
    const id = newId("n")
    this.store.run(
      `INSERT INTO notifications (id, item_id, state, title, body, actions_json, critical, created_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
      id,
      item.id,
      n.title,
      n.body,
      JSON.stringify(n.actions),
      n.critical ? 1 : 0,
      this.now(),
    )
    return id
  }

  private flushReviewGroup() {
    const g = this.store.one<{ firstAt: number | null }>(
      "SELECT MIN(added_at) AS firstAt FROM review_group",
    )
    if (g?.firstAt == null || this.now() - g.firstAt < this.settings["notifications.reviewGroupMs"])
      return
    const id = this.deps.db.transaction(() => {
      const open = this.store.all<ItemRow>(
        `SELECT i.* FROM review_group g JOIN attention_items i ON i.id = g.item_id
             WHERE i.state = 'open' ORDER BY g.added_at, g.rowid`,
      )
      this.store.run("DELETE FROM review_group")
      const last = open[open.length - 1]
      if (!last) return null
      const base = this.notificationContent(last)
      const content =
        open.length === 1
          ? base
          : { ...base, title: "Claude", body: `${open.length} sessions ready to review` }
      return this.insertNotification(last, content)
    })()
    if (id) this.dispatch(id)
  }

  private dispatch(notificationId: string) {
    const n = this.store.notification(notificationId)
    if (n?.state !== "pending") return
    const payload: NotifyPayload = {
      id: n.id,
      itemId: n.item_id,
      title: n.title,
      body: n.body,
      actions: JSON.parse(n.actions_json) as NotificationAction[],
      critical: n.critical === 1,
    }
    if (this.hub.shellConnected) {
      this.store.run(
        "UPDATE notifications SET state = 'posted', channel = 'shell', posted_at = ? WHERE id = ?",
        this.now(),
        n.id,
      )
      this.hub.publish({ _tag: "notify", seq: this.store.maxSeq(), notification: payload })
      return
    }
    if (!this.settings["notifications.fallback"]) return // stays pending for the shell
    this.store.run(
      "UPDATE notifications SET state = 'posted', channel = 'osascript', posted_at = ? WHERE id = ?",
      this.now(),
      n.id,
    )
    this.track(
      this.deps.notifier.fallback(n.title, n.body).catch((e) => {
        this.deps.log.warn("fallback notification failed", e)
        this.store.run(
          "UPDATE notifications SET state = 'pending', channel = NULL WHERE id = ? AND state = 'posted'",
          n.id,
        )
      }),
    )
  }

  /** A shell connected: deliver notifications that are still pending and still relevant. */
  private flushPendingNotifications() {
    const rows = this.store.all<NotificationRow>(
      `SELECT n.* FROM notifications n JOIN attention_items i ON i.id = n.item_id
         WHERE n.state = 'pending' AND i.state = 'open' AND n.created_at > ? ORDER BY n.created_at`,
      this.now() - 3600_000,
    )
    for (const r of rows) this.dispatch(r.id)
  }

  // -------------------------------------------------------------------------
  // Titles
  // -------------------------------------------------------------------------

  private generateTitle(sessionId: string, prompt: string) {
    this.track(
      this.deps.claude
        .title(prompt)
        .then((title) => {
          if (!title) return
          this.tx((c) => {
            this.appendEvent(c, { sessionId, hook: "daemon:title", payload: { title } })
            this.store.run(
              "UPDATE sessions SET title = ?, title_source = 'generated' WHERE id = ?",
              title,
              sessionId,
            )
            c.sessions.add(sessionId)
          })
        })
        .catch((e) => this.deps.log.warn("title generation failed; keeping the prompt title", e)),
    )
  }

  // -------------------------------------------------------------------------
  // Outbox
  // -------------------------------------------------------------------------

  private enqueueOutbox(c: Changes, item: ItemRow, body: string, key: string) {
    this.store.run(
      `INSERT INTO outbox (id, session_id, item_id, body, idempotency_key, state, attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', 0, 0, ?)`,
      newId("ob"),
      item.session_id,
      item.id,
      body,
      key,
      this.now(),
    )
    c.items.add(item.id)
  }

  /** Start sending every queued row whose session can take it now. Never blocks. */
  kickOutbox() {
    const now = this.now()
    const rows = this.store.all<OutboxRow>(
      "SELECT * FROM outbox WHERE state = 'queued' AND next_attempt_at <= ? ORDER BY created_at",
      now,
    )
    for (const row of rows) {
      if (this.sendingSessions.has(row.session_id)) continue
      const claimed = this.tx((c) => {
        // Re-check inside the transaction: never send into an active turn or a held hook.
        const s = this.store.session(row.session_id)
        const fresh = this.store.one<OutboxRow>("SELECT * FROM outbox WHERE id = ?", row.id)
        if (!s || !fresh || fresh.state !== "queued" || s.state === "running") return null
        const held = this.store.one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM approvals a JOIN attention_items i ON i.id = a.item_id WHERE i.session_id = ? AND a.live = 1",
          s.id,
        )
        if ((held?.n ?? 0) > 0) return null
        this.appendEvent(c, {
          sessionId: s.id,
          hook: "daemon:outbox-sending",
          payload: { id: row.id },
        })
        this.store.run(
          "UPDATE outbox SET state = 'sending', attempts = attempts + 1 WHERE id = ?",
          row.id,
        )
        if (row.item_id) c.items.add(row.item_id)
        return s
      })
      if (!claimed) continue
      this.sendingSessions.add(row.session_id)
      this.track(this.send(row, claimed))
    }
  }

  private async send(row: OutboxRow, s: SessionRow) {
    let error: string | null = null
    try {
      await this.deps.claude.resume(s.id, s.cwd, row.body)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      this.sendingSessions.delete(row.session_id)
    }
    this.tx((c) => {
      const fresh = this.store.one<OutboxRow>(
        "SELECT * FROM outbox WHERE id = ?",
        row.id,
      ) as OutboxRow
      this.appendEvent(c, {
        sessionId: s.id,
        hook: error ? "daemon:outbox-failed" : "daemon:outbox-delivered",
        payload: { id: row.id, attempts: fresh.attempts, error },
      })
      if (row.item_id) c.items.add(row.item_id)
      if (!error) {
        this.store.run(
          "UPDATE outbox SET state = 'delivered', delivered_at = ?, last_error = NULL WHERE id = ?",
          this.now(),
          row.id,
        )
        // Re-base the confirmation window on delivery.
        if (row.item_id)
          this.store.run(
            "UPDATE attention_items SET answered_at = ? WHERE id = ? AND state = 'answered'",
            this.now(),
            row.item_id,
          )
        return
      }
      this.deps.log.warn(`outbox ${row.id} attempt ${fresh.attempts} failed`, error)
      if (fresh.attempts >= this.settings["outbox.maxAttempts"]) {
        this.store.run(
          "UPDATE outbox SET state = 'failed', last_error = ? WHERE id = ?",
          error,
          row.id,
        )
      } else {
        const backoff = this.settings["outbox.backoffMs"] * 2 ** (fresh.attempts - 1)
        this.store.run(
          "UPDATE outbox SET state = 'queued', last_error = ?, next_attempt_at = ? WHERE id = ?",
          error,
          this.now() + backoff,
          row.id,
        )
      }
    })
  }

  // -------------------------------------------------------------------------
  // Timers & recovery
  // -------------------------------------------------------------------------

  /** One timer pass: hold expiry, snooze wake, unconfirmed sweep, review flush, outbox retry. */
  tick() {
    const now = this.now()
    for (const a of this.store.all<ApprovalRow>(
      "SELECT * FROM approvals WHERE live = 1 AND decision IS NULL AND expires_at <= ?",
      now,
    )) {
      this.tx((c) => {
        const item = this.store.item(a.item_id)
        this.appendEvent(c, {
          sessionId: item?.session_id ?? null,
          hook: "daemon:hold-expired",
          payload: { itemId: a.item_id },
        })
        this.expireHold(c, a)
        if (item) this.setSessionState(c, item.session_id, "waiting")
      })
    }
    for (const r of this.store.all<ItemRow>(
      "SELECT * FROM attention_items WHERE state = 'snoozed' AND snooze_until <= ?",
      now,
    )) {
      this.tx((c) => {
        this.appendEvent(c, {
          sessionId: r.session_id,
          hook: "daemon:wake",
          payload: { itemId: r.id },
        })
        if (this.apply(c, r, { _tag: "Wake", now })) {
          this.store.run("UPDATE attention_items SET unread = 1 WHERE id = ?", r.id)
          const fresh = this.store.item(r.id) as ItemRow
          if (!this.isMuted(fresh)) {
            const id = this.insertNotification(fresh, this.notificationContent(fresh))
            c.after.push(() => this.dispatch(id))
          }
        }
      })
    }
    for (const r of this.store.all<ItemRow>(
      `SELECT * FROM attention_items i WHERE state = 'answered' AND unconfirmed = 0 AND answered_at <= ?
         AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.item_id = i.id AND o.state IN ('queued','sending'))`,
      now - this.settings["items.confirmWindowMs"],
    )) {
      this.tx((c) => {
        this.appendEvent(c, {
          sessionId: r.session_id,
          hook: "daemon:unconfirmed",
          payload: { itemId: r.id },
        })
        this.apply(c, r, { _tag: "MarkUnconfirmed" })
      })
    }
    this.flushReviewGroup()
    this.kickOutbox()
    this.updates?.tick()
  }

  /** After a restart: rows that were mid-send go back to the queue. Holds/snoozes recover via tick(). */
  recover() {
    this.store.run("UPDATE outbox SET state = 'queued' WHERE state = 'sending'")
    // A review group whose window closed while we were down goes out now (D-031).
    this.flushReviewGroup()
  }

  // -------------------------------------------------------------------------
  // Updates (D-035): policy lives in updates.ts; the engine supplies events and quietness.
  // -------------------------------------------------------------------------

  /** Set by startDaemon (or tests); ticked from tick(). */
  updates: UpdateManager | null = null

  /** Append a session-less `daemon:*` event (no rows change, so no delta). */
  daemonEvent(hook: string, payload: unknown): number {
    return this.tx((c) => this.appendEvent(c, { sessionId: null, hook, payload }))
  }

  /** Why a restart now would hurt, or null when quiet (D-036). */
  busyReason(quietMs: number): string | null {
    if (this.store.one("SELECT 1 AS x FROM approvals WHERE live = 1 AND decision IS NULL LIMIT 1"))
      return "a held tool call is waiting"
    if (this.store.one("SELECT 1 AS x FROM outbox WHERE state IN ('queued','sending') LIMIT 1"))
      return "a reply is being delivered"
    if (this.sendingSessions.size > 0) return "a reply is being delivered"
    // Newest-first by seq: stops at the first hook event instead of scanning the table.
    const last = this.store.one<{ at: number }>(
      "SELECT received_at AS at FROM events WHERE hook NOT LIKE 'daemon:%' ORDER BY seq DESC LIMIT 1",
    )
    if (last && this.now() - last.at < quietMs) return "a session is active"
    return null
  }
}
