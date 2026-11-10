import { Duration, Effect, Option, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import * as Dom from "foldkit/dom"
import { DaemonClient, DaemonError } from "./client/daemonClient.ts"
import { Message } from "./message.ts"
import type { Model } from "./model.ts"
import { SettingsMessage } from "./settings.ts"
import { shortcutTyping } from "./shortcuts.ts"
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
      { isFull: Schema.Boolean },
      {
        modelToDependencies: (model) => ({ isFull: model.view === "full" }),
        dependenciesToStream: ({ isFull }) =>
          Dom.streamFromKeyBindings<Message>({
            bindings: [
              {
                keys: "Mod+K",
                isEnabled: isFull,
                whileTyping: "Allow",
                mapEvent: () => Message.PressedJumpShortcut(),
              },
              {
                keys: "Mod+Enter",
                isEnabled: isFull,
                whileTyping: "Allow",
                mapEvent: (event) =>
                  Message.PressedSubmitShortcut({ typing: shortcutTyping(event.composedPath()) }),
              },
              {
                // Suppressed while typing so ⌘⌫ still deletes a line in a text field.
                keys: "Mod+Backspace",
                isEnabled: isFull,
                mapEvent: () => Message.PressedDenyShortcut(),
              },
              {
                keys: "Mod+,",
                isEnabled: isFull,
                whileTyping: "Allow",
                mapEvent: () =>
                  Message.GotSettingsMessage({ message: SettingsMessage.RequestedOpen() }),
              },
            ],
          }),
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
