/**
 * Row types, row → contract mappers and read-only queries. Writes live in the
 * engine so every mutation goes through its transaction + event append.
 */
import type { Database } from "bun:sqlite"
import type {
  Agent,
  AgentState,
  Approval,
  AttentionKind,
  Counts,
  Decision,
  Item,
  ItemState,
  OutboxEntry,
  OutboxState,
  Project,
  Question,
  Queue,
  Runtime,
  Session,
  SessionState,
} from "@session-inbox/contracts"
import { ApprovalPreview } from "@session-inbox/contracts"
import { Option, Schema } from "effect"

export interface ProjectRow {
  id: string
  root_path: string
  name: string
  muted: number
  created_at: number
}
export interface SessionRow {
  id: string
  project_id: string
  title: string | null
  title_source: string | null
  runtime: string
  host_session_id: string | null
  cwd: string | null
  branch: string | null
  worktree: string | null
  transcript_path: string | null
  permission_mode: string | null
  state: string
  created_at: number
  last_event_at: number
}
export interface AgentRow {
  id: string
  session_id: string
  parent_agent_id: string | null
  name: string
  state: string
  started_at: number | null
  ended_at: number | null
}
export interface ItemRow {
  id: string
  session_id: string
  agent_id: string | null
  kind: string
  state: string
  dedupe_key: string
  summary: string | null
  source_seq: number | null
  snooze_until: number | null
  unread: number
  unconfirmed: number
  answered_at: number | null
  answered_seq: number | null
  created_at: number
  updated_at: number
}
export interface ApprovalRow {
  item_id: string
  hook_request_id: string
  tool: string
  input_json: string
  tool_use_id: string | null
  decision: string | null
  reason: string | null
  updated_input_json: string | null
  live: number
  decided_at: number | null
  expires_at: number
  /** Migration 003 (D-056). */
  preview_json?: string | null
  context?: string | null
  /** Migration 004 (D-068): 'permissionRequest' or NULL (a held PreToolUse). */
  via?: string | null
  input_key?: string | null
  suggestions_json?: string | null
  updated_permissions_json?: string | null
}
export interface QuestionRow {
  item_id: string
  idx: number
  header: string | null
  text: string
  options_json: string | null
  multi: number
  answer_json: string | null
}
export interface OutboxRow {
  id: string
  session_id: string
  item_id: string | null
  body: string
  idempotency_key: string
  state: string
  attempts: number
  last_error: string | null
  next_attempt_at: number
  delivered_at: number | null
  created_at: number
}
export interface NotificationRow {
  id: string
  item_id: string
  state: string
  title: string
  body: string
  actions_json: string
  critical: number
  channel: string | null
  created_at: number
  posted_at: number | null
  acted_at: number | null
  action: string | null
}
export interface EventRow {
  seq: number
  session_id: string | null
  agent_id: string | null
  hook: string
  payload_json: string
  env_json: string | null
  decode_error: string | null
  received_at: number
}

export const queueOf = (kind: string, state: string): Queue => {
  if (state === "snoozed") return "snoozed"
  if (state === "open") return kind === "review" ? "review" : "needs-you"
  return "done"
}

export const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  rootPath: r.root_path,
  muted: r.muted === 1,
})

export const toSession = (r: SessionRow): Session => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  runtime: r.runtime as Runtime,
  cwd: r.cwd,
  branch: r.branch,
  worktree: r.worktree,
  hostSessionId: r.host_session_id,
  state: r.state as SessionState,
  lastEventAt: r.last_event_at,
})

export const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  sessionId: r.session_id,
  parentAgentId: r.parent_agent_id,
  name: r.name,
  state: r.state as AgentState,
  startedAt: r.started_at,
  endedAt: r.ended_at,
})

export const toItem = (r: ItemRow, live: boolean, questionCount = 0): Item => ({
  id: r.id,
  sessionId: r.session_id,
  agentId: r.agent_id,
  kind: r.kind as AttentionKind,
  state: r.state as ItemState,
  queue: queueOf(r.kind, r.state),
  summary: r.summary,
  unconfirmed: r.unconfirmed === 1,
  live,
  unread: r.unread === 1,
  snoozeUntil: r.snooze_until,
  ...(r.kind === "question" && questionCount > 0 ? { questionCount } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const decodePreview = Schema.decodeUnknownOption(ApprovalPreview)
/** A stored preview, or undefined when absent or no longer matching the contract. */
const previewOf = (json: string | null | undefined): ApprovalPreview | undefined => {
  if (!json) return undefined
  try {
    return Option.getOrUndefined(decodePreview(JSON.parse(json)))
  } catch {
    return undefined
  }
}

export const toApproval = (r: ApprovalRow): Approval => {
  const preview = previewOf(r.preview_json)
  return {
    tool: r.tool,
    input: JSON.parse(r.input_json) as unknown,
    decision: r.decision as Decision | null,
    decidedAt: r.decided_at,
    expiresAt: r.expires_at,
    ...(preview ? { preview } : {}),
    ...(r.context ? { context: r.context } : {}),
    ...(r.via === "permissionRequest" ? { via: "permissionRequest" as const } : {}),
  }
}

export const toQuestion = (r: QuestionRow): Question => ({
  idx: r.idx,
  ...(r.header === null ? {} : { header: r.header }),
  text: r.text,
  options: r.options_json ? (JSON.parse(r.options_json) as Question["options"]) : [],
  multi: r.multi === 1,
  answer: r.answer_json ? (JSON.parse(r.answer_json) as unknown) : null,
})

export const toOutbox = (r: OutboxRow): OutboxEntry => ({
  id: r.id,
  body: r.body,
  state: r.state as OutboxState,
  attempts: r.attempts,
  lastError: r.last_error,
  createdAt: r.created_at,
})

/** Thin typed query helpers. */
export class Store {
  constructor(readonly db: Database) {}

  one<T>(sql: string, ...params: unknown[]): T | null {
    return (this.db.query(sql).get(...(params as never[])) as T | null) ?? null
  }
  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.query(sql).all(...(params as never[])) as T[]
  }
  run(sql: string, ...params: unknown[]): void {
    this.db.query(sql).run(...(params as never[]))
  }

  project(id: string) {
    return this.one<ProjectRow>("SELECT * FROM projects WHERE id = ?", id)
  }
  session(id: string) {
    return this.one<SessionRow>("SELECT * FROM sessions WHERE id = ?", id)
  }
  agent(id: string) {
    return this.one<AgentRow>("SELECT * FROM agents WHERE id = ?", id)
  }
  item(id: string) {
    return this.one<ItemRow>("SELECT * FROM attention_items WHERE id = ?", id)
  }
  approval(itemId: string) {
    return this.one<ApprovalRow>("SELECT * FROM approvals WHERE item_id = ?", itemId)
  }
  approvalByRequest(requestId: string) {
    return this.one<ApprovalRow>("SELECT * FROM approvals WHERE hook_request_id = ?", requestId)
  }
  questions(itemId: string) {
    return this.all<QuestionRow>("SELECT * FROM questions WHERE item_id = ? ORDER BY idx", itemId)
  }
  notification(id: string) {
    return this.one<NotificationRow>("SELECT * FROM notifications WHERE id = ?", id)
  }
  isLive(itemId: string): boolean {
    return (
      this.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM approvals WHERE item_id = ? AND live = 1",
        itemId,
      )?.n === 1
    )
  }
  questionCount(itemId: string): number {
    return (
      this.one<{ n: number }>("SELECT COUNT(*) AS n FROM questions WHERE item_id = ?", itemId)?.n ??
      0
    )
  }
  /** The contract `Item` for a row: live flag and question count looked up. */
  itemView(r: ItemRow): Item {
    return toItem(r, this.isLive(r.id), r.kind === "question" ? this.questionCount(r.id) : 0)
  }
  itemOut(id: string): Item | null {
    const r = this.item(id)
    return r ? this.itemView(r) : null
  }
  maxSeq(): number {
    return this.one<{ s: number | null }>("SELECT MAX(seq) AS s FROM events")?.s ?? 0
  }
  counts(): Counts {
    const q = (sql: string) => this.one<{ n: number }>(sql)?.n ?? 0
    return {
      needsYou: q(
        "SELECT COUNT(*) AS n FROM attention_items WHERE state = 'open' AND kind != 'review'",
      ),
      working: q("SELECT COUNT(*) AS n FROM sessions WHERE state = 'running'"),
      review: q(
        "SELECT COUNT(*) AS n FROM attention_items WHERE state = 'open' AND kind = 'review'",
      ),
      snoozed: q("SELECT COUNT(*) AS n FROM attention_items WHERE state = 'snoozed'"),
    }
  }
}
