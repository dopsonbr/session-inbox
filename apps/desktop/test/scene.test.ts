/**
 * Whole-window renders through Foldkit's Scene runtime (submodels included), for the states
 * the visual pass will look at: Setup, a review item's last message, reply-unavailable.
 */
import { describe, expect, test } from "bun:test"
import type { DoctorReport } from "@session-inbox/contracts"
import { Effect, Option } from "effect"
import { given, scene, tap } from "foldkit/scene"
import { makeFakeClient } from "../src/client/fake.ts"
import { fakeDoctorReport } from "../src/client/fakeDoctor.ts"
import { Message } from "../src/message.ts"
import type { Model } from "../src/model.ts"
import { initialModel, type UpdateReturn, update } from "../src/update.ts"
import { view } from "../src/view/index.ts"
import { findAll, textOf } from "./vnode.ts"

const NOW = 1_800_000_000_000
const run = (start: Model, ...messages: ReadonlyArray<Message>): UpdateReturn =>
  messages.reduce<UpdateReturn>((acc, m) => update(acc.model, m), { model: start })

const window = (itemId: string | null, ...more: ReadonlyArray<Message>): Model => {
  const c = makeFakeClient({ now: () => NOW, simulate: false, delayScale: 0 })
  const base = initialModel({
    view: "full",
    now: NOW,
    maybeInitialItemId: itemId === null ? Option.none() : Option.some(itemId),
  })
  return run(
    base,
    Message.SucceededFetchSnapshot({ snapshot: Effect.runSync(c.snapshot) }),
    ...(itemId === null
      ? []
      : [Message.SucceededFetchItemDetail({ detail: Effect.runSync(c.itemDetail(itemId)) })]),
    Message.SucceededFetchDoctor({
      report: fakeDoctorReport("attention", NOW) as DoctorReport,
    }),
    ...more,
  ).model
}

const rendered = (model: Model): { text: string; html: unknown } => {
  let out = { text: "", html: null as unknown }
  scene(
    { update, view },
    given(model),
    tap((simulation) => {
      out = { text: textOf(simulation.html), html: simulation.html }
    }),
  )
  return out
}

describe("whole window", () => {
  test("review item: last message, reply box, nav Setup badge", () => {
    const { text, html } = rendered(window("i-receipts-review"))
    expect(text).toContain("Claude's last message")
    expect(text).toContain("Short reply")
    expect(text).toContain("Setup check2")
    expect(findAll(html, "textarea")).toHaveLength(1)
  })

  test("reply unavailable: no textarea", () => {
    const { text, html } = rendered(window("i-docs-review"))
    expect(text).toContain("isn't logged in on this Mac")
    expect(findAll(html, "textarea")).toHaveLength(0)
  })

  test("Setup route replaces queue and detail", () => {
    const { text } = rendered(window(null, Message.ChangedHash({ hash: "#/setup" })))
    expect(text).toContain("Setup")
    expect(text).toContain("Notifications are turned off for Session Inbox")
    expect(text).not.toContain("Routine progress never shows up here")
  })
})
