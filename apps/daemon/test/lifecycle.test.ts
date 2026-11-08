import { describe, expect, test } from "bun:test"
import type { AttentionKind, ItemState } from "@session-inbox/contracts"
import { Result } from "effect"
import {
  EVENT_TAGS,
  type EventTag,
  type LifecycleEvent,
  type LifecycleState,
  STATE_TAGS,
  transition,
} from "../src/domain/lifecycle.ts"

const NOW = 1000
const stateOf = (tag: ItemState): LifecycleState => {
  switch (tag) {
    case "snoozed":
      return { _tag: "snoozed", until: NOW }
    case "answered":
      return { _tag: "answered", at: NOW, unconfirmed: false }
    default:
      return { _tag: tag } as LifecycleState
  }
}
const eventOf = (tag: EventTag): LifecycleEvent => {
  switch (tag) {
    case "Snooze":
      return { _tag: "Snooze", until: NOW + 500 }
    case "Wake":
      return { _tag: "Wake", now: NOW }
    case "Answer":
      return { _tag: "Answer", at: NOW }
    default:
      return { _tag: tag } as LifecycleEvent
  }
}

/** Expected next state per (state, event) for a permission item; null = illegal. */
const TABLE: Record<ItemState, Record<EventTag, ItemState | null>> = {
  open: {
    Refresh: "open",
    Snooze: "snoozed",
    Wake: null,
    Answer: "answered",
    Confirm: null,
    MarkUnconfirmed: null,
    Supersede: "resolved",
    Expire: "expired",
    Dismiss: "dismissed",
  },
  snoozed: {
    Refresh: "snoozed",
    Snooze: "snoozed",
    Wake: "open",
    Answer: "answered",
    Confirm: null,
    MarkUnconfirmed: null,
    Supersede: "resolved",
    Expire: "expired",
    Dismiss: "dismissed",
  },
  answered: {
    Refresh: null,
    Snooze: null,
    Wake: null,
    Answer: null,
    Confirm: "resolved",
    MarkUnconfirmed: "answered",
    Supersede: "resolved",
    Expire: null,
    Dismiss: "dismissed",
  },
  resolved: Object.fromEntries(EVENT_TAGS.map((e) => [e, null])) as Record<EventTag, null>,
  expired: Object.fromEntries(EVENT_TAGS.map((e) => [e, null])) as Record<EventTag, null>,
  dismissed: Object.fromEntries(EVENT_TAGS.map((e) => [e, null])) as Record<EventTag, null>,
}

const KINDS: AttentionKind[] = ["question", "permission", "failed", "review"]

describe("transition: every state × every event × every kind", () => {
  for (const kind of KINDS)
    for (const s of STATE_TAGS)
      for (const e of EVENT_TAGS) {
        let expected = TABLE[s][e]
        if (e === "Expire" && kind !== "permission") expected = null // only permission items expire
        test(`${kind}: ${s} --${e}--> ${expected ?? "illegal"}`, () => {
          const r = transition({ kind, state: stateOf(s) }, eventOf(e))
          if (expected === null) {
            expect(Result.isFailure(r)).toBe(true)
            if (Result.isFailure(r)) {
              expect(r.failure._tag).toBe("IllegalTransition")
              expect(r.failure.from).toBe(s)
              expect(r.failure.event).toBe(e)
            }
          } else {
            expect(Result.isSuccess(r)).toBe(true)
            if (Result.isSuccess(r)) expect(r.success._tag).toBe(expected)
          }
        })
      }
})

describe("transition details", () => {
  test("wake before snooze_until is illegal", () => {
    const r = transition(
      { kind: "review", state: { _tag: "snoozed", until: NOW + 1 } },
      { _tag: "Wake", now: NOW },
    )
    expect(Result.isFailure(r)).toBe(true)
  })
  test("MarkUnconfirmed sets the flag once", () => {
    const r = transition(
      { kind: "question", state: { _tag: "answered", at: 1, unconfirmed: false } },
      { _tag: "MarkUnconfirmed" },
    )
    expect(Result.isSuccess(r) && r.success).toEqual({ _tag: "answered", at: 1, unconfirmed: true })
    const again = transition(
      { kind: "question", state: { _tag: "answered", at: 1, unconfirmed: true } },
      { _tag: "MarkUnconfirmed" },
    )
    expect(Result.isFailure(again)).toBe(true)
  })
  test("snooze carries the new until; refresh keeps it", () => {
    const s = transition({ kind: "review", state: { _tag: "open" } }, { _tag: "Snooze", until: 42 })
    expect(Result.isSuccess(s) && s.success).toEqual({ _tag: "snoozed", until: 42 })
    const r = transition(
      { kind: "review", state: { _tag: "snoozed", until: 42 } },
      { _tag: "Refresh" },
    )
    expect(Result.isSuccess(r) && r.success).toEqual({ _tag: "snoozed", until: 42 })
  })
})
