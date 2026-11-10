import { describe, expect, test } from "bun:test"
import type { StreamMessage, UpdateStatus } from "@session-inbox/contracts"
import { Effect, Option, Stream } from "effect"
import { fakeUpdateStatus, makeFakeClient } from "../src/client/fake.ts"
import { Message } from "../src/message.ts"
import type { Model } from "../src/model.ts"
import { initialModel, type UpdateReturn, update, updateBannerKey } from "../src/update.ts"

const NOW = 1_800_000_000_000
const fresh = (): Model =>
  initialModel({ view: "full", now: NOW, maybeInitialItemId: Option.none() })
const names = (ret: UpdateReturn) => (ret.commands ?? []).map((c) => c.name)
const firstArgs = (ret: UpdateReturn): unknown =>
  (ret.commands?.[0] as unknown as { args: unknown } | undefined)?.args
const hello = (version?: string, build?: string): Message =>
  Message.ReceivedStreamMessage({
    message: {
      _tag: "hello",
      seq: 1,
      ...(version ? { version } : {}),
      ...(build ? { build } : {}),
    },
  })
const status = (kind: string, patch: Partial<UpdateStatus> = {}): UpdateStatus => ({
  ...fakeUpdateStatus(kind, NOW),
  ...patch,
})
const streamed = (s: UpdateStatus): Message =>
  Message.ReceivedStreamMessage({ message: { _tag: "update", seq: 1, status: s } })
const toastTitles = (model: Model) =>
  (
    model.toasts as unknown as { entries: ReadonlyArray<{ payload: { title: string } }> }
  ).entries.map((e) => e.payload.title)

describe("reload on a new daemon build", () => {
  test("first hello is remembered; the same build again does nothing", () => {
    const a = update(fresh(), hello("0.1.0", "abc"))
    expect(a.model.maybeDaemonBuild).toEqual(Option.some("0.1.0·abc"))
    expect(names(a)).toEqual([])
    expect(names(update(a.model, hello("0.1.0", "abc")))).toEqual([])
  })
  test("a reconnect to a different build or version reloads the page", () => {
    const a = update(fresh(), hello("0.1.0", "abc")).model
    expect(names(update(a, hello("0.1.0", "def")))).toEqual(["ReloadPage"])
    expect(names(update(a, hello("0.3.0", "abc")))).toEqual(["ReloadPage"])
  })
  test("an old daemon's hello (no build) never reloads", () => {
    const a = update(fresh(), hello()).model
    expect(a.maybeDaemonBuild).toEqual(Option.none())
    expect(names(update(update(a, hello()).model, hello("0.1.0", "x")))).toEqual([])
  })
})

describe("update status and intents", () => {
  test("a streamed status is stored verbatim", () => {
    const s = status("available")
    expect(update(fresh(), streamed(s)).model.maybeUpdate).toEqual(Option.some(s))
  })
  test("just updated: one toast on the first status, not on later ones", () => {
    const a = update(fresh(), streamed(status("updated")))
    expect(toastTitles(a.model)).toEqual(["Session Inbox updated to 0.1.0"])
    const b = update(a.model, streamed(status("updated")))
    expect(toastTitles(b.model)).toHaveLength(1)
    const old = update(fresh(), streamed(status("updated", { updatedAt: NOW - 3600_000 })))
    expect(toastTitles(old.model)).toEqual([])
  })
  test("Update now sends the offered version once", () => {
    const a = update(fresh(), streamed(status("available"))).model
    const clicked = update(a, Message.ClickedUpdateNow())
    expect(names(clicked)).toEqual(["ApplyUpdate"])
    expect(firstArgs(clicked)).toEqual({
      version: "0.3.0",
    })
    expect(clicked.model.updateRequest).toBe("Applying")
    expect(names(update(clicked.model, Message.ClickedUpdateNow()))).toEqual([])
    const done = update(
      clicked.model,
      Message.SucceededUpdateRequest({ status: status("updating") }),
    )
    expect(done.model.updateRequest).toBe("Idle")
    expect(Option.map(done.model.maybeUpdate, (s) => s.state)).toEqual(Option.some("updating"))
  })
  test("Try again on a failed update targets the failed version", () => {
    const a = update(fresh(), streamed(status("failed", { latest: null }))).model
    const clicked = update(a, Message.ClickedUpdateNow())
    expect(firstArgs(clicked)).toEqual({
      version: "0.3.0",
    })
  })
  test("Check for updates: up to date / error toasts; available shows the banner", () => {
    const a = update(fresh(), streamed(status("idle"))).model
    const checking = update(a, Message.ClickedCheckForUpdates())
    expect(names(checking)).toEqual(["CheckForUpdates"])
    expect(checking.model.updateRequest).toBe("Checking")
    expect(names(update(checking.model, Message.ClickedCheckForUpdates()))).toEqual([])
    const upToDate = update(
      checking.model,
      Message.SucceededUpdateRequest({ status: status("idle") }),
    )
    expect(toastTitles(upToDate.model)).toEqual(["Session Inbox is up to date"])
    const errored = update(
      checking.model,
      Message.SucceededUpdateRequest({ status: status("idle", { error: "offline" }) }),
    )
    expect(toastTitles(errored.model)).toEqual(["Couldn't check for updates"])
    const found = update(
      checking.model,
      Message.SucceededUpdateRequest({ status: status("available") }),
    )
    expect(toastTitles(found.model)).toEqual([])
    const failed = update(checking.model, Message.FailedUpdateRequest({ error: "409" }))
    expect(failed.model.updateRequest).toBe("Idle")
    expect(toastTitles(failed.model)).toEqual(["Update request failed"])
  })
  test("Not now hides this state/version only", () => {
    const a = update(fresh(), streamed(status("available"))).model
    const dismissed = update(a, Message.DismissedUpdateBanner()).model
    expect(dismissed.maybeDismissedUpdate).toEqual(
      Option.some(updateBannerKey(status("available"))),
    )
    const updating = update(dismissed, streamed(status("updating"))).model
    expect(
      Option.contains(updating.maybeDismissedUpdate, updateBannerKey(status("updating"))),
    ).toBe(false)
  })
})

describe("fake client updates", () => {
  const firstMessages = (kind: string | undefined, n: number) =>
    Effect.runPromise(
      makeFakeClient({ now: () => NOW, simulate: false, delayScale: 0, update: kind })
        .stream(null)
        .pipe(Stream.take(n), Stream.runCollect),
    ).then((c) => Array.from(c) as StreamMessage[])

  test("?update=available sends hello (with build) then the status", async () => {
    const msgs = await firstMessages("available", 2)
    expect(msgs[0]).toMatchObject({ _tag: "hello", version: "0.1.0", build: "fake000" })
    expect(msgs[1]).toMatchObject({ _tag: "update", status: { state: "available" } })
  })
  test("apply moves to updating; applying again is a 409", async () => {
    const c = makeFakeClient({ now: () => NOW, simulate: false, delayScale: 0, update: "source" })
    const s = await Effect.runPromise(c.updateApply({}))
    expect(s).toMatchObject({ state: "updating", target: "0.3.0" })
    const again = await Effect.runPromise(Effect.flip(c.updateApply({})))
    expect(again.status).toBe(409)
  })
})
