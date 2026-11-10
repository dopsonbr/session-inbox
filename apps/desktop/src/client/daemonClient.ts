/**
 * The UI's only door to the daemon. Commands and Subscriptions depend on this
 * service; `entry.ts` provides either the HTTP or the fake implementation.
 */
import type {
  ActionResponse,
  AnswersRequest,
  DecisionRequest,
  DoctorReport,
  DraftRequest,
  ItemDetail,
  MuteRequest,
  OpenResponse,
  ReplyRequest,
  SettingsResponse,
  Snapshot,
  SnoozeRequest,
  StreamMessage,
  UpdateApplyRequest,
  UpdateStatus,
  UserSettingsPatch,
} from "@session-inbox/contracts"
import { Context, Data, type Effect, type Option, Schema, type Stream } from "effect"

export class DaemonError extends Data.TaggedError("DaemonError")<{
  readonly message: string
  readonly status: number | null
}> {}

/**
 * What POST /v1/doctor/notify answered. The contracts don't type this body, so the UI reads
 * it leniently: `via` is where the daemon sent the test (shell | fallback | none), when it
 * says so (U-034).
 */
export const TestNotifyResult = Schema.Struct({
  via: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
})
export type TestNotifyResult = typeof TestNotifyResult.Type

export type DaemonClientShape = Readonly<{
  snapshot: Effect.Effect<Snapshot, DaemonError>
  /** One connection. Ends (or fails) when the connection drops; the caller reconnects. */
  stream: (since: number | null) => Stream.Stream<StreamMessage, DaemonError>
  itemDetail: (itemId: string) => Effect.Effect<ItemDetail, DaemonError>
  answers: (itemId: string, body: AnswersRequest) => Effect.Effect<ActionResponse, DaemonError>
  decision: (itemId: string, body: DecisionRequest) => Effect.Effect<ActionResponse, DaemonError>
  reply: (itemId: string, body: ReplyRequest) => Effect.Effect<ActionResponse, DaemonError>
  snooze: (itemId: string, body: SnoozeRequest) => Effect.Effect<ActionResponse, DaemonError>
  dismiss: (itemId: string) => Effect.Effect<ActionResponse, DaemonError>
  draft: (itemId: string, body: DraftRequest) => Effect.Effect<void, DaemonError>
  read: (itemId: string) => Effect.Effect<void, DaemonError>
  open: (itemId: string) => Effect.Effect<OpenResponse, DaemonError>
  mute: (projectId: string, body: MuteRequest) => Effect.Effect<void, DaemonError>
  getSettings: Effect.Effect<SettingsResponse, DaemonError>
  /** Only the changed keys; `null` resets one. The daemon answers with what it applied. */
  putSettings: (patch: UserSettingsPatch) => Effect.Effect<SettingsResponse, DaemonError>
  /** Update status and intents (C-013); the daemon decides, these only ask. */
  updateStatus: Effect.Effect<UpdateStatus, DaemonError>
  updateCheck: Effect.Effect<UpdateStatus, DaemonError>
  updateApply: (body: UpdateApplyRequest) => Effect.Effect<UpdateStatus, DaemonError>
  /** Setup check (C-021). None when this daemon has no /v1/doctor (404): show nothing. */
  doctor: Effect.Effect<Option.Option<DoctorReport>, DaemonError>
  doctorNotify: Effect.Effect<TestNotifyResult, DaemonError>
}>

export class DaemonClient extends Context.Service<DaemonClient, DaemonClientShape>()(
  "SessionInbox/DaemonClient",
) {}
