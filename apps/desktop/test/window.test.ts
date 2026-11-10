/**
 * The app as a window (U-089, U-090): the "Window and menu bar" setting, and the popover row a
 * notification pointed at (`#/item/<id>` with `app.opens` "popover").
 */
import { describe, expect, test } from "bun:test"
import type { Item, Snapshot, UserSettingsPatch } from "@session-inbox/contracts"
import { Effect, Option } from "effect"
import { makeFakeClient } from "../src/client/fake.ts"
import { Message } from "../src/message.ts"
import type { Model } from "../src/model.ts"
import { SETTINGS_GROUPS, SettingsMessage } from "../src/settings.ts"
import { init, initialModel, type UpdateReturn, update } from "../src/update.ts"
import { COMPACT_REVIEW_LIMIT, compactLists, compactView } from "../src/view/compact.ts"
import { settingsBody } from "../src/view/settings.ts"
import { attrOf, findAll, h, textOf } from "./vnode.ts"

const NOW = 1_800_000_000_000
const client = (options: Parameters<typeof makeFakeClient>[0] = {}) =>
  makeFakeClient({ now: () => NOW, simulate: false, delayScale: 0, ...options })
const names = (ret: UpdateReturn) => (ret.commands ?? []).map((c) => c.name)
const run = (start: Model, ...messages: ReadonlyArray<Message>): UpdateReturn =>
  messages.reduce<UpdateReturn>((acc, m) => update(acc.model, m), { model: start })
const s = (message: SettingsMessage): Message => Message.GotSettingsMessage({ message })

const popover = (snapshot: Snapshot): Model =>
  update(
    initialModel({ view: "compact", now: NOW, maybeInitialItemId: Option.none() }),
    Message.SucceededFetchSnapshot({ snapshot }),
  ).model
const snapshotOf = (options: Parameters<typeof makeFakeClient>[0] = {}): Snapshot =>
  Effect.runSync(client(options).snapshot)
const inQueue = (snapshot: Snapshot, queue: Item["queue"]) =>
  snapshot.items.filter((i) => i.queue === queue)

/** The `li` rows of the popover, with whether each is marked. */
const rows = (model: Model) =>
  findAll(compactView(model, h), "li").map((li) => {
    const link = findAll(li, "a")[0]
    return {
      href: link === undefined ? "" : String(attrOf(link, "href")),
      isMarked: link !== undefined && attrOf(link, "aria-current") === "true",
    }
  })

describe("Settings: Window and menu bar (U-089)", () => {
  test("its own group, before Shortcuts, with the three click-routing choices", () => {
    expect(SETTINGS_GROUPS.map((g) => g.title)).toEqual([
      "Approvals",
      "Notifications",
      "Sessions",
      "Storage",
      "Updates",
      "Window and menu bar",
      "Shortcuts",
    ])
    const opened = run(
      initialModel({ view: "full", now: NOW, maybeInitialItemId: Option.none() }),
      s(SettingsMessage.RequestedOpen()),
      s(
        SettingsMessage.SucceededFetchSettings({
          response: Effect.runSync(client().getSettings),
        }),
      ),
    ).model
    const body = settingsBody(opened, h)
    const text = textOf(body)
    expect(text).toContain("Window and menu bar")
    expect(text).toContain("Notification clicks and the menu-bar icon")
    const radios = findAll(body, "input").filter((i) => attrOf(i, "name") === "setting-app-opens")
    expect(radios.map((r) => attrOf(r, "value"))).toEqual(["window", "popover", "windowFirst"])
    expect(radios.map((r) => attrOf(r, "checked"))).toEqual([true, false, false])
  })

  test("choosing one saves it", () => {
    const opened = run(
      initialModel({ view: "full", now: NOW, maybeInitialItemId: Option.none() }),
      s(SettingsMessage.RequestedOpen()),
      s(
        SettingsMessage.SucceededFetchSettings({
          response: Effect.runSync(client().getSettings),
        }),
      ),
    ).model
    const ret = update(
      opened,
      s(SettingsMessage.ChoseSetting({ key: "app.opens", value: "popover" })),
    )
    const command = (ret.commands ?? []).find((c) => c.name === "SaveSettings") as unknown as {
      args: { patch: UserSettingsPatch }
    }
    expect(command.args.patch).toEqual({ "app.opens": "popover" })
    expect(
      names(update(opened, s(SettingsMessage.ChoseSetting({ key: "app.opens", value: "dock" })))),
    ).toEqual([])
  })
})

describe("popover: the row a notification pointed at (U-090)", () => {
  test("#/item/<id> marks that row and scrolls to it, without fetching a detail", () => {
    const snapshot = snapshotOf()
    const target = inQueue(snapshot, "needs-you")[1] as Item
    const ret = update(popover(snapshot), Message.ChangedHash({ hash: `#/item/${target.id}` }))
    expect(names(ret)).toEqual(["ScrollToRow"])
    expect(ret.model.detail._tag).toBe("Idle")
    const marked = rows(ret.model).filter((r) => r.isMarked)
    expect(marked).toEqual([{ href: `/#/item/${target.id}`, isMarked: true }])
  })

  test("#/ clears the mark; an id not in the snapshot marks nothing and breaks nothing", () => {
    const snapshot = snapshotOf()
    const target = inQueue(snapshot, "needs-you")[0] as Item
    const marked = update(popover(snapshot), Message.ChangedHash({ hash: `#/item/${target.id}` }))
    const cleared = update(marked.model, Message.ChangedHash({ hash: "#/" }))
    expect(cleared.model.maybeSelectedItemId).toEqual(Option.none())
    expect(rows(cleared.model).some((r) => r.isMarked)).toBe(false)
    const unknown = update(popover(snapshot), Message.ChangedHash({ hash: "#/item/i-gone" }))
    expect(rows(unknown.model).some((r) => r.isMarked)).toBe(false)
    expect(rows(unknown.model).length).toBe(rows(popover(snapshot)).length)
  })

  test("a review item is listed while something needs you, so the mark has a row", () => {
    const snapshot = snapshotOf()
    const review = inQueue(snapshot, "review")[0] as Item
    expect(inQueue(snapshot, "needs-you").length).toBeGreaterThan(0)
    const ret = update(popover(snapshot), Message.ChangedHash({ hash: `#/item/${review.id}` }))
    expect(textOf(compactView(ret.model, h))).toContain("Ready to review")
    expect(rows(ret.model).filter((r) => r.isMarked)).toEqual([
      { href: `/#/item/${review.id}`, isMarked: true },
    ])
    // Without a mark, review items stay hidden while something needs you.
    expect(compactLists(popover(snapshot), snapshot).review).toEqual([])
  })

  test("a review item beyond the first few is still listed when it is marked", () => {
    const base = snapshotOf({ needs: "none" })
    const template = inQueue(base, "review")[0] as Item
    const extra = Array.from({ length: COMPACT_REVIEW_LIMIT + 2 }, (_, i) => ({
      ...template,
      id: `i-extra-${i}`,
    }))
    const snapshot = { ...base, items: [...base.items, ...extra] }
    const last = extra[extra.length - 1] as Item
    const ret = update(popover(snapshot), Message.ChangedHash({ hash: `#/item/${last.id}` }))
    const lists = compactLists(ret.model, snapshot)
    expect(lists.review.length).toBe(COMPACT_REVIEW_LIMIT + 1)
    expect(lists.review.at(-1)?.id).toBe(last.id)
    expect(
      rows(ret.model)
        .filter((r) => r.isMarked)
        .map((r) => r.href),
    ).toEqual([`/#/item/${last.id}`])
  })

  test("booting the popover on #/item/<id> fetches no detail; the snapshot scrolls to the row", () => {
    const snapshot = snapshotOf()
    const target = inQueue(snapshot, "needs-you")[1] as Item
    const booted = init({ view: "compact", now: NOW, maybeInitialItemId: Option.some(target.id) })
    expect(names(booted)).toEqual(["FetchSnapshot"])
    expect(booted.model.detail._tag).toBe("Idle")
    const loaded = update(booted.model, Message.SucceededFetchSnapshot({ snapshot }))
    expect(names(loaded)).toEqual(["ScrollToRow"])
    expect(rows(loaded.model).filter((r) => r.isMarked).length).toBe(1)
  })

  test("the main window still selects on #/item/<id> and fetches the detail", () => {
    const snapshot = snapshotOf()
    const target = inQueue(snapshot, "needs-you")[1] as Item
    const full = update(
      initialModel({ view: "full", now: NOW, maybeInitialItemId: Option.none() }),
      Message.SucceededFetchSnapshot({ snapshot }),
    ).model
    expect(names(update(full, Message.ChangedHash({ hash: `#/item/${target.id}` })))).toContain(
      "FetchItemDetail",
    )
  })
})
