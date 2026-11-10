import { Answer, Decision } from "@session-inbox/contracts"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import * as Dom from "foldkit/dom"
import { DaemonClient, type DaemonError } from "./client/daemonClient.ts"
import { Message, SnoozePreset } from "./message.ts"
import { type ActionKind, DraftBody } from "./model.ts"
import { snoozeUntil } from "./selectors.ts"

// COMMAND
//
// Every daemon call goes through the DaemonClient service; errors become
// Messages so a failed request never crashes the app.

const describe = (error: DaemonError | unknown): string =>
  error !== null && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error)

const newIdempotencyKey = Effect.sync(() => crypto.randomUUID())

export const FetchSnapshot = Command.define("FetchSnapshot", {
  messages: [Message.SucceededFetchSnapshot, Message.FailedFetchSnapshot],
  execute: Effect.gen(function* () {
    const client = yield* DaemonClient
    const snapshot = yield* client.snapshot
    return Message.SucceededFetchSnapshot({ snapshot })
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(Message.FailedFetchSnapshot({ error: describe(error) })),
    ),
  ),
})

export const WaitBeforeSnapshotRetry = Command.define("WaitBeforeSnapshotRetry", {
  messages: [Message.CompletedWaitBeforeSnapshotRetry],
  execute: Effect.sleep("3 seconds").pipe(Effect.as(Message.CompletedWaitBeforeSnapshotRetry())),
})

export const FetchItemDetail = Command.define("FetchItemDetail", {
  args: { itemId: Schema.String },
  messages: [Message.SucceededFetchItemDetail, Message.FailedFetchItemDetail],
  execute: ({ itemId }) =>
    Effect.gen(function* () {
      const client = yield* DaemonClient
      const detail = yield* client.itemDetail(itemId)
      return Message.SucceededFetchItemDetail({ detail })
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(Message.FailedFetchItemDetail({ itemId, error: describe(error) })),
      ),
    ),
})

const actionFailed = (action: ActionKind) => (error: unknown) =>
  Effect.succeed(Message.FailedAction({ action, error: describe(error) }))

export const SubmitAnswers = Command.define("SubmitAnswers", {
  args: { itemId: Schema.String, answers: Schema.Array(Answer) },
  messages: [Message.SucceededAction, Message.FailedAction],
  execute: ({ itemId, answers }) =>
    Effect.gen(function* () {
      const client = yield* DaemonClient
      const idempotencyKey = yield* newIdempotencyKey
      const response = yield* client.answers(itemId, { idempotencyKey, answers })
      return Message.SucceededAction({ action: "answers", itemId, response })
    }).pipe(Effect.catch(actionFailed("answers"))),
})

export const SendDecision = Command.define("SendDecision", {
  args: { itemId: Schema.String, decision: Decision },
  messages: [Message.SucceededAction, Message.FailedAction],
  execute: ({ itemId, decision }) =>
    Effect.gen(function* () {
      const client = yield* DaemonClient
      const idempotencyKey = yield* newIdempotencyKey
      const response = yield* client.decision(itemId, { idempotencyKey, decision })
      return Message.SucceededAction({ action: "decision", itemId, response })
    }).pipe(Effect.catch(actionFailed("decision"))),
})

export const SendReply = Command.define("SendReply", {
  args: { itemId: Schema.String, body: Schema.String },
  messages: [Message.SucceededAction, Message.FailedAction],
  execute: ({ itemId, body }) =>
    Effect.gen(function* () {
      const client = yield* DaemonClient
      const idempotencyKey = yield* newIdempotencyKey
      const response = yield* client.reply(itemId, { idempotencyKey, body })
      return Message.SucceededAction({ action: "reply", itemId, response })
    }).pipe(Effect.catch(actionFailed("reply"))),
})

export const SnoozeItem = Command.define("SnoozeItem", {
  args: { itemId: Schema.String, preset: SnoozePreset },
  messages: [Message.SucceededAction, Message.FailedAction],
  execute: ({ itemId, preset }) =>
    Effect.gen(function* () {
      const client = yield* DaemonClient
      const now = yield* Clock.currentTimeMillis
      const response = yield* client.snooze(itemId, { until: snoozeUntil(preset, now) })
      return Message.SucceededAction({ action: "snooze", itemId, response })
    }).pipe(Effect.catch(actionFailed("snooze"))),
})

export const DismissItem = Command.define("DismissItem", {
  args: { itemId: Schema.String },
  messages: [Message.SucceededAction, Message.FailedAction],
  execute: ({ itemId }) =>
    Effect.gen(function* () {
      const client = yield* DaemonClient
      const response = yield* client.dismiss(itemId)
      return Message.SucceededAction({ action: "dismiss", itemId, response })
    }).pipe(Effect.catch(actionFailed("dismiss"))),
})

export const MuteProject = Command.define("MuteProject", {
  args: { itemId: Schema.String, projectId: Schema.String, muted: Schema.Boolean },
  messages: [Message.SucceededAction, Message.FailedAction],
  execute: ({ itemId, projectId, muted }) =>
    Effect.gen(function* () {
      const client = yield* DaemonClient
      yield* client.mute(projectId, { muted })
      return Message.SucceededAction({ action: "mute", itemId, response: { ok: true, item: null } })
    }).pipe(Effect.catch(actionFailed("mute"))),
})

export const OpenInClaude = Command.define("OpenInClaude", {
  args: { itemId: Schema.String },
  messages: [Message.SucceededOpenInClaude, Message.FailedAction],
  execute: ({ itemId }) =>
    Effect.gen(function* () {
      const client = yield* DaemonClient
      const response = yield* client.open(itemId)
      return Message.SucceededOpenInClaude({ url: response.url })
    }).pipe(Effect.catch(actionFailed("open"))),
})

export const WaitBeforeDraftSave = Command.define("WaitBeforeDraftSave", {
  args: { version: Schema.Number },
  messages: [Message.CompletedWaitBeforeDraftSave],
  execute: ({ version }) =>
    Effect.sleep("500 millis").pipe(Effect.as(Message.CompletedWaitBeforeDraftSave({ version }))),
})

export const SaveDraft = Command.define("SaveDraft", {
  args: { itemId: Schema.String, body: DraftBody },
  messages: [Message.CompletedSaveDraft],
  execute: ({ itemId, body }) =>
    Effect.gen(function* () {
      const client = yield* DaemonClient
      yield* client.draft(itemId, { body })
      return Message.CompletedSaveDraft()
    }).pipe(Effect.catch(() => Effect.succeed(Message.CompletedSaveDraft()))),
})

export const MarkRead = Command.define("MarkRead", {
  args: { itemId: Schema.String },
  messages: [Message.CompletedMarkRead],
  execute: ({ itemId }) =>
    Effect.gen(function* () {
      const client = yield* DaemonClient
      yield* client.read(itemId)
      return Message.CompletedMarkRead()
    }).pipe(Effect.catch(() => Effect.succeed(Message.CompletedMarkRead()))),
})

/** replaceState, not location.hash=, so selecting doesn't spam history or fire hashchange. */
export const SetHash = Command.define("SetHash", {
  args: { hash: Schema.String },
  messages: [Message.CompletedSetHash],
  execute: ({ hash }) =>
    Effect.sync(() => {
      if (window.location.hash !== hash) {
        window.history.replaceState(null, "", hash)
      }
      return Message.CompletedSetHash()
    }),
})

// UPDATES (C-013): intents only; the daemon decides and streams the status back.

export const CheckForUpdates = Command.define("CheckForUpdates", {
  messages: [Message.SucceededUpdateRequest, Message.FailedUpdateRequest],
  execute: Effect.gen(function* () {
    const client = yield* DaemonClient
    const status = yield* client.updateCheck
    return Message.SucceededUpdateRequest({ status })
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(Message.FailedUpdateRequest({ error: describe(error) })),
    ),
  ),
})

export const ApplyUpdate = Command.define("ApplyUpdate", {
  args: { version: Schema.NullOr(Schema.String) },
  messages: [Message.SucceededUpdateRequest, Message.FailedUpdateRequest],
  execute: ({ version }) =>
    Effect.gen(function* () {
      const client = yield* DaemonClient
      const status = yield* client.updateApply(version === null ? {} : { version })
      return Message.SucceededUpdateRequest({ status })
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(Message.FailedUpdateRequest({ error: describe(error) })),
      ),
    ),
})

/** A window left open across an update loads the new build's assets (U-022). */
export const ReloadPage = Command.define("ReloadPage", {
  messages: [Message.CompletedReload],
  execute: Effect.sync(() => {
    window.location.reload()
    return Message.CompletedReload()
  }),
})

export const FocusTreeNode = Command.define("FocusTreeNode", {
  args: { nodeId: Schema.String },
  messages: [Message.CompletedFocusTreeNode],
  execute: ({ nodeId }) =>
    Dom.focus(`[data-tree-node="${CSS.escape(nodeId)}"]`).pipe(
      Effect.catch(() => Effect.void),
      Effect.as(Message.CompletedFocusTreeNode()),
    ),
})
