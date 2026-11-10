/**
 * The UI's only door to the daemon. Commands and Subscriptions depend on this
 * service; `entry.ts` provides either the HTTP or the fake implementation.
 */
import type {
  ActionResponse,
  AnswersRequest,
  DecisionRequest,
  DraftRequest,
  ItemDetail,
  MuteRequest,
  OpenResponse,
  ReplyRequest,
  Snapshot,
  SnoozeRequest,
  StreamMessage,
  UpdateApplyRequest,
  UpdateStatus,
} from "@session-inbox/contracts"
import { Context, Data, type Effect, type Stream } from "effect"

export class DaemonError extends Data.TaggedError("DaemonError")<{
  readonly message: string
  readonly status: number | null
}> {}

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
  /** Update status and intents (C-013); the daemon decides, these only ask. */
  updateStatus: Effect.Effect<UpdateStatus, DaemonError>
  updateCheck: Effect.Effect<UpdateStatus, DaemonError>
  updateApply: (body: UpdateApplyRequest) => Effect.Effect<UpdateStatus, DaemonError>
}>

export class DaemonClient extends Context.Service<DaemonClient, DaemonClientShape>()(
  "SessionInbox/DaemonClient",
) {}
