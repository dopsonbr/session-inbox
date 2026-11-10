import { Combobox, Dialog, Menu, RadioGroup } from "@foldkit/ui"
import { ItemDetail, Snapshot } from "@session-inbox/contracts"
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
  draftVersion: Schema.Number,
  submission: Submission,
  jumpDialog: Dialog.Model,
  jumpCombobox: Combobox.Model,
  snoozeMenu: Menu.Model,
  toasts: Toast.Model,
  settings: SettingsModel,
})
export type Model = typeof Model.Type
