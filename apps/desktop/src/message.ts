import { Combobox, Dialog, Menu, RadioGroup } from "@foldkit/ui"
import {
  ActionResponse,
  Decision,
  DoctorReport,
  ItemDetail,
  Snapshot,
  StreamMessage,
  UpdateStatus,
} from "@session-inbox/contracts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { ActionKind, QueueTab } from "./model.ts"
import { SettingsMessage } from "./settings.ts"
import { Toast } from "./toast.ts"

export const SnoozeAction = Schema.Literals([
  "snooze-15m",
  "snooze-1h",
  "snooze-tomorrow",
  "dismiss",
  "mute",
])
export type SnoozeAction = typeof SnoozeAction.Type

export const SnoozePreset = Schema.Literals(["15m", "1h", "tomorrow"])
export type SnoozePreset = typeof SnoozePreset.Type

export const TreeKey = Schema.Literals([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "Home",
  "End",
])
export type TreeKey = typeof TreeKey.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededFetchSnapshot: { snapshot: Snapshot },
  FailedFetchSnapshot: { error: Schema.String },
  CompletedWaitBeforeSnapshotRetry: {},
  ReceivedStreamMessage: { message: StreamMessage },
  DisconnectedStream: { error: Schema.String },
  SucceededFetchItemDetail: { detail: ItemDetail },
  FailedFetchItemDetail: { itemId: Schema.String, error: Schema.String },

  ClickedItem: { itemId: Schema.String },
  ClickedSession: { sessionId: Schema.String },
  ChangedHash: { hash: Schema.String },
  SelectedQueueTab: { tab: QueueTab },
  ToggledTreeNode: { nodeId: Schema.String },
  ClickedTreeNode: { nodeId: Schema.String },
  PressedTreeKey: { nodeId: Schema.String, key: TreeKey },

  GotRadioGroupMessage: { idx: Schema.Number, message: RadioGroup.Message },
  ToggledOption: { idx: Schema.Number, label: Schema.String, isChecked: Schema.Boolean },
  UpdatedOther: { idx: Schema.Number, value: Schema.String },
  UpdatedReply: { value: Schema.String },
  CompletedWaitBeforeDraftSave: { version: Schema.Number },
  CompletedSaveDraft: {},
  ToggledPreviewExpanded: {},

  SubmittedAnswers: {},
  ClickedDecision: { decision: Decision },
  SubmittedReply: {},
  ClickedOpenInClaude: {},
  SucceededAction: { action: ActionKind, itemId: Schema.String, response: ActionResponse },
  /** `status`: the HTTP status when the daemon answered (409 = it refused), else null. */
  FailedAction: { action: ActionKind, error: Schema.String, status: Schema.NullOr(Schema.Number) },
  SucceededOpenInClaude: { url: Schema.NullOr(Schema.String) },

  PressedJumpShortcut: {},
  PressedSubmitShortcut: {},
  PressedDenyShortcut: {},
  ClickedJumpField: {},

  GotSnoozeMenuMessage: { message: Menu.Message },
  GotJumpDialogMessage: { message: Dialog.Message },
  GotJumpComboboxMessage: { message: Combobox.Message },
  GotToastMessage: { message: Toast.Message },
  GotSettingsMessage: { message: SettingsMessage },

  ClickedCheckForUpdates: {},
  ClickedUpdateNow: {},
  DismissedUpdateBanner: {},
  SucceededUpdateRequest: { status: UpdateStatus },
  FailedUpdateRequest: { error: Schema.String },
  CompletedReload: {},

  SucceededFetchDoctor: { report: DoctorReport },
  /** The daemon has no setup check (404). */
  FoundDoctorUnavailable: {},
  FailedFetchDoctor: { error: Schema.String },
  ClickedRecheck: {},
  ClickedCopyFix: { checkId: Schema.String, value: Schema.String },
  CompletedCopyFix: { checkId: Schema.String, value: Schema.String, isCopied: Schema.Boolean },
  CompletedCopiedWait: { checkId: Schema.String },
  ClickedTestNotification: {},
  SucceededTestNotification: {
    via: Schema.NullOr(Schema.String),
    message: Schema.NullOr(Schema.String),
  },
  FailedTestNotification: { error: Schema.String },
  ToggledLastMessageExpanded: {},

  CompletedMarkRead: {},
  CompletedSetHash: {},
  CompletedFocusTreeNode: {},
  TickedClock: { now: Schema.Number },
})
export type Message = typeof Message.Type
