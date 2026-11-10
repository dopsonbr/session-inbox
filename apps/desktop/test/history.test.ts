import { describe, expect, test } from "bun:test"
import type { HistoryPage, ItemDetail, Snapshot, StreamMessage } from "@session-inbox/contracts"
import { Effect, Option } from "effect"
import { given, scene, tap } from "foldkit/scene"
import { makeFakeClient } from "../src/client/fake.ts"
import { makeHttpClient } from "../src/client/http.ts"
import { Message } from "../src/message.ts"
import type { Model } from "../src/model.ts"
import { dayLabel, hashForHistoryItem, routeFromHash } from "../src/selectors.ts"
import { init, initialModel, type UpdateReturn, update } from "../src/update.ts"
import { approvalCard, detailView, questionForm } from "../src/view/detail.ts"
import { historyNavEntry, historyView } from "../src/view/history.ts"
import { view } from "../src/view/index.ts"
import { attrOf, findAll, h, textOf } from "./vnode.ts"

const NOW = 1_800_000_000_000
const client = (pageSize?: number) =>
  makeFakeClient({
    now: () => NOW,
    simulate: false,
    delayScale: 0,
    ...(pageSize === undefined ? {} : { historyPageSize: pageSize }),
  })
const snapshot = (): Snapshot => Effect.runSync(client().snapshot)
const page = (query: Parameters<ReturnType<typeof client>["history"]>[0] = {}, size?: number) =>
  Effect.runSync(client(size).history(query))
const detailOf = (itemId: string): ItemDetail => Effect.runSync(client().itemDetail(itemId))

const names = (ret: UpdateReturn) => (ret.commands ?? []).map((c) => c.name)
const argsOf = <A>(ret: UpdateReturn, name: string): A => {
  const command = (ret.commands ?? []).find((c) => c.name === name) as unknown as
    | { args: A }
    | undefined
  if (command === undefined) throw new Error(`expected ${name}`)
  return command.args
}
const run = (start: Model, ...messages: ReadonlyArray<Message>): UpdateReturn =>
  messages.reduce<UpdateReturn>(
    (acc, m) => {
      const next = update(acc.model, m)
      return { model: next.model, commands: [...(acc.commands ?? []), ...(next.commands ?? [])] }
    },
    { model: start },
  )
const step = (start: Model, ...messages: ReadonlyArray<Message>): UpdateReturn =>
  messages.reduce<UpdateReturn>((acc, m) => update(acc.model, m), { model: start })

type FetchArgs = {
  requestId: number
  q: string
  kind: string | null
  before: string | null
  limit: number | null
  append: boolean
}

const inbox = (): Model =>
  update(
    initialModel({ view: "full", now: NOW, maybeInitialItemId: Option.none() }),
    Message.SucceededFetchSnapshot({ snapshot: snapshot() }),
  ).model

/** On History with its first page (from the fake) loaded. */
const onHistory = (size?: number): Model => {
  const entered = update(inbox(), Message.ChangedHash({ hash: "#/history" }))
  const { requestId } = argsOf<FetchArgs>(entered, "FetchHistory")
  return update(
    entered.model,
    Message.SucceededFetchHistory({ requestId, page: page({}, size), append: false }),
  ).model
}

const entries = (model: Model) =>
  model.history.results._tag === "Loaded" ? model.history.results.entries : []

describe("history: hashes", () => {
  test("#/history and #/history/<id> round trip", () => {
    expect(routeFromHash("#/history")).toEqual({ _tag: "history", itemId: null })
    expect(routeFromHash("#/history/")).toEqual({ _tag: "history", itemId: null })
    expect(hashForHistoryItem("h/1 x")).toBe("#/history/h%2F1%20x")
    expect(routeFromHash(hashForHistoryItem("h/1 x"))).toEqual({
      _tag: "history",
      itemId: "h/1 x",
    })
    expect(routeFromHash("#/item/abc")).toEqual({ _tag: "item", itemId: "abc" })
  })

  test("booting on #/history/<id> opens History with that entry and fetches both", () => {
    const booted = init({
      view: "full",
      now: NOW,
      maybeInitialItemId: Option.some("h-hooks-rm"),
      initialRoute: "history",
    })
    expect(booted.model.route).toBe("history")
    expect(booted.model.maybeSelectedItemId).toEqual(Option.some("h-hooks-rm"))
    expect(names(booted)).toEqual(["FetchSnapshot", "FetchItemDetail", "FetchHistory"])
    // The snapshot arriving doesn't pick a Needs-you item over the History selection.
    const loaded = update(booted.model, Message.SucceededFetchSnapshot({ snapshot: snapshot() }))
    expect(loaded.model.maybeSelectedItemId).toEqual(Option.some("h-hooks-rm"))
    expect(loaded.model.route).toBe("history")
  })

  test("booting on #/history selects nothing, even once the snapshot is in", () => {
    const booted = init({
      view: "full",
      now: NOW,
      maybeInitialItemId: Option.none(),
      initialRoute: "history",
    })
    const loaded = update(booted.model, Message.SucceededFetchSnapshot({ snapshot: snapshot() }))
    expect(loaded.model.maybeSelectedItemId).toEqual(Option.none())
  })
})

describe("history: entering and leaving", () => {
  test("entering fetches the first page and keeps the inbox selection aside", () => {
    const start = inbox()
    expect(start.maybeSelectedItemId).toEqual(Option.some("i-retry-questions"))
    const entered = update(start, Message.ChangedHash({ hash: "#/history" }))
    expect(entered.model.route).toBe("history")
    expect(names(entered)).toEqual(["FetchHistory"])
    expect(argsOf<FetchArgs>(entered, "FetchHistory")).toMatchObject({
      q: "",
      kind: null,
      before: null,
      limit: null,
      append: false,
    })
    expect(entered.model.maybeSelectedItemId).toEqual(Option.none())
    expect(entered.model.detail._tag).toBe("Idle")
    expect(entered.model.history.maybeInboxItemId).toEqual(Option.some("i-retry-questions"))
  })

  test("selecting an entry keeps the History route and its hash", () => {
    const picked = update(onHistory(), Message.ClickedHistoryEntry({ itemId: "h-hooks-rm" }))
    expect(picked.model.route).toBe("history")
    expect(picked.model.maybeSelectedItemId).toEqual(Option.some("h-hooks-rm"))
    expect(names(picked)).toEqual(["FetchItemDetail", "SetHash"])
    expect(argsOf<{ hash: string }>(picked, "SetHash").hash).toBe("#/history/h-hooks-rm")
    // The hash it set coming back (or a reload's hashchange) changes nothing.
    const again = update(picked.model, Message.ChangedHash({ hash: "#/history/h-hooks-rm" }))
    expect(names(again)).toEqual([])
    expect(again.model.route).toBe("history")
  })

  test("#/history/<id> typed while on History selects that entry", () => {
    const moved = update(onHistory(), Message.ChangedHash({ hash: "#/history/h-csv-write" }))
    expect(moved.model.maybeSelectedItemId).toEqual(Option.some("h-csv-write"))
    expect(names(moved)).toEqual(["FetchItemDetail"])
  })

  test("back to the inbox gives back its selection and hash", () => {
    const picked = update(onHistory(), Message.ClickedHistoryEntry({ itemId: "h-hooks-rm" })).model
    const back = update(picked, Message.ChangedHash({ hash: "#/" }))
    expect(back.model.route).toBe("inbox")
    expect(back.model.maybeSelectedItemId).toEqual(Option.some("i-retry-questions"))
    expect(names(back)).toContain("FetchItemDetail")
    expect(argsOf<{ hash: string }>(back, "SetHash").hash).toBe("#/item/i-retry-questions")
  })

  test("Setup from History, then back, still works as before", () => {
    const picked = update(onHistory(), Message.ClickedHistoryEntry({ itemId: "h-hooks-rm" })).model
    const setup = update(picked, Message.ChangedHash({ hash: "#/setup" }))
    expect(setup.model.route).toBe("setup")
    expect(setup.model.maybeSelectedItemId).toEqual(Option.some("i-retry-questions"))
    expect(names(setup)).toContain("FetchDoctor")
    const back = update(setup.model, Message.ChangedHash({ hash: "#/" }))
    expect(back.model.route).toBe("inbox")
  })

  test("a tree or queue click leaves History for the inbox", () => {
    const clicked = update(onHistory(), Message.ClickedItem({ itemId: "i-hooks-failed" }))
    expect(clicked.model.route).toBe("inbox")
    expect(argsOf<{ hash: string }>(clicked, "SetHash").hash).toBe("#/item/i-hooks-failed")
  })

  test("⌘↵ and ⌘⌫ do nothing on History", () => {
    const shown = step(
      onHistory(),
      Message.ClickedHistoryEntry({ itemId: "i-ravelo-migrate" }),
      Message.SucceededFetchItemDetail({ detail: detailOf("i-ravelo-migrate") }),
    ).model
    expect(names(update(shown, Message.PressedSubmitShortcut({ typing: "none" })))).toEqual([])
    expect(names(update(shown, Message.PressedDenyShortcut()))).toEqual([])
  })
})

describe("history: search, filter, paging", () => {
  test("typing waits 250 ms; only the latest keystroke searches", () => {
    const typed = run(
      onHistory(),
      Message.UpdatedHistoryQuery({ value: "r" }),
      Message.UpdatedHistoryQuery({ value: "rm " }),
    )
    expect(names(typed)).toEqual(["WaitBeforeHistorySearch", "WaitBeforeHistorySearch"])
    expect(typed.model.history.pending).toBe("first")
    const stale = update(typed.model, Message.CompletedWaitBeforeHistorySearch({ version: 1 }))
    expect(names(stale)).toEqual([])
    const fresh = update(typed.model, Message.CompletedWaitBeforeHistorySearch({ version: 2 }))
    expect(argsOf<FetchArgs>(fresh, "FetchHistory")).toMatchObject({ q: "rm", append: false })
  })

  test("Enter searches at once", () => {
    const typed = update(onHistory(), Message.UpdatedHistoryQuery({ value: "push" })).model
    const now = update(typed, Message.SubmittedHistorySearch())
    expect(argsOf<FetchArgs>(now, "FetchHistory").q).toBe("push")
    // The debounce firing later finds a newer version and does nothing.
    expect(
      names(update(now.model, Message.CompletedWaitBeforeHistorySearch({ version: 1 }))),
    ).toEqual([])
  })

  test("an answer for a query that is no longer current is ignored", () => {
    const start = onHistory()
    const searched = update(
      update(start, Message.UpdatedHistoryQuery({ value: "push" })).model,
      Message.CompletedWaitBeforeHistorySearch({ version: 1 }),
    )
    const oldId = argsOf<FetchArgs>(searched, "FetchHistory").requestId
    const retyped = update(searched.model, Message.UpdatedHistoryQuery({ value: "pushed" })).model
    const late = update(
      retyped,
      Message.SucceededFetchHistory({ requestId: oldId, page: page({ q: "push" }), append: false }),
    )
    expect(entries(late.model)).toEqual(entries(start))
    expect(late.model.history.pending).toBe("first")
    const failed = update(
      retyped,
      Message.FailedFetchHistory({ requestId: oldId, error: "boom", status: 500 }),
    )
    expect(failed.model.history.results).toEqual(retyped.history.results)
  })

  test("a kind chip fetches at once with that kind", () => {
    const filtered = update(onHistory(), Message.SelectedHistoryKind({ kind: "permission" }))
    expect(filtered.model.history.kind).toBe("permission")
    expect(argsOf<FetchArgs>(filtered, "FetchHistory")).toMatchObject({ kind: "permission" })
    expect(
      names(update(filtered.model, Message.SelectedHistoryKind({ kind: "permission" }))),
    ).toEqual([])
  })

  test("Load more appends the next page", () => {
    const first = onHistory(5)
    expect(entries(first)).toHaveLength(5)
    const results = first.history.results
    const nextBefore = results._tag === "Loaded" ? results.nextBefore : null
    expect(nextBefore).not.toBeNull()
    const more = update(first, Message.ClickedLoadMoreHistory())
    const args = argsOf<FetchArgs>(more, "FetchHistory")
    expect(args).toMatchObject({ before: nextBefore, append: true })
    expect(more.model.history.pending).toBe("more")
    // A second click while it's on its way does nothing.
    expect(names(update(more.model, Message.ClickedLoadMoreHistory()))).toEqual([])
    const appended = update(
      more.model,
      Message.SucceededFetchHistory({
        requestId: args.requestId,
        page: page({ before: nextBefore }, 5),
        append: true,
      }),
    ).model
    expect(entries(appended)).toHaveLength(10)
    expect(entries(appended).slice(0, 5)).toEqual([...entries(first)])
    expect(appended.history.pending).toBe("none")
  })

  test("a failed refetch keeps what is shown and says so; a first failure shows the error", () => {
    const shown = onHistory()
    const retry = update(shown, Message.ClickedRetryHistory())
    const { requestId } = argsOf<FetchArgs>(retry, "FetchHistory")
    const failed = update(
      retry.model,
      Message.FailedFetchHistory({ requestId, error: "boom", status: 500 }),
    ).model
    expect(failed.history.results).toMatchObject({ _tag: "Loaded", error: "boom" })
    expect(entries(failed)).toEqual(entries(shown))
    const entered = update(inbox(), Message.ChangedHash({ hash: "#/history" }))
    const missing = update(
      entered.model,
      Message.FailedFetchHistory({
        requestId: argsOf<FetchArgs>(entered, "FetchHistory").requestId,
        error: "404 Not Found",
        status: 404,
      }),
    ).model
    expect(missing.history.results).toEqual({
      _tag: "Failed",
      error: "404 Not Found",
      status: 404,
    })
  })
})

describe("history: refetch on the stream", () => {
  const delta = (queue: "done" | "needs-you"): StreamMessage => {
    const item = snapshot().items.find((i) => i.id === "i-hooks-failed")
    if (item === undefined) throw new Error("fixture")
    return {
      _tag: "delta",
      seq: 500,
      projects: [],
      sessions: [],
      agents: [],
      items: [{ ...item, queue, state: queue === "done" ? "resolved" : "open" }],
      counts: snapshot().counts,
    }
  }

  test("a finished item in a delta refetches the first page, keeping the selection", () => {
    const picked = update(onHistory(), Message.ClickedHistoryEntry({ itemId: "h-hooks-rm" })).model
    const ret = update(picked, Message.ReceivedStreamMessage({ message: delta("done") }))
    expect(names(ret)).toContain("FetchHistory")
    expect(argsOf<FetchArgs>(ret, "FetchHistory")).toMatchObject({ before: null, append: false })
    expect(ret.model.maybeSelectedItemId).toEqual(Option.some("h-hooks-rm"))
    expect(ret.model.route).toBe("history")
  })

  test("an open item, or the inbox route, doesn't refetch", () => {
    expect(
      names(update(onHistory(), Message.ReceivedStreamMessage({ message: delta("needs-you") }))),
    ).not.toContain("FetchHistory")
    expect(
      names(update(inbox(), Message.ReceivedStreamMessage({ message: delta("done") }))),
    ).not.toContain("FetchHistory")
  })

  test("a refetch after Load more asks for as many entries as are shown", () => {
    const model = onHistory()
    const many: HistoryPage = {
      entries: Array.from({ length: 70 }, (_, n) => ({
        ...(entries(model)[0] as HistoryPage["entries"][number]),
        item: {
          ...(entries(model)[0]?.item as HistoryPage["entries"][number]["item"]),
          id: `x${n}`,
        },
      })),
      nextBefore: "c",
      retentionDays: 14,
    }
    const grown = update(
      model,
      Message.SucceededFetchHistory({
        requestId: model.history.requestId,
        page: many,
        append: false,
      }),
    ).model
    const ret = update(grown, Message.ReceivedStreamMessage({ message: delta("done") }))
    expect(argsOf<FetchArgs>(ret, "FetchHistory").limit).toBe(70)
  })
})

describe("history: the HTTP client", () => {
  test("asks /v1/history with the query and decodes the page; a 404 keeps its status", async () => {
    const urls: Array<string> = []
    const body = page({ q: "rm" })
    const http = makeHttpClient({
      token: "t",
      fetch: async (url) => {
        urls.push(url)
        return new Response(JSON.stringify(body), { status: 200 })
      },
    })
    const got = await Effect.runPromise(
      http.history({ q: " rm  ", kind: "permission", before: "c1", limit: 10 }),
    )
    expect(got).toEqual(body)
    expect(urls).toEqual(["/v1/history?q=rm&kind=permission&before=c1&limit=10"])
    const old = makeHttpClient({
      token: "t",
      fetch: async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
    })
    expect((await Effect.runPromise(Effect.flip(old.history({})))).status).toBe(404)
  })
})

describe("history: the fake daemon", () => {
  test("finished items, newest first, with outcomes; old ones are not in the snapshot", () => {
    const all = page()
    expect(all.entries.length).toBe(15)
    expect(all.retentionDays).toBe(14)
    expect(all.nextBefore).toBeNull()
    const times = all.entries.map((e) => e.endedAt)
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    expect(new Set(all.entries.map((e) => e.outcome))).toEqual(
      new Set([
        "allowed",
        "always-allowed",
        "denied",
        "answered",
        "replied",
        "in-claude",
        "moved-on",
        "expired",
        "dismissed",
      ]),
    )
    const ids = new Set(snapshot().items.map((i) => i.id))
    expect(ids.has("h-hooks-rm")).toBe(true)
    expect(ids.has("h-docs-review")).toBe(false)
    // Its detail still loads, with its own session and project.
    expect(detailOf("h-docs-review").session.title).toBe("Docs pass")
  })

  test("q: every word must match; a hidden match says where", () => {
    expect(page({ q: "passkeys" }).entries.map((e) => e.item.id)).toEqual([
      "h-passkeys-lib",
      "h-passkeys-fetch",
    ])
    const reason = page({ q: "synthetic" }).entries
    expect(reason.map((e) => e.item.id)).toEqual(["h-hooks-rm"])
    expect(reason[0]?.match).toEqual({
      where: "reason",
      text: "…fixtures; regenerate only the synthetic ones.",
    })
    const answer = page({ q: "DELIVERYWINDOW" }).entries
    expect(answer[0]?.match?.where).toBe("answer")
    expect(page({ q: "rm fixtures" }).entries.map((e) => e.item.id)).toEqual(["h-hooks-rm"])
    expect(page({ q: "rm nothing-like-this" }).entries).toEqual([])
    // A word the row shows needs no match line.
    expect(page({ q: "Flaky" }).entries.every((e) => e.match === undefined)).toBe(true)
    expect(page({ q: "workers" }).entries[0]?.match?.where).toBe("reply")
    expect(page({ q: "ravelo-insights/src/export" }).entries[0]?.match?.where).toBe("path")
  })

  test("kind filters; paging walks every entry once", () => {
    expect(page({ kind: "failed" }).entries.every((e) => e.item.kind === "failed")).toBe(true)
    expect(page({ kind: "review" }).entries).toHaveLength(3)
    const seen: Array<string> = []
    let before: string | null = null
    for (let i = 0; i < 10; i++) {
      const p: HistoryPage = page({ before, limit: 4 })
      seen.push(...p.entries.map((e) => e.item.id))
      before = p.nextBefore
      if (before === null) break
    }
    expect(seen).toEqual(page().entries.map((e) => e.item.id))
  })

  test("an item finished in the fake shows up with its outcome", () => {
    const c = client()
    Effect.runSync(c.decision("i-ravelo-migrate", { idempotencyKey: "k", decision: "deny" }))
    const first = Effect.runSync(c.history({})).entries[0]
    expect(first?.item.id).toBe("i-ravelo-migrate")
    expect(first?.outcome).toBe("denied")
  })
})

describe("history: view", () => {
  test("search, chips, day groups, rows, Load more and the footer", () => {
    const model = onHistory(5)
    const html = historyView(model, h)
    const text = textOf(html)
    const input = findAll(html, "input")[0]
    expect(input === undefined ? null : attrOf(input, "placeholder")).toBe("Search history")
    for (const chip of ["All", "Questions", "Permissions", "Reviews", "Errors"]) {
      expect(text).toContain(chip)
    }
    expect(text).toContain("Today")
    expect(text).toContain("Allowed")
    expect(text).toContain("Wants to run bun test src/clients")
    expect(text).toContain("Retry policy for usom calls · order-up-api")
    expect(text).toContain("Load more")
    expect(text).toContain(
      "History is kept for 14 days. Change it in Settings under Keep history for.",
    )
    // Every row is a button.
    expect(findAll(html, "li").length).toBe(5)
    expect(findAll(html, "button").some((b) => textOf(b).includes("bun test src/clients"))).toBe(
      true,
    )
  })

  test("a hidden match gets a quiet line", () => {
    const model = onHistory()
    const searched = update(
      model,
      Message.SucceededFetchHistory({
        requestId: model.history.requestId,
        page: page({ q: "synthetic" }),
        append: false,
      }),
    ).model
    expect(textOf(historyView(searched, h))).toContain(
      "Matched in reason: …fixtures; regenerate only the synthetic ones.",
    )
  })

  test("empty, no matches, loading, unavailable", () => {
    const model = onHistory()
    const empty = (q: string) =>
      update(
        { ...model, history: { ...model.history, query: q } },
        Message.SucceededFetchHistory({
          requestId: model.history.requestId,
          page: { entries: [], nextBefore: null, retentionDays: 1 },
          append: false,
        }),
      ).model
    expect(textOf(historyView(empty(""), h))).toContain("Nothing has finished yet.")
    expect(textOf(historyView(empty(""), h))).toContain("History is kept for 1 day.")
    expect(textOf(historyView(empty("zzz"), h))).toContain('No matches for "zzz".')
    const entering = update(inbox(), Message.ChangedHash({ hash: "#/history" })).model
    expect(textOf(historyView(entering, h))).toContain("Loading history…")
    const gone = update(
      entering,
      Message.FailedFetchHistory({
        requestId: entering.history.requestId,
        error: "404",
        status: 404,
      }),
    ).model
    expect(textOf(historyView(gone, h))).toContain("This daemon has no history.")
  })

  test("the nav entry links #/history and marks itself current there", () => {
    const off = findAll(historyNavEntry(inbox(), h), "a")[0]
    expect(off === undefined ? null : attrOf(off, "href")).toBe("#/history")
    expect(textOf(off)).toBe("History")
    const on = findAll(historyNavEntry(onHistory(), h), "a")[0]
    expect(on === undefined ? null : attrOf(on, "aria-current")).toBe("page")
  })

  test("dayLabel: Today, Yesterday, then a date", () => {
    expect(dayLabel(NOW, NOW)).toBe("Today")
    expect(dayLabel(NOW, NOW - 24 * 3600_000)).toBe("Yesterday")
    expect(dayLabel(NOW, NOW - 5 * 24 * 3600_000)).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/)
  })
})

describe("history: detail of a finished item", () => {
  const shown = (itemId: string): Model =>
    step(
      onHistory(),
      Message.ClickedHistoryEntry({ itemId }),
      Message.SucceededFetchItemDetail({ detail: detailOf(itemId) }),
    ).model
  const loaded = (model: Model) => {
    if (model.detail._tag !== "Loaded") throw new Error("not loaded")
    return model.detail.detail
  }

  test("a denied permission: the decision, how it ended, no buttons or snooze", () => {
    const model = shown("h-hooks-rm")
    const detail = loaded(model)
    const card = approvalCard(
      model,
      detail,
      detail.approval as NonNullable<typeof detail.approval>,
      h,
    )
    expect(textOf(card)).toContain("Decided here: Denied at")
    expect(findAll(card, "button")).toHaveLength(0)
    const pane = textOf(detailView(model, h))
    expect(pane).toContain("Ended:Denied")
    expect(pane).toContain("Open in Claude")
    expect(pane).not.toContain("Snooze")
  })

  test("an answered question: the chosen answers, no form", () => {
    const model = shown("h-delivery-split")
    const form = Option.getOrThrow(model.maybeForm)
    const html = questionForm(model, loaded(model), form, h)
    const text = textOf(html)
    expect(text).toContain("By concern (3 modules)")
    expect(text).toContain("Only for deliveryWindow, drop the rest")
    expect(findAll(html, "form")).toHaveLength(0)
    expect(findAll(html, "input")).toHaveLength(0)
    expect(text).not.toContain("Send answers")
  })

  test("a review that moved on keeps its reply box", () => {
    const model = shown("h-flaky-timeout")
    const pane = detailView(model, h)
    expect(textOf(pane)).toContain("Short reply")
    expect(findAll(pane, "textarea")).toHaveLength(1)
  })

  test("whole window: nav, History in the middle, the detail on the right", () => {
    let text = ""
    scene(
      { update, view },
      given(shown("h-hooks-rm")),
      tap((simulation) => {
        text = textOf(simulation.html)
      }),
    )
    expect(text).toContain("Search history")
    expect(text).toContain("Decided here: Denied")
    expect(text).toContain("Projects")
  })
})
