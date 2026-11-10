import { describe, expect, test } from "bun:test"
import type { DoctorReport, ItemDetail, SettingsResponse } from "@session-inbox/contracts"
import { Effect, Option } from "effect"
import { withExtraSettings } from "../src/client/extraSettings.ts"
import { fakeUpdateStatus, makeFakeClient } from "../src/client/fake.ts"
import { fakeDoctorReport } from "../src/client/fakeDoctor.ts"
import { makeHttpClient } from "../src/client/http.ts"
import { Message } from "../src/message.ts"
import type { Model } from "../src/model.ts"
import { agentDisplayName, formatAgo, routeFromHash, visibleTreeNodes } from "../src/selectors.ts"
import { presentFields, SettingsMessage } from "../src/settings.ts"
import { initialModel, type UpdateReturn, update } from "../src/update.ts"
import {
  approvalCard,
  contextStrip,
  lastMessageView,
  replyForm,
  WAITING_IN_CLAUDE_TEXT,
} from "../src/view/detail.ts"
import { navView } from "../src/view/nav.ts"
import { queueView } from "../src/view/queue.ts"
import { settingsBody } from "../src/view/settings.ts"
import { versionView } from "../src/view/update.ts"
import { attrOf, findAll, h, textOf } from "./vnode.ts"

const NOW = 1_800_000_000_000
const MIN = 60_000
const client = (options: Parameters<typeof makeFakeClient>[0] = {}) =>
  makeFakeClient({ now: () => NOW, simulate: false, delayScale: 0, ...options })
const names = (ret: UpdateReturn) => (ret.commands ?? []).map((c) => c.name)
const run = (start: Model, ...messages: ReadonlyArray<Message>): UpdateReturn =>
  messages.reduce<UpdateReturn>((acc, m) => update(acc.model, m), { model: start })

/** The full window with `itemId` selected and its detail loaded. */
const showing = (itemId: string, patch: Partial<ItemDetail> = {}): Model => {
  const c = client()
  const detail = { ...Effect.runSync(c.itemDetail(itemId)), ...patch }
  return run(
    initialModel({ view: "full", now: NOW, maybeInitialItemId: Option.some(itemId) }),
    Message.SucceededFetchSnapshot({ snapshot: Effect.runSync(c.snapshot) }),
    Message.SucceededFetchItemDetail({ detail }),
  ).model
}

const loadedDetail = (model: Model): ItemDetail => {
  if (model.detail._tag !== "Loaded") throw new Error("detail not loaded")
  return model.detail.detail
}
/** The detail pane's own parts (the full pane has submodels inertHtml can't render). */
const detailParts = (model: Model) => {
  const detail = loadedDetail(model)
  return [
    contextStrip(model, detail, h),
    lastMessageView(model, detail, h),
    replyForm(model, detail, Option.getOrThrow(model.maybeForm), h),
  ]
}

describe("relative time", () => {
  test("just now, min, h, d", () => {
    expect(formatAgo(NOW, NOW)).toBe("just now")
    expect(formatAgo(NOW, NOW - 59_000)).toBe("just now")
    expect(formatAgo(NOW, NOW - 2 * MIN)).toBe("2 min ago")
    expect(formatAgo(NOW, NOW - 3 * 60 * MIN)).toBe("3 h ago")
    expect(formatAgo(NOW, NOW - 50 * 60 * MIN)).toBe("2 d ago")
    // Clock skew: a future timestamp is "just now", never negative.
    expect(formatAgo(NOW, NOW + 5 * MIN)).toBe("just now")
  })

  test("the context strip never reads 'now ago'", () => {
    const text = textOf(detailParts(showing("i-pv-edit")))
    expect(text).not.toContain("now ago")
    expect(text).toMatch(/Last activity(just now|\d+ (min|h|d) ago)/)
  })
})

describe("routes from the hash", () => {
  test("item, setup, update, inbox", () => {
    expect(routeFromHash("#/item/i-1")).toEqual({ _tag: "item", itemId: "i-1" })
    expect(routeFromHash("#/item/a%2Fb")).toEqual({ _tag: "item", itemId: "a/b" })
    expect(routeFromHash("#/item/%E0%A4%A")).toEqual({ _tag: "item", itemId: "%E0%A4%A" })
    expect(routeFromHash("#/item/setup")).toEqual({ _tag: "setup" })
    expect(routeFromHash("#/setup")).toEqual({ _tag: "setup" })
    expect(routeFromHash("#/update")).toEqual({ _tag: "update" })
    expect(routeFromHash("")).toEqual({ _tag: "inbox" })
    expect(routeFromHash("#/")).toEqual({ _tag: "inbox" })
  })
})

describe("Claude's last message", () => {
  test("review item: rendered as Markdown above the reply box, collapsed after 24 lines", () => {
    const model = showing("i-receipts-review")
    const view = detailParts(model)
    const text = textOf(view)
    expect(text).toContain("Claude's last message")
    expect(text).toContain("ESC/POS driver is done")
    expect(text).not.toContain("## ")
    expect(text).toMatch(/Show all \d+ lines/)
    // Collapsed: the end of the message isn't there yet.
    expect(text).not.toContain("38 passing")
    expect(text.indexOf("Claude's last message")).toBeLessThan(text.indexOf("Short reply"))
    const expanded = update(model, Message.ToggledLastMessageExpanded()).model
    const open = textOf(detailParts(expanded))
    expect(open).toContain("38 passing")
    expect(open).toContain("Show less")
  })

  test("expansion resets when another item is selected", () => {
    const expanded = update(showing("i-receipts-review"), Message.ToggledLastMessageExpanded())
    const other = update(expanded.model, Message.ClickedItem({ itemId: "i-hooks-failed" }))
    expect(other.model.isLastMessageExpanded).toBe(false)
  })

  test("failed item shows it too; no message, no section", () => {
    expect(textOf(detailParts(showing("i-hooks-failed")))).toContain("Claude's last message")
    expect(textOf(detailParts(showing("i-pv-edit")))).not.toContain("Claude's last message")
  })

  test("queue cards render summaries inline: no raw backticks or stars, no anchors", () => {
    const model = update(
      showing("i-hooks-failed"),
      Message.SelectedQueueTab({ tab: "review" }),
    ).model
    const view = queueView(model, h)
    const text = textOf(view)
    expect(text).toContain("ESC/POS driver done")
    expect(text).not.toContain("**")
    expect(text).not.toContain("`")
    expect(findAll(view, "a")).toHaveLength(0)
  })
})

describe("approval card honesty (U-043)", () => {
  const card = (model: Model) => {
    const detail = loadedDetail(model)
    if (detail.approval === null) throw new Error("no approval")
    return approvalCard(model, detail, detail.approval, h)
  }
  const notLive = (model: Model): Model => {
    const detail = loadedDetail(model)
    return update(
      model,
      Message.SucceededFetchItemDetail({
        detail: { ...detail, item: { ...detail.item, live: false } },
      }),
    ).model
  }

  test("a live hold keeps Allow once / Always allow / Deny", () => {
    const text = textOf(card(showing("i-pv-edit")))
    expect(text).toContain("Allow once")
    expect(text).toContain("Deny")
    expect(text).not.toContain(WAITING_IN_CLAUDE_TEXT)
  })

  test("not live: one quiet line and Open in Claude; the preview stays", () => {
    const model = notLive(showing("i-pv-edit"))
    const view = card(model)
    const text = textOf(view)
    expect(text).toContain(WAITING_IN_CLAUDE_TEXT)
    expect(text).toContain("Open in Claude")
    expect(text).not.toContain("Allow once")
    expect(text).not.toContain("Always allow")
    expect(text).toContain("src/delivery/window.ts")
    expect(findAll(view, "button")).toHaveLength(1)
  })

  test("not live: ⌘↵ and ⌘⌫ decide nothing", () => {
    const model = notLive(showing("i-pv-edit"))
    expect(names(update(model, Message.PressedSubmitShortcut()))).toEqual([])
    expect(names(update(model, Message.PressedDenyShortcut()))).toEqual([])
    expect(names(update(showing("i-pv-edit"), Message.PressedDenyShortcut()))).not.toEqual([])
  })

  test("queue card says Waiting in Claude for a non-live permission item", () => {
    const model = showing("i-pv-edit")
    const live = textOf(queueView(model, h))
    expect(live).toContain("waiting")
    const snap = Option.getOrThrow(model.maybeSnapshot)
    const quiet = update(model, {
      ...Message.SucceededFetchSnapshot({
        snapshot: {
          ...snap,
          items: snap.items.map((i) => (i.id === "i-pv-edit" ? { ...i, live: false } : i)),
        },
      }),
    }).model
    expect(textOf(queueView(quiet, h))).toContain("Waiting in Claude")
  })
})

describe("reply box honesty", () => {
  test("replyUnavailable replaces the textarea with the reason and Open in Claude", () => {
    const view = detailParts(showing("i-docs-review"))
    const text = textOf(view)
    expect(text).toContain("isn't logged in on this Mac")
    expect(text).toContain("Open in Claude")
    expect(findAll(view, "textarea")).toHaveLength(0)
  })

  test("⌘↵ doesn't send a reply the daemon said it can't deliver", () => {
    const model = showing("i-docs-review")
    const typed = update(model, Message.UpdatedReply({ value: "ship it" })).model
    expect(names(update(typed, Message.PressedSubmitShortcut()))).not.toContain("SendReply")
  })

  test("a 409 answer shows under the reply box, not as a toast; typing clears it", () => {
    const model = showing("i-receipts-review")
    const failed = update(
      model,
      Message.FailedAction({ action: "reply", error: "Session is running again.", status: 409 }),
    ).model
    expect(Option.getOrNull(failed.maybeReplyError)).toBe("Session is running again.")
    const text = textOf(detailParts(failed))
    expect(text).toContain("Session is running again.")
    expect((failed.toasts as unknown as { entries: ReadonlyArray<unknown> }).entries).toHaveLength(
      0,
    )
    const typed = update(failed, Message.UpdatedReply({ value: "x" })).model
    expect(typed.maybeReplyError).toEqual(Option.none())
    // Any other failure still toasts.
    const offline = update(
      model,
      Message.FailedAction({ action: "reply", error: "fetch failed", status: null }),
    ).model
    expect(offline.maybeReplyError).toEqual(Option.none())
  })

  test("the fake daemon answers 409 with ?reply=conflict", async () => {
    const c = client({ reply: "conflict" })
    const error = await Effect.runPromise(
      Effect.flip(c.reply("i-receipts-review", { idempotencyKey: "k", body: "hi" })),
    )
    expect(error.status).toBe(409)
  })
})

describe("context strip and tree", () => {
  test("always four cells", () => {
    const view = detailParts(showing("i-ravelo-migrate"))
    const strip = findAll(view, "dl")[0]
    expect(strip?.children).toHaveLength(4)
  })

  test("an unnamed subagent reads 'agent'", () => {
    const model = showing("i-hooks-failed")
    const snapshot = Option.getOrThrow(model.maybeSnapshot)
    const anon = snapshot.agents.find((a) => a.id === "a-sync-anon")
    expect(anon === undefined ? "" : agentDisplayName(anon)).toBe("agent")
    const expanded = { ...model, expandedNodes: ["p:p-pos", "s:s-pos-sync"] }
    expect(visibleTreeNodes(snapshot, expanded.expandedNodes).map((n) => n.id)).toContain(
      "a:a-sync-anon",
    )
    const text = textOf(navView(expanded, h))
    expect(text).toContain("agent · done")
  })
})

describe("header version label", () => {
  test("build hash in its own span (hidden when narrow); What's new after an update", () => {
    const updated = update(
      initialModel({ view: "full", now: NOW, maybeInitialItemId: Option.none() }),
      Message.ReceivedStreamMessage({
        message: { _tag: "update", seq: 1, status: fakeUpdateStatus("updated", NOW) },
      }),
    ).model
    const view = versionView(updated, h)
    expect(textOf(view)).toContain("v0.1.0 · fake000")
    expect(textOf(view)).toContain("What's new")
    const plain = update(
      initialModel({ view: "full", now: NOW, maybeInitialItemId: Option.none() }),
      Message.ReceivedStreamMessage({
        message: { _tag: "update", seq: 1, status: fakeUpdateStatus("idle", NOW) },
      }),
    ).model
    expect(textOf(versionView(plain, h))).not.toContain("What's new")
  })
})

describe("settings: retention days", () => {
  const s = (message: SettingsMessage) => Message.GotSettingsMessage({ message })
  const opened = (response: SettingsResponse): Model =>
    run(
      initialModel({ view: "full", now: NOW, maybeInitialItemId: Option.none() }),
      s(SettingsMessage.RequestedOpen()),
      s(SettingsMessage.SucceededFetchSettings({ response })),
    ).model
  const fakeResponse = () => Effect.runSync(client().getSettings)
  const withoutDays = (): SettingsResponse => {
    const r = fakeResponse()
    const strip = (o: object) =>
      Object.fromEntries(Object.entries(o).filter(([k]) => k !== "storage.retentionDays"))
    return {
      ...r,
      settings: strip(r.settings) as SettingsResponse["settings"],
      defaults: strip(r.defaults) as SettingsResponse["defaults"],
    }
  }

  test("Approvals in the default mode: minutes field, hold settings disabled with a note (U-044)", () => {
    const view = settingsBody(opened(fakeResponse()), h)
    const text = textOf(view)
    expect(text).toContain("Answer Claude's own prompt (recommended)")
    expect(text).toContain("Hold the tool call before Claude asks (classic)")
    expect(text).toContain("Then the inbox stops answering")
    expect(text.split("Not used while the inbox answers Claude's own prompt.")).toHaveLength(4)
    const tools = findAll(view, "input").filter((n) =>
      String(attrOf(n, "id") ?? "").startsWith("setting-holds-tools-"),
    )
    expect(tools.length === 0 || tools.every((n) => attrOf(n, "disabled") === true)).toBe(true)
    const budget = findAll(view, "input").find((n) => attrOf(n, "id") === "setting-holds-budgetMs")
    expect(attrOf(budget as never, "disabled")).toBe(true)
  })

  test("Approvals in the classic mode: no minutes field, hold settings enabled", () => {
    const r = fakeResponse()
    const classic = {
      ...r,
      settings: { ...r.settings, "holds.via": "preToolUse" as const },
    }
    const view = settingsBody(opened(classic), h)
    const text = textOf(view)
    expect(text).not.toContain("Not used while the inbox answers Claude's own prompt.")
    expect(text).not.toContain("Then the inbox stops answering")
    const budget = findAll(view, "input").find((n) => attrOf(n, "id") === "setting-holds-budgetMs")
    expect(attrOf(budget as never, "disabled")).not.toBe(true)
  })

  test("shown under Storage", () => {
    const withDays = textOf(settingsBody(opened(fakeResponse()), h))
    expect(withDays).toContain("Storage")
    expect(withDays).toContain("Keep history for")
    expect(withDays).toContain("days")
  })

  test("days commit as a whole number", () => {
    const ret = run(
      opened(fakeResponse()),
      s(SettingsMessage.UpdatedDraft({ key: "storage.retentionDays", value: "90" })),
      s(SettingsMessage.CommittedDraft({ key: "storage.retentionDays" })),
    )
    const save = ret.commands?.find((c) => c.name === "SaveSettings") as unknown as {
      args: { patch: Record<string, unknown> }
    }
    expect(save.args.patch).toEqual({ "storage.retentionDays": 90 })
    const bad = run(
      opened(fakeResponse()),
      s(SettingsMessage.UpdatedDraft({ key: "storage.retentionDays", value: "2.5" })),
      s(SettingsMessage.CommittedDraft({ key: "storage.retentionDays" })),
    )
    expect(names(bad)).toEqual([])
    // A response without the key (the pane only shows fields the daemon reports).
    expect(presentFields(withoutDays()).map((f) => f.key)).not.toContain("storage.retentionDays")
  })

  test("the footer links to Setup once the daemon has a report", () => {
    const model = opened(fakeResponse())
    expect(textOf(settingsBody(model, h))).not.toContain("Setup check")
    const withReport = update(
      model,
      Message.SucceededFetchDoctor({ report: fakeDoctorReport("attention", NOW) as DoctorReport }),
    ).model
    const body = settingsBody(withReport, h)
    expect(textOf(body)).toContain("Setup check · 2 need attention")
    expect(findAll(body, "a").map((a) => attrOf(a, "href"))).toContain("#/setup")
  })

  test("the fake daemon clamps days to 1–365", () => {
    const put = (value: number) =>
      Effect.runSync(client().putSettings({ "storage.retentionDays": value } as never))
    expect((put(0).settings as Record<string, unknown>)["storage.retentionDays"]).toBe(1)
    expect((put(9999).settings as Record<string, unknown>)["storage.retentionDays"]).toBe(365)
  })

  test("the HTTP client keeps a number key newer than the contracts", async () => {
    const body = fakeResponse()
    const http = makeHttpClient({
      token: "",
      fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
    })
    const got = await Effect.runPromise(http.getSettings)
    expect((got.settings as Record<string, unknown>)["storage.retentionDays"]).toBe(14)
    // Non-numbers aren't smuggled in.
    const raw = { settings: { "storage.retentionDays": "30" }, defaults: {} }
    const kept = withExtraSettings(raw, withoutDays())
    expect((kept.settings as Record<string, unknown>)["storage.retentionDays"]).toBeUndefined()
  })
})
