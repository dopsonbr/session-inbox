import { Combobox, Dialog, Menu, RadioGroup } from "@foldkit/ui"
import { DoctorReport, ItemDetail, Snapshot, UpdateStatus } from "@session-inbox/contracts"
import { Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import { SettingsModel } from "./settings.ts"
import { Toast } from "./toast.ts"

// MODEL
//
// Local view state only. Lifecycle, queue, priority and counts always come
// from the daemon (G-002); nothing here derives them.

export const AppView = Schema.Literals(["full", "compact"])
export type AppView = typeof AppView.Type

export const QueueTab = Schema.Literals(["needs-you", "working", "review", "snoozed"])
export type QueueTab = typeof QueueTab.Type

export const Connection = defineTaggedUnion({
  Connecting: {},
  Live: {},
  Offline: { error: Schema.String },
})
export type Connection = typeof Connection.Type

export const DetailState = defineTaggedUnion({
  Idle: {},
  Loading: { itemId: Schema.String },
  Loaded: { detail: ItemDetail },
  Failed: { itemId: Schema.String, error: Schema.String },
})
export type DetailState = typeof DetailState.Type

export const AnswerDraft = Schema.Struct({
  idx: Schema.Number,
  selected: Schema.Array(Schema.String),
  other: Schema.String,
})
export type AnswerDraft = typeof AnswerDraft.Type

/** What we PUT to /draft and read back from `ItemDetail.draft`. */
export const DraftBody = Schema.Struct({
  answers: Schema.Array(AnswerDraft),
  reply: Schema.String,
})
export type DraftBody = typeof DraftBody.Type

export const Form = Schema.Struct({
  itemId: Schema.String,
  answers: Schema.Array(AnswerDraft),
  reply: Schema.String,
  /** One RadioGroup per question, index-aligned with `answers` (unused for multi). */
  radioGroups: Schema.Array(RadioGroup.Model),
})
export type Form = typeof Form.Type

export const ActionKind = Schema.Literals([
  "answers",
  "decision",
  "reply",
  "snooze",
  "dismiss",
  "mute",
  "open",
])
export type ActionKind = typeof ActionKind.Type

export const Submission = defineTaggedUnion({
  Idle: {},
  Sending: { action: ActionKind },
  Failed: { action: ActionKind, error: Schema.String },
})
export type Submission = typeof Submission.Type

/** What the main window shows next to the tree: the inbox, or the Setup panel (U-034). */
export const Route = Schema.Literals(["inbox", "setup"])
export type Route = typeof Route.Type

/** The daemon's setup check as last fetched (C-021); the UI only renders it. */
export const DoctorState = defineTaggedUnion({
  /** Not fetched yet: show nothing. */
  Unknown: {},
  /** This daemon has no /v1/doctor (404): show nothing. */
  Unavailable: {},
  /** `error`: the last refetch failed; the report is the one before it. */
  Loaded: { report: DoctorReport, error: Schema.NullOr(Schema.String) },
  Failed: { error: Schema.String },
})
export type DoctorState = typeof DoctorState.Type

/** A check/apply request in flight (local UI state only; the daemon owns the status). */
export const UpdateRequest = Schema.Literals(["Idle", "Checking", "Applying"])
export type UpdateRequest = typeof UpdateRequest.Type

export const Model = Schema.Struct({
  view: AppView,
  now: Schema.Number,
  connection: Connection,
  maybeSnapshot: Schema.Option(Snapshot),
  /** Display order of item ids: daemon order at snapshot time, new ids appended (U-010). */
  itemOrder: Schema.Array(Schema.String),
  /** Bumped when the stream must restart from a fresh snapshot (initial load, reset). */
  streamEpoch: Schema.Number,
  queueTab: QueueTab,
  maybeSelectedItemId: Schema.Option(Schema.String),
  maybeSelectedSessionId: Schema.Option(Schema.String),
  detail: DetailState,
  expandedNodes: Schema.Array(Schema.String),
  maybeFocusedNode: Schema.Option(Schema.String),
  maybeForm: Schema.Option(Form),
  /** "Show all N lines" on the selected item's approval preview; reset on selection change. */
  isPreviewExpanded: Schema.Boolean,
  draftVersion: Schema.Number,
  submission: Submission,
  jumpDialog: Dialog.Model,
  jumpCombobox: Combobox.Model,
  snoozeMenu: Menu.Model,
  toasts: Toast.Model,
  settings: SettingsModel,
  /** Daemon update status as last streamed or returned (C-013); None = unsupported/unknown. */
  maybeUpdate: Schema.Option(UpdateStatus),
  /** `version·build` from the first `hello`; a different one later means reload (U-022). */
  maybeDaemonBuild: Schema.Option(Schema.String),
  /** "Not now" on the banner (its `state:version` key), for this page load only. */
  maybeDismissedUpdate: Schema.Option(Schema.String),
  updateRequest: UpdateRequest,
  route: Route,
  doctor: DoctorState,
  isDoctorLoading: Schema.Boolean,
  /** Check id whose "copy" fix was just copied: its button reads "Copied" for a moment. */
  maybeCopiedFix: Schema.Option(Schema.String),
  isTestNotifying: Schema.Boolean,
  /** "Show all" on the selected item's last message (U-033); reset on selection change. */
  isLastMessageExpanded: Schema.Boolean,
  /** The daemon's 409 answer to a reply, shown under the reply box (U-035). */
  maybeReplyError: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type
