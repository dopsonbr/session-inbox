import type { ShortcutAction } from "@session-inbox/contracts"
import { Duration, Effect, Option, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import * as Dom from "foldkit/dom"
import { DaemonClient, DaemonError } from "./client/daemonClient.ts"
import { Message } from "./message.ts"
import type { Model } from "./model.ts"
import { SettingsMessage } from "./settings.ts"
import {
  bindingTable,
  isModifierOnly,
  type ModKey,
  type ShortcutBindings,
  shortcutTyping,
} from "./shortcuts.ts"
import { Toast } from "./toast.ts"

// SUBSCRIPTION

/** 0.5 s, 1 s, 2 s … capped at 15 s. */
export const backoffDelay = (failures: number): Duration.Duration =>
  Duration.millis(Math.min(15_000, 500 * 2 ** Math.max(0, failures)))

/**
 * One long-lived Stream per snapshot epoch. Each connection resumes from the
 * latest seq the Model has seen (read live, so a reconnect never replays what
 * we already merged); drops and clean ends both reconnect with backoff.
 */
const daemonStream = (readSince: () => number): Stream.Stream<Message, never, DaemonClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* DaemonClient
      let failures = 0
      const connect = (): Stream.Stream<Message> =>
        Stream.suspend(() => client.stream(readSince())).pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              failures = 0
            }),
          ),
          Stream.map((message) => Message.ReceivedStreamMessage({ message })),
          Stream.concat(Stream.fail(new DaemonError({ message: "Stream closed", status: null }))),
          Stream.catch((error: DaemonError) => {
            const delay = backoffDelay(failures)
            failures += 1
            return Stream.make(Message.DisconnectedStream({ error: error.message })).pipe(
              Stream.concat(Stream.drain(Stream.fromEffect(Effect.sleep(delay)))),
              Stream.concat(Stream.suspend(connect)),
            )
          }),
        )
      return connect()
    }),
  )

/** What Foldkit resolves `Mod` to; the table uses it too so duplicates are found the same way. */
const modKey: ModKey =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
    ? "Meta"
    : "Control"

const hasModifier = (event: KeyboardEvent) =>
  event.metaKey || event.ctrlKey || event.altKey || event.shiftKey

/** The factual message for a page shortcut; update decides what it means (U-060, U-073). */
const shortcutMessage = (
  action: Exclude<ShortcutAction, "openInbox">,
  readsTyping: boolean,
  event: KeyboardEvent,
): Message => {
  switch (action) {
    case "jump":
      return Message.PressedJumpShortcut()
    case "submit":
      return Message.PressedSubmitShortcut({
        typing: readsTyping ? shortcutTyping(event.composedPath()) : "none",
      })
    case "deny":
      return Message.PressedDenyShortcut()
    case "next":
      return Message.PressedListKey({ direction: "next" })
    case "previous":
      return Message.PressedListKey({ direction: "previous" })
    case "done":
      return Message.PressedDoneShortcut()
    case "settings":
      return Message.GotSettingsMessage({ message: SettingsMessage.RequestedOpen() })
    case "help":
      return Message.PressedShortcutsKey()
  }
}

export const subscriptions = Subscription.aggregate(
  Subscription.make<Model, Message, DaemonClient>()((entry) => ({
    daemonStream: entry(
      { isReady: Schema.Boolean, epoch: Schema.Number, seq: Schema.Number },
      {
        modelToDependencies: (model) => ({
          isReady: Option.isSome(model.maybeSnapshot),
          epoch: model.streamEpoch,
          seq: Option.match(model.maybeSnapshot, { onNone: () => 0, onSome: (s) => s.seq }),
        }),
        // Deltas move seq constantly; only a new epoch (fresh snapshot) restarts the stream.
        keepAliveEquivalence: (a, b) => a.isReady === b.isReady && a.epoch === b.epoch,
        dependenciesToStream: ({ isReady }, readDependencies) =>
          isReady ? daemonStream(() => readDependencies().seq) : Stream.empty,
      },
    ),

    keyboard: entry(
      {
        isFull: Schema.Boolean,
        isRecording: Schema.Boolean,
        bindings: Schema.Record(Schema.String, Schema.String),
      },
      {
        modelToDependencies: (model) => ({
          isFull: model.view === "full",
          isRecording: model.settings.recording !== null,
          bindings: model.shortcuts,
        }),
        // The bindings are dependencies: a new key press for an action rebuilds the table (U-078).
        dependenciesToStream: ({ isFull, isRecording, bindings }) =>
          Dom.streamFromKeyBindings<Message>({
            modKey,
            bindings: bindingTable(bindings as ShortcutBindings, { isRecording, modKey }).map(
              (entry) => ({
                keys: entry.keys,
                isEnabled: isFull,
                whileTyping: entry.whileTyping,
                mapEvent: (event: KeyboardEvent) =>
                  shortcutMessage(entry.action, entry.readsTyping, event),
              }),
            ),
          }),
      },
    ),

    // While a Settings row records a key press, every keydown goes to it first (U-078).
    recording: entry(
      { isRecording: Schema.Boolean },
      {
        modelToDependencies: (model) => ({ isRecording: model.settings.recording !== null }),
        dependenciesToStream: ({ isRecording }) =>
          isRecording
            ? Dom.streamFromEventFilterMap({
                target: window,
                type: "keydown",
                options: { capture: true },
                filterMapEvent: (event) => {
                  // A modifier on its own waits for the key; Tab still moves focus (to Cancel).
                  if (isModifierOnly(event) || (event.key === "Tab" && !hasModifier(event))) {
                    return Option.none()
                  }
                  event.preventDefault()
                  event.stopImmediatePropagation()
                  return Option.some(
                    Message.GotSettingsMessage({
                      message: SettingsMessage.PressedRecordingKey({
                        press: {
                          key: event.key,
                          code: event.code,
                          metaKey: event.metaKey,
                          ctrlKey: event.ctrlKey,
                          altKey: event.altKey,
                          shiftKey: event.shiftKey,
                        },
                      }),
                    }),
                  )
                },
              })
            : Stream.empty,
      },
    ),

    hash: Subscription.persistentEntry(
      Dom.streamFromEvent({
        target: window,
        type: "hashchange",
        mapEvent: () => Message.ChangedHash({ hash: window.location.hash }),
      }),
    ),

    clock: Subscription.persistentEntry(
      Stream.tick("30 seconds").pipe(
        Stream.mapEffect(() => Effect.clockWith((clock) => clock.currentTimeMillis)),
        Stream.map((now) => Message.TickedClock({ now })),
      ),
    ),
  })),
  Subscription.lift(Toast.subscriptions)<Model, Message>({
    read: (model) => Option.some(model.toasts),
    toParentMessage: (message) => Message.GotToastMessage({ message }),
  }),
)
