/**
 * Attention-item lifecycle: a tagged-union state and a pure transition function.
 * No IO, no clock — callers pass times in. Exhaustively tested in lifecycle.test.ts.
 */
import type { AttentionKind, ItemState } from "@session-inbox/contracts"
import { Data, Result } from "effect"

export type LifecycleState =
  | { readonly _tag: "open" }
  | { readonly _tag: "snoozed"; readonly until: number }
  | { readonly _tag: "answered"; readonly at: number; readonly unconfirmed: boolean }
  | { readonly _tag: "resolved" }
  | { readonly _tag: "expired" }
  | { readonly _tag: "dismissed" }

export type LifecycleEvent =
  /** A repeat event for the same dedupe key: refresh, never re-notify. */
  | { readonly _tag: "Refresh" }
  | { readonly _tag: "Snooze"; readonly until: number }
  /** Timer: snooze_until reached. */
  | { readonly _tag: "Wake"; readonly now: number }
  /** User answered / decided. */
  | { readonly _tag: "Answer"; readonly at: number }
  /** A later event from the session confirmed the answer landed. */
  | { readonly _tag: "Confirm" }
  /** Timer: no confirming event within the window. */
  | { readonly _tag: "MarkUnconfirmed" }
  /** New activity made the item stale (e.g. review after the session moved on). */
  | { readonly _tag: "Supersede" }
  /** Hook hold budget lapsed. Only permission items expire. */
  | { readonly _tag: "Expire" }
  | { readonly _tag: "Dismiss" }

export type EventTag = LifecycleEvent["_tag"]
export const EVENT_TAGS: ReadonlyArray<EventTag> = [
  "Refresh",
  "Snooze",
  "Wake",
  "Answer",
  "Confirm",
  "MarkUnconfirmed",
  "Supersede",
  "Expire",
  "Dismiss",
]
export const STATE_TAGS: ReadonlyArray<ItemState> = [
  "open",
  "snoozed",
  "answered",
  "resolved",
  "expired",
  "dismissed",
]

export class IllegalTransition extends Data.TaggedError("IllegalTransition")<{
  readonly from: ItemState
  readonly event: EventTag
  readonly reason: string
}> {}

export interface Subject {
  readonly kind: AttentionKind
  readonly state: LifecycleState
}

const illegal = (from: ItemState, event: EventTag, reason: string) =>
  Result.fail(new IllegalTransition({ from, event, reason }))

export const isTerminal = (s: LifecycleState): boolean =>
  s._tag === "resolved" || s._tag === "expired" || s._tag === "dismissed"

export const transition = (
  subject: Subject,
  event: LifecycleEvent,
): Result.Result<LifecycleState, IllegalTransition> => {
  const s = subject.state
  const from = s._tag
  if (isTerminal(s)) return illegal(from, event._tag, "terminal state")

  switch (event._tag) {
    case "Refresh":
      if (s._tag === "open" || s._tag === "snoozed") return Result.succeed(s)
      return illegal(from, event._tag, "only open/snoozed items refresh; a new item is created")
    case "Snooze":
      if (s._tag === "open" || s._tag === "snoozed")
        return Result.succeed({ _tag: "snoozed", until: event.until })
      return illegal(from, event._tag, "only open/snoozed items can be snoozed")
    case "Wake":
      if (s._tag !== "snoozed") return illegal(from, event._tag, "not snoozed")
      if (event.now < s.until) return illegal(from, event._tag, "snooze not over yet")
      return Result.succeed({ _tag: "open" })
    case "Answer":
      if (s._tag === "open" || s._tag === "snoozed")
        return Result.succeed({ _tag: "answered", at: event.at, unconfirmed: false })
      return illegal(from, event._tag, "already answered")
    case "Confirm":
      if (s._tag === "answered") return Result.succeed({ _tag: "resolved" })
      return illegal(from, event._tag, "nothing to confirm")
    case "MarkUnconfirmed":
      if (s._tag === "answered" && !s.unconfirmed)
        return Result.succeed({ _tag: "answered", at: s.at, unconfirmed: true })
      return illegal(from, event._tag, "not an answered, still-confirming item")
    case "Supersede":
      return Result.succeed({ _tag: "resolved" })
    case "Expire":
      if (subject.kind !== "permission")
        return illegal(from, event._tag, "only permission items expire")
      if (s._tag === "open" || s._tag === "snoozed") return Result.succeed({ _tag: "expired" })
      return illegal(from, event._tag, "already decided")
    case "Dismiss":
      return Result.succeed({ _tag: "dismissed" })
  }
}

/** Row ↔ state helpers. */
export const stateFromRow = (row: {
  state: string
  snooze_until: number | null
  answered_at: number | null
  unconfirmed: number
}): LifecycleState => {
  switch (row.state as ItemState) {
    case "open":
      return { _tag: "open" }
    case "snoozed":
      return { _tag: "snoozed", until: row.snooze_until ?? 0 }
    case "answered":
      return { _tag: "answered", at: row.answered_at ?? 0, unconfirmed: row.unconfirmed === 1 }
    case "resolved":
      return { _tag: "resolved" }
    case "expired":
      return { _tag: "expired" }
    case "dismissed":
      return { _tag: "dismissed" }
  }
}
