/**
 * Daemon HTTP API: request/response bodies and stream messages.
 * Route table lives in DECISIONS.md / the implementation doc; paths are exported
 * here so client and server can't drift.
 */
import { Schema, Struct } from "effect"
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
  settings: "/v1/settings",
  health: "/v1/health",
  /** Update status (C-013). GET returns UpdateStatus; check/apply are POST. */
  update: "/v1/update",
  updateCheck: "/v1/update/check",
  updateApply: "/v1/update/apply",
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

// ---------------------------------------------------------------------------
// Settings pane (C-016). Only the user-facing keys; internal ones (questions.*,
// items.*, outbox.*) stay in the settings table. Durations are milliseconds.
// ---------------------------------------------------------------------------

/** Tools whose PreToolUse may be held. AskUserQuestion is always routed through the inbox. */
export const HOLDABLE_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
] as const
export const HoldableTool = Schema.Literals(HOLDABLE_TOOLS)
export type HoldableTool = typeof HoldableTool.Type

export const UserSettings = Schema.Struct({
  "holds.enabled": Schema.Boolean,
  "holds.tools": Schema.Array(HoldableTool),
  "holds.budgetMs": Schema.Finite,
  "holds.safeBashPrefixes": Schema.Array(Schema.String),
  "notifications.fallback": Schema.Boolean,
  "notifications.reviewGroupMs": Schema.Finite,
  "titles.generate": Schema.Boolean,
})
export type UserSettings = typeof UserSettings.Type
export type UserSettingKey = keyof UserSettings
export const USER_SETTING_KEYS = Object.keys(UserSettings.fields) as ReadonlyArray<UserSettingKey>

/** Ranges the daemon clamps to. A hold can't outlast the hook's own 120 s budget (H-003). */
export const SETTING_LIMITS = {
  "holds.budgetMs": { min: 15_000, max: 120_000 },
  "notifications.reviewGroupMs": { min: 0, max: 600_000 },
} as const satisfies Partial<Record<UserSettingKey, { min: number; max: number }>>

/** PUT body: any subset of UserSettings; `null` resets that key to its default. */
export const UserSettingsPatch = UserSettings.mapFields(Struct.map(Schema.NullOr)).mapFields(
  Struct.map(Schema.optionalKey),
)
export type UserSettingsPatch = typeof UserSettingsPatch.Type

export const SettingsResponse = Schema.Struct({
  settings: UserSettings,
  /** What each key goes back to on reset: code defaults, then the install's own (H-016). */
  defaults: UserSettings,
  /** This daemon's install channel ("ga" | "beta"). */
  channel: Schema.String,
  /** Another channel installed on this machine, whose daemon may also hold hooks (H-016). */
  otherChannel: Schema.NullOr(Schema.String),
})
export type SettingsResponse = typeof SettingsResponse.Type

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
// Updates (C-013). The daemon decides; `session-inbox update` does the work.
// ---------------------------------------------------------------------------

export const UpdateState = Schema.Literals([
  "unsupported",
  "idle",
  "checking",
  "available",
  "updating",
  "failed",
])
export type UpdateState = typeof UpdateState.Type

/** How this install was made: from a GitHub release, or built from a checkout. */
export const UpdateSource = Schema.Literals(["release", "source"])
export type UpdateSource = typeof UpdateSource.Type

export const UpdateStatus = Schema.Struct({
  state: UpdateState,
  /** This daemon's version and build stamp. */
  current: Schema.String,
  build: Schema.String,
  latest: Schema.NullOr(Schema.String),
  available: Schema.Boolean,
  notesUrl: Schema.NullOr(Schema.String),
  publishedAt: Schema.NullOr(Schema.String),
  /** Epoch ms of the last finished check. */
  checkedAt: Schema.NullOr(Schema.Number),
  /** Last check or update error, for display. */
  error: Schema.NullOr(Schema.String),
  /** Daemon-computed: this update installs by itself once no session is waiting. */
  auto: Schema.Boolean,
  /** null until the first check answers. */
  source: Schema.NullOr(UpdateSource),
  /** Version being installed while `updating` (or that failed). */
  target: Schema.NullOr(Schema.String),
  /** CLI progress while `updating`: downloading | verifying | installing | done. */
  progress: Schema.NullOr(Schema.String),
  /** Set after a restart into a new version, until the daemon restarts again. */
  justUpdatedFrom: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.Number),
})
export type UpdateStatus = typeof UpdateStatus.Type

export const UpdateApplyRequest = Schema.Struct({ version: Schema.optional(Schema.String) })
export type UpdateApplyRequest = typeof UpdateApplyRequest.Type

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
  Schema.TaggedStruct("hello", {
    seq: Schema.Number,
    /** Daemon version and build stamp (C-014); a page reloads when they change. */
    version: Schema.optional(Schema.String),
    build: Schema.optional(Schema.String),
  }),
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
  /** Live-only, sent after hello and on every update-status change (C-013). */
  Schema.TaggedStruct("update", { seq: Schema.Number, status: UpdateStatus }),
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
