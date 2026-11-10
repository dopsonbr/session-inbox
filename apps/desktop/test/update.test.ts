import { describe, expect, test } from "bun:test"
import { Combobox, Dialog, RadioGroup } from "@foldkit/ui"
import type { Item, ItemDetail, Snapshot, StreamMessage } from "@session-inbox/contracts"
import { Effect, Option } from "effect"
import { given, message, model, story } from "foldkit/story"
import { makeFakeClient } from "../src/client/fake.ts"
import { Message } from "../src/message.ts"
import type { Model } from "../src/model.ts"
import { SettingsMessage } from "../src/settings.ts"
import { DETAIL_FORM_ATTR, shortcutTyping } from "../src/shortcuts.ts"
import { deliveryToasts, init, initialModel, type UpdateReturn, update } from "../src/update.ts"
import { activityEntries } from "../src/view/detail.ts"
import { itemKindLabel } from "../src/view/parts.ts"

const NOW = 1_800_000_000_000
const client = () => makeFakeClient({ now: () => NOW, simulate: false, delayScale: 0 })
const snapshot = (): Snapshot => Effect.runSync(client().snapshot)
const detailOf = (itemId: string): ItemDetail => Effect.runSync(client().itemDetail(itemId))

const argsOf = <A>(ret: UpdateReturn): A => {
  const command = ret.commands?.at(0) as unknown as { args: A } | undefined
  if (command === undefined) {
    throw new Error("expected a command")
  }
  return command.args
}
const names = (ret: UpdateReturn) => (ret.commands ?? []).map((c) => c.name)
const run = (start: Model, ...messages: ReadonlyArray<Message>): UpdateReturn =>
  messages.reduce<UpdateReturn>((acc, m) => update(acc.model, m), { model: start })

const fresh = (initialItem: string | null = null): Model =>
  initialModel({
    view: "full",
    now: NOW,
    maybeInitialItemId: initialItem === null ? Option.none() : Option.some(initialItem),
  })

const loaded = (): Model =>
  update(fresh(), Message.SucceededFetchSnapshot({ snapshot: snapshot() })).model

const delta = (
  items: ReadonlyArray<Item>,
  seq: number,
  counts = snapshot().counts,
): StreamMessage => ({
  _tag: "delta",
  seq,
  projects: [],
  sessions: [],
  agents: [],
  items,
  counts,
})

describe("init and snapshot", () => {
  test("init fetches the snapshot, and the deep-linked item", () => {
    expect(names(init({ view: "full", now: NOW, maybeInitialItemId: Option.none() }))).toEqual([
      "FetchSnapshot",
    ])
    expect(
      names(init({ view: "full", now: NOW, maybeInitialItemId: Option.some("i-hooks-failed") })),
    ).toEqual(["FetchSnapshot", "FetchItemDetail"])
  })

  test("snapshot load keeps daemon order, starts the stream epoch, auto-selects the first Needs-you item", () => {
    const s = snapshot()
    const ret = update(fresh(), Message.SucceededFetchSnapshot({ snapshot: s }))
    expect(ret.model.itemOrder).toEqual(s.items.map((i) => i.id))
    expect(ret.model.streamEpoch).toBe(1)
    expect(ret.model.connection._tag).toBe("Live")
    expect(ret.model.maybeSelectedItemId).toEqual(Option.some("i-retry-questions"))
    expect(names(ret)).toContain("FetchItemDetail")
    expect(ret.model.expandedNodes).toContain("p:p-orderup")
  })

  test("a failed snapshot marks the daemon offline and schedules a retry", () => {
    const ret = update(fresh(), Message.FailedFetchSnapshot({ error: "ECONNREFUSED" }))
    expect(ret.model.connection).toEqual({ _tag: "Offline", error: "ECONNREFUSED" })
    expect(names(ret)).toEqual(["WaitBeforeSnapshotRetry"])
  })
})

describe("stream", () => {
  test("delta merge keeps selection and order; new items append; counts come from the daemon", () => {
    const start = run(loaded(), Message.ClickedItem({ itemId: "i-hooks-failed" })).model
    const s = snapshot()
    const updated: Item = { ...(s.items[1] as Item), summary: "changed" }
    const added: Item = { ...(s.items[0] as Item), id: "i-new", createdAt: NOW + 1 }
    const counts = { needsYou: 4, working: 3, review: 2, snoozed: 1 }
    const ret = update(
      start,
      Message.ReceivedStreamMessage({ message: delta([added, updated], 500, counts) }),
    )
    const next = Option.getOrThrow(ret.model.maybeSnapshot)
    expect(ret.model.itemOrder).toEqual([...s.items.map((i) => i.id), "i-new"])
    expect(next.items.find((i) => i.id === updated.id)?.summary).toBe("changed")
    expect(next.counts).toEqual(counts)
    expect(next.seq).toBe(500)
    expect(ret.model.maybeSelectedItemId).toEqual(Option.some("i-hooks-failed"))
    expect(names(ret)).toEqual([])
  })

  test("a delta touching the selected item refetches its detail", () => {
    const start = loaded()
    const selected = snapshot().items[0] as Item
    const ret = update(
      start,
      Message.ReceivedStreamMessage({ message: delta([{ ...selected, live: false }], 600) }),
    )
    expect(names(ret)).toEqual(["FetchItemDetail"])
  })

  test("reset → refetch snapshot; the new snapshot bumps the epoch so the stream restarts", () => {
    const start = loaded()
    const reset = update(
      start,
      Message.ReceivedStreamMessage({ message: { _tag: "reset", seq: 900 } }),
    )
    expect(names(reset)).toEqual(["FetchSnapshot"])
    const reloaded = update(reset.model, Message.SucceededFetchSnapshot({ snapshot: snapshot() }))
    expect(reloaded.model.streamEpoch).toBe(start.streamEpoch + 1)
  })

  test("disconnect shows offline; hello shows live", () => {
    const off = update(loaded(), Message.DisconnectedStream({ error: "closed" }))
    expect(off.model.connection._tag).toBe("Offline")
    const on = update(
      off.model,
      Message.ReceivedStreamMessage({ message: { _tag: "hello", seq: 1 } }),
    )
    expect(on.model.connection._tag).toBe("Live")
  })

  test("ignores deltas before the first snapshot", () => {
    const ret = update(fresh(), Message.ReceivedStreamMessage({ message: delta([], 1) }))
    expect(Option.isNone(ret.model.maybeSnapshot)).toBe(true)
  })
})

const withQuestionDetail = (): Model =>
  update(loaded(), Message.SucceededFetchItemDetail({ detail: detailOf("i-retry-questions") }))
    .model

describe("answer form", () => {
  test("loading detail builds one answer and radio group per question and marks it read", () => {
    const ret = update(
      loaded(),
      Message.SucceededFetchItemDetail({ detail: detailOf("i-retry-questions") }),
    )
    const form = Option.getOrThrow(ret.model.maybeForm)
    expect(form.answers.map((a) => a.idx)).toEqual([0, 1])
    expect(form.radioGroups).toHaveLength(2)
    expect(names(ret)).toContain("MarkRead")
  })

  test("radio selection, other text, and submit", () => {
    const start = withQuestionDetail()
    const picked = update(
      start,
      Message.GotRadioGroupMessage({
        idx: 0,
        message: RadioGroup.Message.SelectedOption({ index: 0, value: "Only *Usom* tests" }),
      }),
    )
    expect(names(picked)).toContain("WaitBeforeDraftSave")
    expect(Option.getOrThrow(picked.model.maybeForm).answers[0]?.selected).toEqual([
      "Only *Usom* tests",
    ])

    // Not complete yet: question 2 unanswered → submit does nothing.
    expect(names(update(picked.model, Message.SubmittedAnswers()))).toEqual([])

    const other = update(
      picked.model,
      Message.UpdatedOther({ idx: 1, value: "1, but only for idempotent GETs" }),
    )
    const submitted = update(other.model, Message.PressedSubmitShortcut({ typing: "none" }))
    expect(names(submitted)).toEqual(["SubmitAnswers"])
    expect(submitted.model.submission).toEqual({ _tag: "Sending", action: "answers" })
    const args = argsOf<{ answers: unknown }>(submitted)
    expect(args.answers).toEqual([
      { idx: 0, selected: ["Only *Usom* tests"] },
      { idx: 1, selected: [], other: "1, but only for idempotent GETs" },
    ])
    // Double submit while sending is ignored.
    expect(names(update(submitted.model, Message.SubmittedAnswers()))).toEqual([])
  })

  test("typing an 'other' answer on a single-choice question replaces the picked option", () => {
    const start = withQuestionDetail()
    const picked = update(
      start,
      Message.GotRadioGroupMessage({
        idx: 1,
        message: RadioGroup.Message.SelectedOption({ index: 1, value: "3" }),
      }),
    ).model
    const typed = update(picked, Message.UpdatedOther({ idx: 1, value: "4" })).model
    expect(Option.getOrThrow(typed.maybeForm).answers[1]).toEqual({
      idx: 1,
      selected: [],
      other: "4",
    })
  })

  test("draft saves are debounced: only the latest version is PUT", () => {
    const a = update(withQuestionDetail(), Message.UpdatedOther({ idx: 0, value: "a" }))
    const b = update(a.model, Message.UpdatedOther({ idx: 0, value: "ab" }))
    expect(
      names(
        update(b.model, Message.CompletedWaitBeforeDraftSave({ version: a.model.draftVersion })),
      ),
    ).toEqual([])
    expect(
      names(
        update(b.model, Message.CompletedWaitBeforeDraftSave({ version: b.model.draftVersion })),
      ),
    ).toEqual(["SaveDraft"])
  })

  test("a daemon-held draft restores the form", () => {
    const detail = {
      ...detailOf("i-retry-questions"),
      draft: { answers: [{ idx: 1, selected: ["3"], other: "" }], reply: "" },
    }
    const ret = update(loaded(), Message.SucceededFetchItemDetail({ detail }))
    expect(Option.getOrThrow(ret.model.maybeForm).answers[1]?.selected).toEqual(["3"])
  })

  test("a refetch of the same item keeps in-progress input", () => {
    const typed = update(
      withQuestionDetail(),
      Message.UpdatedOther({ idx: 0, value: "mine" }),
    ).model
    const refetched = update(
      typed,
      Message.SucceededFetchItemDetail({ detail: detailOf("i-retry-questions") }),
    ).model
    expect(Option.getOrThrow(refetched.maybeForm).answers[0]?.other).toBe("mine")
  })
})

describe("keyboard shortcuts", () => {
  const permission = () =>
    update(
      run(loaded(), Message.ClickedItem({ itemId: "i-ravelo-migrate" })).model,
      Message.SucceededFetchItemDetail({ detail: detailOf("i-ravelo-migrate") }),
    ).model

  test("⌘↵ on a permission allows once; ⌘⌫ denies", () => {
    const allow = update(permission(), Message.PressedSubmitShortcut({ typing: "none" }))
    expect(names(allow)).toEqual(["SendDecision"])
    expect(argsOf<{ decision: string }>(allow).decision).toBe("allow")
    const deny = update(permission(), Message.PressedDenyShortcut())
    expect(argsOf<{ decision: string }>(deny).decision).toBe("deny")
  })

  test("⌘⌫ does nothing on a question", () => {
    expect(names(update(withQuestionDetail(), Message.PressedDenyShortcut()))).toEqual([])
  })

  test("⌘K opens the jump dialog", () => {
    const ret = update(loaded(), Message.PressedJumpShortcut())
    expect(ret.model.jumpDialog.isOpen).toBe(true)
  })

  test("⌘K starts with nothing highlighted, so the first ArrowDown lands on the first result", () => {
    // A previous visit left the list open with row 2 highlighted (dialog dismissed under it).
    const start = loaded()
    const stale: Model = {
      ...start,
      jumpCombobox: {
        ...start.jumpCombobox,
        isOpen: true,
        inputValue: "re",
        maybeActiveItemIndex: Option.some(2),
      },
    }
    const opened = update(stale, Message.PressedJumpShortcut()).model
    expect(opened.jumpCombobox.isOpen).toBe(false)
    expect(opened.jumpCombobox.inputValue).toBe("")
    expect(opened.jumpCombobox.maybeActiveItemIndex).toEqual(Option.none())
    // ArrowDown on a closed list opens it on the first enabled row.
    const down = update(
      opened,
      Message.GotJumpComboboxMessage({
        message: Combobox.Message.Opened({ maybeActiveItemIndex: Option.some(0) }),
      }),
    ).model
    expect(down.jumpCombobox.maybeActiveItemIndex).toEqual(Option.some(0))
    // Closing the dialog also forgets the highlight.
    const closed = update(
      down,
      Message.GotJumpDialogMessage({ message: Dialog.Message.RequestedClose() }),
    ).model
    expect(closed.jumpDialog.isOpen).toBe(false)
    expect(closed.jumpCombobox.isOpen).toBe(false)
    expect(closed.jumpCombobox.maybeActiveItemIndex).toEqual(Option.none())
  })

  test("⌘↵ on a review item sends the short reply", () => {
    const start = update(
      run(loaded(), Message.ClickedItem({ itemId: "i-receipts-review" })).model,
      Message.SucceededFetchItemDetail({ detail: detailOf("i-receipts-review") }),
    ).model
    expect(names(update(start, Message.PressedSubmitShortcut({ typing: "none" })))).toEqual([])
    const typed = update(start, Message.UpdatedReply({ value: "ship it" })).model
    expect(names(update(typed, Message.PressedSubmitShortcut({ typing: "none" })))).toEqual([
      "SendReply",
    ])
    // Typed in the reply box itself: still sends.
    expect(names(update(typed, Message.PressedSubmitShortcut({ typing: "detailForm" })))).toEqual([
      "SendReply",
    ])
  })
})

describe("shortcuts never reach the item behind an overlay (U-046)", () => {
  const permission = () =>
    update(
      run(loaded(), Message.ClickedItem({ itemId: "i-ravelo-migrate" })).model,
      Message.SucceededFetchItemDetail({ detail: detailOf("i-ravelo-migrate") }),
    ).model
  const submit = (typing: "none" | "detailForm" | "elsewhere") =>
    Message.PressedSubmitShortcut({ typing })
  const decides = (m: Model) => [
    ...names(update(m, submit("none"))),
    ...names(update(m, Message.PressedDenyShortcut())),
  ]

  test("baseline: a live approval is decided by ⌘↵ and ⌘⌫", () => {
    expect(decides(permission())).toEqual(["SendDecision", "SendDecision"])
  })

  test("Settings open: nothing", () => {
    const opened = update(
      permission(),
      Message.GotSettingsMessage({ message: SettingsMessage.RequestedOpen() }),
    ).model
    expect(opened.settings.dialog.isOpen).toBe(true)
    expect(decides(opened)).toEqual([])
    expect(names(update(opened, submit("elsewhere")))).toEqual([])
  })

  test("⌘K open: ⌘↵ in the jump box doesn't approve the item behind it", () => {
    const opened = update(permission(), Message.PressedJumpShortcut()).model
    expect(opened.jumpDialog.isOpen).toBe(true)
    expect(names(update(opened, submit("elsewhere")))).toEqual([])
    expect(decides(opened)).toEqual([])
  })

  test("snooze menu open: nothing", () => {
    const start = permission()
    const opened: Model = { ...start, snoozeMenu: { ...start.snoozeMenu, isOpen: true } }
    expect(decides(opened)).toEqual([])
  })

  test("Setup route: nothing", () => {
    const start = permission()
    expect(decides({ ...start, route: "setup" })).toEqual([])
  })

  test("typing in a field outside the detail form: ⌘↵ does nothing", () => {
    expect(names(update(permission(), submit("elsewhere")))).toEqual([])
  })
})

describe("shortcutTyping", () => {
  const field = (tagName: string, detail = false) => ({
    tagName,
    hasAttribute: (n: string) => detail && n === DETAIL_FORM_ATTR,
  })
  const plain = { tagName: "DIV", hasAttribute: () => false }
  test("no field, a detail-form field, any other field", () => {
    expect(shortcutTyping([plain, {}, null, "x"])).toBe("none")
    expect(shortcutTyping([field("TEXTAREA"), field("FORM", true), plain])).toBe("detailForm")
    expect(shortcutTyping([field("INPUT"), plain])).toBe("elsewhere")
    expect(shortcutTyping([{ tagName: "DIV", isContentEditable: true }])).toBe("elsewhere")
  })
})

describe("cards and activity", () => {
  test("question cards count their questions", () => {
    const items = snapshot().items
    const byId = (id: string) => items.find((i) => i.id === id) as Item
    expect(itemKindLabel(byId("i-retry-questions"))).toBe("2 questions")
    const one = { ...byId("i-retry-questions"), questionCount: 1 }
    expect(itemKindLabel(one)).toBe("1 question")
    const none: Item = { ...byId("i-retry-questions") }
    delete (none as { questionCount?: number }).questionCount
    expect(itemKindLabel(none)).toBe("Question")
  })

  test("the (this item) marker follows isSource, not the newest entry", () => {
    // s-pos-sync: a SubagentStart came after the question that created the item.
    const detail = detailOf("i-sync-snoozed")
    expect(detail.timeline[0]?.isSource).toBeUndefined()
    const source = detail.timeline.filter((e) => e.isSource === true)
    expect(source.map((e) => e.text)).toEqual(["Asked about tombstone merge strategy"])
    // An old source event is appended after the newest 8 lines.
    const long = [
      ...Array.from({ length: 10 }, (_, i) => ({
        seq: 100 - i,
        at: NOW,
        hook: "PostToolUse",
        agentId: null,
        text: `line ${i}`,
      })),
      {
        seq: 1,
        at: NOW,
        hook: "PreToolUse",
        agentId: null,
        text: "Asked 2 questions",
        isSource: true,
      },
    ]
    const shown = activityEntries(long)
    expect(shown).toHaveLength(9)
    expect(shown.at(-1)?.text).toBe("Asked 2 questions")
  })
})

describe("selection and tree", () => {
  test("clicking an item selects it and writes the hash", () => {
    const ret = update(loaded(), Message.ClickedItem({ itemId: "i-hooks-failed" }))
    expect(names(ret)).toEqual(["FetchItemDetail", "SetHash"])
    expect(ret.model.detail).toEqual({ _tag: "Loading", itemId: "i-hooks-failed" })
  })

  test("a hash change (deep link / notification click) selects without rewriting the hash", () => {
    const ret = update(loaded(), Message.ChangedHash({ hash: "#/item/i-docs-review" }))
    expect(ret.model.maybeSelectedItemId).toEqual(Option.some("i-docs-review"))
    expect(names(ret)).toEqual(["FetchItemDetail"])
  })

  test("tree keys move focus, expand and collapse", () => {
    const start = loaded()
    const down = update(start, Message.PressedTreeKey({ nodeId: "p:p-orderup", key: "ArrowDown" }))
    expect(down.model.maybeFocusedNode).toEqual(Option.some("s:s-retry"))
    expect(names(down)).toEqual(["FocusTreeNode"])
    const expand = update(start, Message.PressedTreeKey({ nodeId: "p:p-pos", key: "ArrowRight" }))
    expect(expand.model.expandedNodes).toContain("p:p-pos")
    const collapse = update(
      expand.model,
      Message.PressedTreeKey({ nodeId: "p:p-pos", key: "ArrowLeft" }),
    )
    expect(collapse.model.expandedNodes).not.toContain("p:p-pos")
  })

  test("a session with nothing open selects the session, not an item", () => {
    const ret = update(loaded(), Message.ClickedSession({ sessionId: "s-delivery" }))
    expect(ret.model.maybeSelectedItemId).toEqual(Option.none())
    expect(ret.model.maybeSelectedSessionId).toEqual(Option.some("s-delivery"))
  })

  test("story: queue tab selection is local view state", () => {
    story(
      update,
      given(loaded()),
      message(Message.SelectedQueueTab({ tab: "review" })),
      model((m: Model) => {
        expect(m.queueTab).toBe("review")
      }),
    )
  })
})

describe("delivery toasts", () => {
  test("only transitions to delivered/failed produce toasts", () => {
    const entry = { id: "o1", body: "x", attempts: 1, lastError: null, createdAt: NOW }
    expect(
      deliveryToasts(
        [{ ...entry, state: "sending" }],
        [{ ...entry, state: "delivered" }],
        "test-runner",
      ),
    ).toHaveLength(1)
    expect(
      deliveryToasts([{ ...entry, state: "delivered" }], [{ ...entry, state: "delivered" }], "x"),
    ).toHaveLength(0)
    expect(deliveryToasts([], [{ ...entry, state: "delivered" }], "x")).toHaveLength(0)
  })
})
