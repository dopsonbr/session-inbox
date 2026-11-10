/** The 2026-11-10 UX review's fixes (UX.md, U-059..U-075). */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  HOLDABLE_TOOLS,
  type Item,
  type ItemDetail,
  type SettingsResponse,
  type Snapshot,
} from "@session-inbox/contracts"
import { Effect, Option } from "effect"
import { makeFakeClient } from "../src/client/fake.ts"
import { Message } from "../src/message.ts"
import type { Model } from "../src/model.ts"
import { nextInTab, stepThrough } from "../src/selectors.ts"
import { SettingsMessage } from "../src/settings.ts"
import { DEFAULT_BINDINGS } from "../src/shortcuts.ts"
import {
  canMarkDone,
  initialModel,
  isOverlayOpen,
  type UpdateReturn,
  update,
} from "../src/update.ts"
import { compactView, rowSubtitle } from "../src/view/compact.ts"
import {
  ASKING_TOO_TEXT,
  approvalCard,
  DENY_NOTE_PLACEHOLDER,
  deliveryNote,
  detailView,
  snoozeItems,
  titleFor,
} from "../src/view/detail.ts"
import { historyView } from "../src/view/history.ts"
import { navView } from "../src/view/nav.ts"
import { shortcutRows } from "../src/view/overlays.ts"
import { queueView } from "../src/view/queue.ts"
import { SETTINGS_APPLY_TEXT, settingsBody, settingsTitle } from "../src/view/settings.ts"
import { attrOf, classOf, findAll, h, textOf } from "./vnode.ts"

const NOW = 1_800_000_000_000
const client = () => makeFakeClient({ now: () => NOW, simulate: false, delayScale: 0 })
const names = (ret: UpdateReturn) => (ret.commands ?? []).map((c) => c.name)
const run = (start: Model, ...messages: ReadonlyArray<Message>): UpdateReturn =>
  messages.reduce<UpdateReturn>((acc, m) => update(acc.model, m), { model: start })
const argsOf = (ret: UpdateReturn, name: string): Record<string, unknown> => {
  const command = (ret.commands ?? []).find((c) => c.name === name) as unknown as
    | { args: Record<string, unknown> }
    | undefined
  if (command === undefined) throw new Error(`expected ${name}`)
  return command.args
}

const showing = (
  itemId: string,
  patch: Partial<ItemDetail> = {},
  view = "full" as const,
): Model => {
  const c = client()
  const detail = { ...Effect.runSync(c.itemDetail(itemId)), ...patch }
  return run(
    initialModel({ view, now: NOW, maybeInitialItemId: Option.some(itemId) }),
    Message.SucceededFetchSnapshot({ snapshot: Effect.runSync(c.snapshot) }),
    Message.SucceededFetchItemDetail({ detail }),
  ).model
}
const detailOf = (model: Model): ItemDetail => {
  if (model.detail._tag !== "Loaded") throw new Error("detail not loaded")
  return model.detail.detail
}
const snapshotOf = (model: Model): Snapshot => Option.getOrThrow(model.maybeSnapshot)
const itemOf = (model: Model, itemId: string): Item => {
  const item = snapshotOf(model).items.find((i) => i.id === itemId)
  if (item === undefined) throw new Error(`no ${itemId}`)
  return item
}
const finished = (model: Model, itemId: string): Item => ({
  ...itemOf(model, itemId),
  state: "answered",
  queue: "done",
  live: false,
})
const succeeded = (model: Model, action: "decision" | "answers" | "reply", itemId: string) =>
  Message.SucceededAction({ action, itemId, response: { ok: true, item: finished(model, itemId) } })

describe("auto-advance after an answer (U-059, UX-001)", () => {
  test("a decision selects the item that followed it in the tab", () => {
    const sent = update(showing("i-ravelo-migrate"), Message.ClickedDecision({ decision: "allow" }))
    expect(sent.model.maybeAdvanceFrom).toEqual(Option.some("i-ravelo-migrate"))
    const done = update(sent.model, succeeded(sent.model, "decision", "i-ravelo-migrate"))
    expect(done.model.maybeSelectedItemId).toEqual(Option.some("i-hooks-failed"))
    expect(names(done)).toEqual(
      expect.arrayContaining(["FetchItemDetail", "SetHash", "ScrollToRow"]),
    )
    // The toast still says it went.
    expect(
      (done.model.toasts as unknown as { entries: ReadonlyArray<unknown> }).entries,
    ).toHaveLength(1)
  })

  test("the last item in the tab: the one before it", () => {
    const sent = update(showing("i-pv-fetch"), Message.ClickedDecision({ decision: "deny" }))
    const done = update(sent.model, succeeded(sent.model, "decision", "i-pv-fetch"))
    expect(done.model.maybeSelectedItemId).toEqual(Option.some("i-pv-long"))
  })

  test("still works when the daemon's delta arrived before the response", () => {
    const sent = update(showing("i-ravelo-migrate"), Message.ClickedDecision({ decision: "allow" }))
    const delta = update(
      sent.model,
      Message.ReceivedStreamMessage({
        message: {
          _tag: "delta",
          seq: 99,
          projects: [],
          sessions: [],
          agents: [],
          items: [finished(sent.model, "i-ravelo-migrate")],
          counts: snapshotOf(sent.model).counts,
        },
      }),
    ).model
    const done = update(delta, succeeded(delta, "decision", "i-ravelo-migrate"))
    expect(done.model.maybeSelectedItemId).toEqual(Option.some("i-hooks-failed"))
  })

  test("not after a reply: delivery or the 409 reason must stay in view", () => {
    const model = run(
      showing("i-hooks-failed"),
      Message.UpdatedReply({ value: "fix it" }),
      Message.SubmittedReply(),
    ).model
    expect(model.maybeAdvanceFrom).toEqual(Option.none())
    const done = update(model, succeeded(model, "reply", "i-hooks-failed"))
    expect(done.model.maybeSelectedItemId).toEqual(Option.some("i-hooks-failed"))
  })

  test("not when the item wasn't in the tab on screen, nor on History", () => {
    const other = update(showing("i-ravelo-migrate"), Message.SelectedQueueTab({ tab: "review" }))
    const sent = update(other.model, Message.ClickedDecision({ decision: "allow" }))
    expect(sent.model.maybeAdvanceFrom).toEqual(Option.none())
    const done = update(sent.model, succeeded(sent.model, "decision", "i-ravelo-migrate"))
    expect(done.model.maybeSelectedItemId).toEqual(Option.some("i-ravelo-migrate"))

    const onHistory = { ...showing("i-ravelo-migrate"), route: "history" as const }
    const sentThere = update(onHistory, Message.ClickedDecision({ decision: "allow" }))
    const doneThere = update(
      sentThere.model,
      succeeded(sentThere.model, "decision", "i-ravelo-migrate"),
    )
    expect(doneThere.model.maybeSelectedItemId).toEqual(Option.some("i-ravelo-migrate"))
  })

  test("nextInTab: after, else before, else nothing", () => {
    const s = snapshotOf(showing("i-ravelo-migrate"))
    const order = s.items.map((i) => i.id)
    expect(nextInTab(s, order, "review", "i-receipts-review")).toEqual(Option.some("i-docs-review"))
    // A stuck call is a Review item like the others (U-087).
    expect(nextInTab(s, order, "review", "i-docs-review")).toEqual(Option.some("i-dash-stuck"))
    expect(nextInTab(s, order, "review", "i-dash-stuck")).toEqual(Option.some("i-docs-review"))
    expect(nextInTab(s, order, "snoozed", "i-sync-snoozed")).toEqual(Option.none())
    expect(nextInTab(s, order, "working", "i-receipts-review")).toEqual(Option.none())
  })
})

describe("j / k through the list on screen (U-060, UX-002)", () => {
  const key = (direction: "next" | "previous") => Message.PressedListKey({ direction })

  test("the queue tab's items, in display order, stopping at the ends", () => {
    const start = showing("i-retry-questions")
    const next = update(start, key("next"))
    expect(next.model.maybeSelectedItemId).toEqual(Option.some("i-ravelo-migrate"))
    expect(names(next)).toEqual(expect.arrayContaining(["FetchItemDetail", "ScrollToRow"]))
    expect(argsOf(next, "ScrollToRow")).toEqual({ rowId: "item:i-ravelo-migrate" })
    const back = update(next.model, key("previous"))
    expect(back.model.maybeSelectedItemId).toEqual(Option.some("i-retry-questions"))
    expect(names(update(back.model, key("previous")))).toEqual([])
  })

  test("another tab: k from outside the list takes its last row", () => {
    const review = update(showing("i-retry-questions"), Message.SelectedQueueTab({ tab: "review" }))
    expect(update(review.model, key("previous")).model.maybeSelectedItemId).toEqual(
      Option.some("i-dash-stuck"),
    )
    expect(update(review.model, key("next")).model.maybeSelectedItemId).toEqual(
      Option.some("i-receipts-review"),
    )
  })

  test("Working: through the sessions listed", () => {
    const working = update(
      showing("i-retry-questions"),
      Message.SelectedQueueTab({ tab: "working" }),
    )
    const first = update(working.model, key("next"))
    expect(first.model.maybeSelectedSessionId).toEqual(Option.some("s-delivery"))
    expect(argsOf(first, "ScrollToRow")).toEqual({ rowId: "session:s-delivery" })
    // A session with an open item opens that item, as a click on its card does: its stuck call.
    const second = update(first.model, key("next"))
    expect(second.model.maybeSelectedItemId).toEqual(Option.some("i-dash-stuck"))
    expect(argsOf(second, "ScrollToRow")).toEqual({ rowId: "session:s-ravelo-dash" })
    // …and J goes on from that session, not back to the top.
    expect(argsOf(update(second.model, key("next")), "ScrollToRow")).toEqual({
      rowId: "session:s-pos-sync",
    })
  })

  test("History: through its entries", () => {
    const entries = Effect.runSync(client().history({ q: "", kind: null, before: null }))
    const model = run(
      { ...showing("i-retry-questions"), route: "history" as const },
      Message.SucceededFetchHistory({ requestId: 0, page: entries, append: false }),
      key("next"),
    ).model
    expect(model.maybeSelectedItemId).toEqual(Option.some(entries.entries[0]?.item.id ?? ""))
    expect(model.route).toBe("history")
  })

  test("ignored while a dialog or menu is open, and in the popover", () => {
    const open = update(
      showing("i-retry-questions"),
      Message.GotSettingsMessage({ message: SettingsMessage.RequestedOpen() }),
    ).model
    expect(names(update(open, key("next")))).toEqual([])
    const popover = showing("i-retry-questions", {}, "compact" as never)
    expect(update(popover, key("next")).model.maybeSelectedItemId).toEqual(
      popover.maybeSelectedItemId,
    )
  })

  test("stepThrough", () => {
    expect(stepThrough(["a", "b"], Option.none(), "next")).toEqual(Option.some("a"))
    expect(stepThrough(["a", "b"], Option.none(), "previous")).toEqual(Option.some("b"))
    expect(stepThrough(["a", "b"], Option.some("b"), "next")).toEqual(Option.some("b"))
    expect(stepThrough([], Option.none(), "next")).toEqual(Option.none())
  })
})

describe("Done for review and failed items (U-061, UX-003)", () => {
  test("Done and e send the dismiss intent; Dismiss leaves the Snooze menu for those kinds", () => {
    const model = showing("i-hooks-failed")
    expect(canMarkDone(detailOf(model))).toBe(true)
    const clicked = update(model, Message.ClickedDone())
    expect(names(clicked)).toEqual(["DismissItem"])
    expect(names(update(model, Message.PressedDoneShortcut()))).toEqual(["DismissItem"])
    expect(snoozeItems(detailOf(model))).not.toContain("dismiss")
    expect(snoozeItems(detailOf(showing("i-ravelo-migrate")))).toContain("dismiss")
    expect(snoozeItems(detailOf(showing("i-retry-questions")))).toContain("dismiss")
  })

  test("e does nothing on a question or permission, or with a dialog open", () => {
    expect(names(update(showing("i-ravelo-migrate"), Message.PressedDoneShortcut()))).toEqual([])
    const open = update(
      showing("i-receipts-review"),
      Message.GotSettingsMessage({ message: SettingsMessage.RequestedOpen() }),
    ).model
    expect(names(update(open, Message.PressedDoneShortcut()))).toEqual([])
  })

  test("Done clears it and the next review item takes its place", () => {
    const model = update(
      showing("i-receipts-review"),
      Message.SelectedQueueTab({ tab: "review" }),
    ).model
    const sent = update(model, Message.ClickedDone())
    const done = update(
      sent.model,
      Message.SucceededAction({
        action: "dismiss",
        itemId: "i-receipts-review",
        response: {
          ok: true,
          item: { ...finished(sent.model, "i-receipts-review"), state: "dismissed" },
        },
      }),
    )
    expect(done.model.maybeSelectedItemId).toEqual(Option.some("i-docs-review"))
  })
})

describe("popover rows (U-062, UX-004)", () => {
  test("the second line says what is asked, then the project; no summary → kind · project", () => {
    const model = showing("i-ravelo-migrate", {}, "compact" as never)
    const text = textOf(compactView(model, h))
    expect(text).toContain("Wants to run bun run migrate · ravelo")
    const item = itemOf(model, "i-ravelo-migrate")
    expect(textOf(rowSubtitle({ ...item, summary: null }, "ravelo", NOW, h))).toBe(
      "Permission · ravelo",
    )
  })

  test("Allow and Deny only on live permissions, beside the link, never inside it", () => {
    const model = showing("i-ravelo-migrate", {}, "compact" as never)
    const view = compactView(model, h)
    const buttons = findAll(view, "button")
    const live = snapshotOf(model).items.filter(
      (i) => i.queue === "needs-you" && i.kind === "permission" && i.live,
    )
    expect(buttons).toHaveLength(live.length * 2)
    expect(textOf(buttons)).not.toContain("Always allow")
    for (const link of findAll(view, "a")) {
      expect(findAll(link, "button")).toHaveLength(0)
    }
  })

  test("a row's decision goes for that item; one at a time", () => {
    const model = showing("i-retry-questions", {}, "compact" as never)
    const sent = update(
      model,
      Message.ClickedRowDecision({ itemId: "i-pv-edit", decision: "deny" }),
    )
    expect(argsOf(sent, "SendDecision")).toEqual({ itemId: "i-pv-edit", decision: "deny" })
    expect(
      names(
        update(sent.model, Message.ClickedRowDecision({ itemId: "i-pv-write", decision: "allow" })),
      ),
    ).toEqual([])
  })
})

describe("deny with a note (U-063, UX-005)", () => {
  const card = (model: Model) => {
    const detail = detailOf(model)
    if (detail.approval === null) throw new Error("no approval")
    return approvalCard(model, detail, detail.approval, h)
  }

  test("the field sits beside Deny on a live card", () => {
    const view = card(showing("i-ravelo-migrate"))
    const field = findAll(view, "input")
    expect(field).toHaveLength(1)
    expect(attrOf(field[0] as never, "placeholder")).toBe(DENY_NOTE_PLACEHOLDER)
  })

  test("empty: Deny decides as before; with text it goes as the reply (the daemon's deny reason)", () => {
    const model = showing("i-ravelo-migrate")
    expect(names(update(model, Message.ClickedDecision({ decision: "deny" })))).toEqual([
      "SendDecision",
    ])
    const typed = update(model, Message.UpdatedDenyNote({ value: "  use the staging db  " })).model
    const sent = update(typed, Message.ClickedDecision({ decision: "deny" }))
    expect(argsOf(sent, "SendDenyNote")).toEqual({
      itemId: "i-ravelo-migrate",
      body: "use the staging db",
    })
    expect(names(update(typed, Message.SubmittedDenyNote()))).toEqual(["SendDenyNote"])
    expect(names(update(typed, Message.PressedDenyShortcut()))).toEqual(["SendDenyNote"])
    // ⌘↵ still allows; the note doesn't change that.
    expect(names(update(typed, Message.PressedSubmitShortcut({ typing: "none" })))).toEqual([
      "SendDecision",
    ])
  })

  test("the note is per item: another selection starts empty", () => {
    const typed = update(
      showing("i-ravelo-migrate"),
      Message.UpdatedDenyNote({ value: "no" }),
    ).model
    expect(update(typed, Message.ClickedItem({ itemId: "i-pv-edit" })).model.denyNote).toBe("")
  })

  test("the fake daemon denies a live hold on a reply, as the real one does", () => {
    const c = client()
    const response = Effect.runSync(
      c.reply("i-ravelo-migrate", { idempotencyKey: "k", body: "use staging" }),
    )
    expect(response.item?.queue).toBe("done")
    expect(Effect.runSync(c.itemDetail("i-ravelo-migrate")).approval?.decision).toBe("deny")
  })
})

describe("a decided approval reads as decided (U-064, UX-016, UX-027)", () => {
  const decided = () => {
    const model = showing("i-ravelo-migrate")
    const detail = detailOf(model)
    if (detail.approval === null) throw new Error("no approval")
    return showing("i-ravelo-migrate", {
      item: { ...detail.item, state: "answered", live: false },
      approval: { ...detail.approval, decision: "deny", decidedAt: NOW - 60_000 },
    })
  }

  test("words, no buttons, no Always-allow sentence, no Needs-you border", () => {
    const model = decided()
    const detail = detailOf(model)
    if (detail.approval === null) throw new Error("no approval")
    const view = approvalCard(model, detail, detail.approval, h)
    const text = textOf(view)
    expect(text).toContain("Decided here: Denied at")
    expect(text).not.toContain("Decided: deny")
    expect(findAll(view, "button")).toHaveLength(0)
    expect(text).not.toContain("Always allow adds")
    expect(classOf(view)).not.toContain("border-needs-strong")
  })

  test("a finished approval with no outbox rows has no Delivery block", () => {
    const model = showing("i-ravelo-migrate", {
      item: { ...finished(showing("i-ravelo-migrate"), "i-ravelo-migrate") },
    })
    const text = textOf(detailView(model, h))
    expect(text).not.toContain("Sent to the live session")
    expect(text).not.toContain("Delivery")
  })
})

describe("titles (U-066, UX-018)", () => {
  test("a permission says what it wants; finished items are past tense", () => {
    const edit = detailOf(showing("i-pv-edit"))
    expect(titleFor(edit)).toBe("Claude wants to edit src/delivery/window.ts")
    expect(titleFor({ ...edit, item: { ...edit.item, queue: "done" } })).toBe(
      "Claude asked to edit src/delivery/window.ts",
    )
    expect(titleFor({ ...edit, item: { ...edit.item, summary: null } })).toBe(
      "Claude wants to use Edit",
    )
    const questions = detailOf(showing("i-retry-questions"))
    expect(titleFor(questions)).toBe("Claude has 2 questions for you")
    expect(titleFor({ ...questions, item: { ...questions.item, queue: "done" } })).toBe(
      "Claude asked 2 questions",
    )
  })

  test("with a preview the card drops the tool name heading", () => {
    const model = showing("i-pv-edit")
    const detail = detailOf(model)
    if (detail.approval === null) throw new Error("no approval")
    const text = textOf(approvalCard(model, detail, detail.approval, h))
    expect(text.startsWith("Edit")).toBe(false)
  })
})

describe("the question footer (U-067, UX-019)", () => {
  test("classic hold: paused; Claude's own prompt: whichever is answered first", () => {
    const model = showing("i-retry-questions")
    expect(textOf(deliveryNote(model, detailOf(model), h))).toContain(
      "It's paused waiting for them.",
    )
    const viaPrompt = showing("i-retry-questions", {
      approval: {
        tool: "AskUserQuestion",
        input: {},
        decision: null,
        decidedAt: null,
        expiresAt: NOW + 60_000,
        via: "permissionRequest",
      },
    })
    const text = textOf(deliveryNote(viaPrompt, detailOf(viaPrompt), h))
    expect(text).toContain(ASKING_TOO_TEXT)
    expect(text).not.toContain("paused")
  })
})

describe("queue list (U-069, U-070)", () => {
  test("the unread marker is neutral and named; the tabs fit one row and say Review", () => {
    const model = showing("i-retry-questions")
    const view = queueView(model, h)
    const unread = findAll(view, "span").filter((n) => attrOf(n, "aria-label") === "Unread")
    expect(unread.length).toBeGreaterThan(0)
    for (const dot of unread) {
      expect(classOf(dot)).toContain("bg-foreground")
      expect(classOf(dot)).not.toContain("bg-working")
    }
    const tabs = findAll(view, "button").filter((n) => attrOf(n, "role") === "tab")
    expect(textOf(tabs)).toContain("Review")
    expect(textOf(tabs)).not.toContain("Ready to review")
    const list = findAll(view, "div").find((n) => attrOf(n, "role") === "tablist")
    expect(classOf(list)).toContain("flex-nowrap")
  })
})

describe("settings (U-074)", () => {
  const opened = (response: SettingsResponse): Model =>
    run(
      initialModel({ view: "full", now: NOW, maybeInitialItemId: Option.none() }),
      Message.GotSettingsMessage({ message: SettingsMessage.RequestedOpen() }),
      Message.GotSettingsMessage({ message: SettingsMessage.SucceededFetchSettings({ response }) }),
    ).model
  const response = () => Effect.runSync(client().getSettings)

  test("Settings, with Beta only on the beta channel; never the word ga", () => {
    expect(textOf(settingsTitle(opened(response()), h))).toBe("Settings")
    const beta = { ...response(), channel: "beta" } as SettingsResponse
    expect(textOf(settingsTitle(opened(beta), h))).toBe("SettingsBeta")
    expect(SETTINGS_APPLY_TEXT).toBe("Changes apply as you make them.")
  })

  test("selected tool chips use the primary treatment with a check, not a dimmed fill", () => {
    const r = response()
    const classic = { ...r, settings: { ...r.settings, "holds.via": "preToolUse" as const } }
    const view = settingsBody(opened(classic), h)
    const chips = findAll(view, "div").filter(
      (n) => attrOf(n, "role") === "checkbox" && HOLDABLE_TOOLS.includes(textOf(n) as never),
    )
    expect(chips.length).toBeGreaterThan(0)
    const checked = chips.filter((n) => attrOf(n, "aria-checked") === "true")
    expect(checked.length).toBeGreaterThan(0)
    for (const chip of checked) {
      expect(classOf(chip)).toContain("bg-primary")
      expect(findAll(chip, "svg")).toHaveLength(1)
    }
  })
})

describe("History header and rows (U-075)", () => {
  test("search and kind filter stick; a summary may wrap to two lines", () => {
    const entries = Effect.runSync(client().history({ q: "", kind: null, before: null }))
    const model = run(
      { ...showing("i-retry-questions"), route: "history" as const },
      Message.SucceededFetchHistory({ requestId: 0, page: entries, append: false }),
    ).model
    const view = historyView(model, h)
    const sticky = findAll(view, "div").find((n) => classOf(n).split(" ").includes("sticky"))
    expect(textOf(sticky)).toContain("History")
    expect(findAll(sticky, "input")).toHaveLength(1)
    const clamped = findAll(view, "div").filter((n) => classOf(n).includes("line-clamp-2"))
    expect(clamped.length).toBe(entries.entries.length)
  })
})

describe("the shortcut list (U-073, UX-030)", () => {
  test("? and the nav entry open it; it blocks the letter keys while open", () => {
    const model = showing("i-retry-questions")
    const opened = update(model, Message.PressedShortcutsKey()).model
    expect(opened.shortcutsDialog.isOpen).toBe(true)
    expect(isOverlayOpen(opened)).toBe(true)
    expect(names(update(opened, Message.PressedListKey({ direction: "next" })))).toEqual([])
    expect(update(model, Message.ClickedShortcuts()).model.shortcutsDialog.isOpen).toBe(true)
    expect(textOf(navView(model, h))).toContain("Shortcuts")
  })

  test("lists every shortcut", () => {
    const keys = shortcutRows(DEFAULT_BINDINGS).flatMap((s) => s.keys)
    for (const key of ["⌘⇧I", "⌘K", "⌘↵", "⌘⌫", "J", "K", "E", "⌘,", "↑", "↓", "?", "Esc"]) {
      expect(keys).toContain(key)
    }
  })
})

describe("type sizes (U-068, UX-020)", () => {
  test("text-xs is 11px and nothing in the views is set below 11px", () => {
    const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8")
    expect(css).toContain("--text-xs: 11px;")
    expect(css).toContain("--text-sm: 12px;")
    const dir = join(import.meta.dir, "../src/view")
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), "utf8")
      for (const match of source.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
        expect(Number(match[1])).toBeGreaterThanOrEqual(11)
      }
    }
  })
})
