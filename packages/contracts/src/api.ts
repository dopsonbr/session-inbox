/**
 * Daemon HTTP API: request/response bodies and stream messages.
 * Route table lives in DECISIONS.md / the implementation doc; paths are exported
 * here so client and server can't drift.
 */
import { Schema } from "effect"
import {
  Agent,
  Approval,
  Counts,
  Decision,
  Item,
  OutboxEntry,
  Project,
  Question,
  Session,
  TimelineEntry,
} from "./domain.ts"

export const API_VERSION = 1
export const SCHEMA_VERSION = 1

export const Routes = {
  hookIngest: (event: string) => `/v1/hooks/${event}`,
  hookDecision: (requestId: string, waitSeconds: number) =>
    `/v1/hooks/decision/${requestId}?wait=${waitSeconds}`,
  snapshot: "/v1/snapshot",
  stream: (since: number | null, client: "ui" | "shell") =>
    `/v1/stream?client=${client}${since === null ? "" : `&since=${since}`}`,
  item: (id: string) => `/v1/items/${id}`,
  answers: (id: string) => `/v1/items/${id}/answers`,
  decision: (id: string) => `/v1/items/${id}/decision`,
  reply: (id: string) => `/v1/items/${id}/reply`,
  snooze: (id: string) => `/v1/items/${id}/snooze`,
  dismiss: (id: string) => `/v1/items/${id}/dismiss`,
  draft: (id: string) => `/v1/items/${id}/draft`,
  read: (id: string) => `/v1/items/${id}/read`,
  openInClaude: (id: string) => `/v1/items/${id}/open`,
  notificationActed: (id: string) => `/v1/notifications/${id}/acted`,
  projectMute: (id: string) => `/v1/projects/${id}/mute`,
  health: "/v1/health",
} as const

export const Snapshot = Schema.Struct({
  seq: Schema.Number,
  projects: Schema.Array(Project),
  sessions: Schema.Array(Session),
  agents: Schema.Array(Agent),
  items: Schema.Array(Item),
  counts: Counts,
})
export type Snapshot = typeof Snapshot.Type

export const ItemDetail = Schema.Struct({
  item: Item,
  session: Session,
  project: Project,
  questions: Schema.Array(Question),
  approval: Schema.NullOr(Approval),
  timeline: Schema.Array(TimelineEntry),
  outbox: Schema.Array(OutboxEntry),
  draft: Schema.NullOr(Schema.Unknown),
  /** Where "Open in Claude" goes, computed by the daemon. */
  openUrl: Schema.NullOr(Schema.String),
})
export type ItemDetail = typeof ItemDetail.Type

/** One answer per question idx. `selected` are option labels; `other` is free text. */
export const Answer = Schema.Struct({
  idx: Schema.Number,
  selected: Schema.Array(Schema.String),
  other: Schema.optional(Schema.String),
})
export type Answer = typeof Answer.Type

export const AnswersRequest = Schema.Struct({
  idempotencyKey: Schema.String,
  answers: Schema.Array(Answer),
})
export type AnswersRequest = typeof AnswersRequest.Type

export const DecisionRequest = Schema.Struct({
  idempotencyKey: Schema.String,
  decision: Decision,
})
export type DecisionRequest = typeof DecisionRequest.Type

export const ReplyRequest = Schema.Struct({
  idempotencyKey: Schema.String,
  body: Schema.String,
})
export type ReplyRequest = typeof ReplyRequest.Type

export const SnoozeRequest = Schema.Struct({ until: Schema.Number })
export type SnoozeRequest = typeof SnoozeRequest.Type

export const DraftRequest = Schema.Struct({ body: Schema.Unknown })
export type DraftRequest = typeof DraftRequest.Type

export const MuteRequest = Schema.Struct({ muted: Schema.Boolean })
export type MuteRequest = typeof MuteRequest.Type

export const NotificationAction = Schema.Literals(["click", "answer", "allow", "deny", "open"])
export type NotificationAction = typeof NotificationAction.Type

export const NotificationActedRequest = Schema.Struct({ action: NotificationAction })
export type NotificationActedRequest = typeof NotificationActedRequest.Type

/** Every mutating call returns the item as it now stands (or 409 with an ApiError). */
export const ActionResponse = Schema.Struct({ ok: Schema.Boolean, item: Schema.NullOr(Item) })
export type ActionResponse = typeof ActionResponse.Type

export const OpenResponse = Schema.Struct({ url: Schema.NullOr(Schema.String) })
export type OpenResponse = typeof OpenResponse.Type

export const ApiError = Schema.Struct({
  error: Schema.Literals(["not_found", "conflict", "bad_request", "unauthorized", "internal"]),
  message: Schema.String,
})
export type ApiError = typeof ApiError.Type

export const Health = Schema.Struct({
  ok: Schema.Boolean,
  version: Schema.String,
  schemaVersion: Schema.Number,
  pid: Schema.Number,
  startedAt: Schema.Number,
  shellConnected: Schema.Boolean,
  /** Install channel ("ga" | "beta"), C-012. */
  channel: Schema.optional(Schema.String),
  /** Build stamp: git commit (+ "-dirty") of the compiled daemon, or "dev". */
  build: Schema.optional(Schema.String),
})
export type Health = typeof Health.Type

// ---------------------------------------------------------------------------
// Stream (SSE). Each SSE `data:` line is one JSON-encoded StreamMessage; the SSE
// `id:` is the seq so EventSource-style resume works too.
// ---------------------------------------------------------------------------

export const NotifyPayload = Schema.Struct({
  /** notification row id; report clicks/actions to /v1/notifications/:id/acted */
  id: Schema.String,
  itemId: Schema.String,
  title: Schema.String,
  body: Schema.String,
  actions: Schema.Array(NotificationAction),
  critical: Schema.Boolean,
})
export type NotifyPayload = typeof NotifyPayload.Type

export const StreamMessage = Schema.Union([
  Schema.TaggedStruct("hello", { seq: Schema.Number }),
  Schema.TaggedStruct("delta", {
    seq: Schema.Number,
    projects: Schema.Array(Project),
    sessions: Schema.Array(Session),
    agents: Schema.Array(Agent),
    items: Schema.Array(Item),
    counts: Counts,
  }),
  Schema.TaggedStruct("notify", { seq: Schema.Number, notification: NotifyPayload }),
  Schema.TaggedStruct("badge", { seq: Schema.Number, count: Schema.Number }),
  Schema.TaggedStruct("reset", { seq: Schema.Number }),
])
export type StreamMessage = typeof StreamMessage.Type

/** Contents of connection.json (0600), written by the daemon at startup. */
export const Connection = Schema.Struct({
  socketPath: Schema.String,
  httpPort: Schema.Number,
  token: Schema.String,
  pid: Schema.Number,
  version: Schema.String,
  channel: Schema.optional(Schema.String),
  build: Schema.optional(Schema.String),
})
export type Connection = typeof Connection.Type
