/**
 * Domain vocabulary shared by the daemon and the UI.
 *
 * The daemon is the only place that *decides* anything (see DECISIONS.md D-002).
 * These schemas describe the shape of daemon state as it is rendered; they carry
 * no behaviour.
 */
import { Schema } from "effect"

export const Runtime = Schema.Literals(["desktop", "cli", "cloud", "unknown"])
export type Runtime = typeof Runtime.Type

/** What Claude is doing. */
export const SessionState = Schema.Literals(["running", "waiting", "idle", "ended"])
export type SessionState = typeof SessionState.Type

export const AgentState = Schema.Literals(["running", "waiting", "done", "failed"])
export type AgentState = typeof AgentState.Type

/** What you owe Claude. `progress` never becomes an item; it is timeline-only. */
export const AttentionKind = Schema.Literals(["question", "permission", "failed", "review"])
export type AttentionKind = typeof AttentionKind.Type

export const ItemState = Schema.Literals([
  "open",
  "snoozed",
  "answered",
  "resolved",
  "expired",
  "dismissed",
])
export type ItemState = typeof ItemState.Type

/** UI queues are filters over items; the daemon computes which queue an item is in. */
export const Queue = Schema.Literals(["needs-you", "review", "snoozed", "done"])
export type Queue = typeof Queue.Type

export const OutboxState = Schema.Literals(["queued", "sending", "delivered", "failed"])
export type OutboxState = typeof OutboxState.Type

export const Decision = Schema.Literals(["allow", "allow-always", "deny", "ask"])
export type Decision = typeof Decision.Type

/** Epoch milliseconds. */
export const Millis = Schema.Number
export type Millis = typeof Millis.Type

export const Project = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  rootPath: Schema.String,
  muted: Schema.Boolean,
})
export type Project = typeof Project.Type

export const Agent = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  parentAgentId: Schema.NullOr(Schema.String),
  name: Schema.String,
  state: AgentState,
  startedAt: Schema.NullOr(Millis),
  endedAt: Schema.NullOr(Millis),
})
export type Agent = typeof Agent.Type

export const Session = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.NullOr(Schema.String),
  runtime: Runtime,
  cwd: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  worktree: Schema.NullOr(Schema.String),
  /** Claude desktop's own session id (e.g. `local_<uuid>`), when the hook saw one. */
  hostSessionId: Schema.NullOr(Schema.String),
  state: SessionState,
  lastEventAt: Millis,
})
export type Session = typeof Session.Type

export const Item = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  agentId: Schema.NullOr(Schema.String),
  kind: AttentionKind,
  state: ItemState,
  queue: Queue,
  summary: Schema.NullOr(Schema.String),
  /** Answered/decided but no confirming event within 5 minutes. */
  unconfirmed: Schema.Boolean,
  /** The daemon is holding a PreToolUse hook open for this item right now. */
  live: Schema.Boolean,
  unread: Schema.Boolean,
  snoozeUntil: Schema.NullOr(Millis),
  /** Question items: how many questions Claude asked (absent for an idle "waiting for input"). */
  questionCount: Schema.optional(Schema.Number),
  createdAt: Millis,
  updatedAt: Millis,
})
export type Item = typeof Item.Type

export const QuestionOption = Schema.Struct({
  label: Schema.String,
  description: Schema.optional(Schema.String),
})
export type QuestionOption = typeof QuestionOption.Type

export const Question = Schema.Struct({
  idx: Schema.Number,
  header: Schema.optional(Schema.String),
  text: Schema.String,
  options: Schema.Array(QuestionOption),
  multi: Schema.Boolean,
  answer: Schema.NullOr(Schema.Unknown),
})
export type Question = typeof Question.Type

/** One rendered diff line. `noEol`: the line has no trailing newline (end of file). */
export const DiffLine = Schema.Struct({
  kind: Schema.Literals(["context", "add", "del"]),
  text: Schema.String,
  noEol: Schema.optional(Schema.Boolean),
})
export type DiffLine = typeof DiffLine.Type

/** A unified-diff hunk; starts are 1-based (0 when that side is empty). */
export const DiffHunk = Schema.Struct({
  oldStart: Schema.Number,
  oldLines: Schema.Number,
  newStart: Schema.Number,
  newLines: Schema.Number,
  lines: Schema.Array(DiffLine),
})
export type DiffHunk = typeof DiffHunk.Type

/**
 * What a held tool call would do, computed by the daemon when the hold is created
 * (C-019). The UI renders it as given.
 */
export const ApprovalPreview = Schema.Union([
  Schema.TaggedStruct("diff", {
    path: Schema.String,
    /** `path` relative to the session's worktree/project/cwd when inside it. */
    displayPath: Schema.String,
    isNewFile: Schema.Boolean,
    /** The file couldn't be read or the edit didn't match: old vs new text only, lines from 1. */
    approximate: Schema.Boolean,
    /** NUL bytes on either side: no hunks. */
    binary: Schema.Boolean,
    hunks: Schema.Array(DiffHunk),
    /** Counts over the whole change, even when `hunks` were cut. */
    added: Schema.Number,
    removed: Schema.Number,
    /** Hunks were cut at the line/byte cap. */
    truncated: Schema.Boolean,
  }),
  Schema.TaggedStruct("command", {
    command: Schema.String,
    description: Schema.NullOr(Schema.String),
    cwd: Schema.NullOr(Schema.String),
    /** `cwd` relative to the project root when inside it ("." for the root). */
    displayCwd: Schema.NullOr(Schema.String),
    background: Schema.optional(Schema.Boolean),
    timeoutMs: Schema.optional(Schema.Number),
  }),
  Schema.TaggedStruct("fetch", {
    url: Schema.String,
    prompt: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("generic", {
    /** Pretty-printed tool input. */
    text: Schema.String,
    truncated: Schema.Boolean,
  }),
])
export type ApprovalPreview = typeof ApprovalPreview.Type

export const Approval = Schema.Struct({
  tool: Schema.String,
  input: Schema.Unknown,
  decision: Schema.NullOr(Decision),
  decidedAt: Schema.NullOr(Millis),
  expiresAt: Millis,
  /** Computed and stored when the hold was created; absent for older rows or on failure. */
  preview: Schema.optional(ApprovalPreview),
  /** Claude's last text before this tool call (≤ ~600 chars), from the transcript tail. */
  context: Schema.optional(Schema.String),
  /** Set when the request came from Claude's PermissionRequest hook, not a held PreToolUse. */
  via: Schema.optional(Schema.Literals(["permissionRequest"])),
  /**
   * What "Always allow" would add, in words the card can show verbatim (the rule text and where
   * it is saved, e.g. "Read(//tmp/proj/**) for this session"). Absent when Always allow isn't
   * offered for this call: the UI then shows no such button (C-026).
   */
  alwaysAllow: Schema.optional(Schema.String),
})
export type Approval = typeof Approval.Type

export const TimelineEntry = Schema.Struct({
  seq: Schema.Number,
  at: Millis,
  hook: Schema.String,
  agentId: Schema.NullOr(Schema.String),
  /** One human-readable line, e.g. "Edited src/foo.ts" or "Ran bun test". */
  text: Schema.String,
  /** True on the event that created (or last refreshed) the item this detail is for. */
  isSource: Schema.optional(Schema.Boolean),
})
export type TimelineEntry = typeof TimelineEntry.Type

export const OutboxEntry = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  state: OutboxState,
  attempts: Schema.Number,
  lastError: Schema.NullOr(Schema.String),
  createdAt: Millis,
})
export type OutboxEntry = typeof OutboxEntry.Type

export const Counts = Schema.Struct({
  needsYou: Schema.Number,
  working: Schema.Number,
  review: Schema.Number,
  snoozed: Schema.Number,
})
export type Counts = typeof Counts.Type
