/**
 * Stuck calls (C-030, U-084 to U-088): a tool call that ran longer than `stuck.afterMs` is a
 * Review item reading "Running npm run dev for 12 min". Rows, title, the detail card, Done,
 * Settings and the fake daemon.
 */
import { describe, expect, test } from "bun:test"
import type {
  DoctorReport,
  Item,
  ItemDetail,
  SettingsResponse,
  UserSettingsPatch,
} from "@session-inbox/contracts"
import { Effect, Option } from "effect"
import { given, scene, tap } from "foldkit/scene"
import { makeFakeClient } from "../src/client/fake.ts"
import { fakeDoctorReport } from "../src/client/fakeDoctor.ts"
import { STUCK_REPLY_UNAVAILABLE } from "../src/client/fixtures.ts"
import { Message } from "../src/message.ts"
import type { Model } from "../src/model.ts"
import { formatClock, formatDuration, itemLine } from "../src/selectors.ts"
import { presentFields, RESET_ALL, SettingsMessage } from "../src/settings.ts"
import { canMarkDone, initialModel, type UpdateReturn, update } from "../src/update.ts"
import { rowSubtitle } from "../src/view/compact.ts"
import { runningCard, STUCK_HINT, snoozeItems, startedLine, titleFor } from "../src/view/detail.ts"
import { historyView } from "../src/view/history.ts"
import { view } from "../src/view/index.ts"
import { itemBadge, KIND_WORD } from "../src/view/parts.ts"
import { queueView } from "../src/view/queue.ts"
import { settingsBody } from "../src/view/settings.ts"
import { attrOf, classOf, findAll, h, textOf } from "./vnode.ts"

const NOW = 1_800_000_000_000
const MIN = 60_000
const client = () => makeFakeClient({ now: () => NOW, simulate: false, delayScale: 0 })
const names = (ret: UpdateReturn) => (ret.commands ?? []).map((c) => c.name)
const run = (start: Model, ...messages: ReadonlyArray<Message>): UpdateReturn =>
  messages.reduce<UpdateReturn>((acc, m) => update(acc.model, m), { model: start })

const showing = (itemId: string, patch: Partial<ItemDetail> = {}): Model => {
  const c = client()
  return run(
    initialModel({ view: "full", now: NOW, maybeInitialItemId: Option.some(itemId) }),
    Message.SucceededFetchSnapshot({ snapshot: Effect.runSync(c.snapshot) }),
    Message.SucceededFetchItemDetail({
      detail: { ...Effect.runSync(c.itemDetail(itemId)), ...patch },
    }),
  ).model
}
const detailOf = (model: Model): ItemDetail => {
  if (model.detail._tag !== "Loaded") throw new Error("detail not loaded")
  return model.detail.detail
}
const stuck = (): Item => {
  const item = Effect.runSync(client().snapshot).items.find((i) => i.id === "i-dash-stuck")
  if (item === undefined) throw new Error("no stuck fixture")
  return item
}

describe("the duration (U-085)", () => {
  test("minutes under an hour, at least 1; hours and minutes from an hour", () => {
    expect(formatDuration(0)).toBe("1 min")
    expect(formatDuration(59_000)).toBe("1 min")
    expect(formatDuration(12 * MIN)).toBe("12 min")
    expect(formatDuration(60 * MIN - 1)).toBe("59 min")
    expect(formatDuration(60 * MIN)).toBe("1 h")
    expect(formatDuration(65 * MIN)).toBe("1 h 5 min")
    expect(formatDuration(120 * MIN + 59_000)).toBe("2 h")
    // Clock skew: never negative.
    expect(formatDuration(-5 * MIN)).toBe("1 min")
  })

  test("a stuck call's line adds how long while it runs; once it ended, the summary alone", () => {
    const item = stuck()
    expect(itemLine(item, NOW)).toBe("Running npm run dev for 12 min")
    expect(itemLine(item, NOW + 53 * MIN)).toBe("Running npm run dev for 1 h 5 min")
    const { runningSince: _, ...ended } = item
    expect(itemLine({ ...ended, queue: "done", state: "resolved" }, NOW)).toBe(
      "Running npm run dev",
    )
    // Other kinds are their summary as given.
    expect(itemLine({ ...item, kind: "review" }, NOW)).toBe("Running npm run dev")
  })
})

describe("rows (U-084, U-085)", () => {
  test("Review: the badge is a clock and 'Still running', in the working tone; the line says how long", () => {
    const model = update(
      showing("i-retry-questions"),
      Message.SelectedQueueTab({ tab: "review" }),
    ).model
    const text = textOf(queueView(model, h))
    expect(text).toContain("Running npm run dev for 12 min")
    const badge = itemBadge(h, stuck())
    expect(textOf(badge)).toBe("Still running")
    expect(findAll(badge, "svg")).toHaveLength(1)
    expect(classOf(badge)).toContain("text-working")
    expect(classOf(badge)).not.toContain("text-needs")
  })

  test("popover: the second line says how long, then the project", () => {
    expect(textOf(rowSubtitle(stuck(), "ravelo-insights", NOW, h))).toBe(
      "Running npm run dev for 12 min · ravelo-insights",
    )
  })

  test("History: a stuck call that ended reads 'Ran long', its summary without a duration", () => {
    const page = Effect.runSync(client().history({ kind: "stuck" }))
    expect(page.entries.map((e) => e.item.id)).toEqual(["h-hooks-watch"])
    const model = run(
      { ...showing("i-retry-questions"), route: "history" as const },
      Message.SucceededFetchHistory({ requestId: 0, page, append: false }),
    ).model
    const text = textOf(historyView(model, h))
    expect(text).toContain("Running bun test --watch")
    expect(text).toContain(KIND_WORD.stuck)
    expect(text).not.toContain("Still running")
    expect(text).not.toMatch(/for \d+ (min|h)/)
  })

  test("History search finds a stuck call by its command", () => {
    const page = Effect.runSync(client().history({ q: "watch" }))
    expect(page.entries.map((e) => e.item.id)).toContain("h-hooks-watch")
  })
})

describe("the detail (U-085, U-087)", () => {
  test("the title is the row's line; once it ended, the summary alone", () => {
    const detail = detailOf(showing("i-dash-stuck"))
    expect(titleFor(detail, NOW)).toBe("Running npm run dev for 12 min")
    const { runningSince: _, ...ended } = detail.item
    expect(titleFor({ ...detail, item: { ...ended, queue: "done", state: "resolved" } }, NOW)).toBe(
      "Running npm run dev",
    )
    expect(titleFor({ ...detail, item: { ...detail.item, summary: null } }, NOW)).toBe(
      "A tool call is still running",
    )
  })

  test("the card: the command preview, when it started, the hint; no decisions, no reply box", () => {
    const model = showing("i-dash-stuck")
    const card = runningCard(model, detailOf(model), h)
    const text = textOf(card)
    expect(text).toContain("npm run dev")
    expect(text).toContain("Start the dashboard dev server")
    expect(text).toContain("in the project folder")
    expect(text).toContain(`Started at ${formatClock(NOW - 12 * MIN)}. No result yet.`)
    expect(text).toContain(STUCK_HINT)
    expect(findAll(card, "button")).toHaveLength(0)
    expect(findAll(card, "textarea")).toHaveLength(0)
    expect(findAll(card, "input")).toHaveLength(0)
    expect(classOf(card)).not.toContain("border-needs-strong")
  })

  test("a call that ended: when it started, no 'no result yet', no hint", () => {
    const model = showing("h-hooks-watch")
    const text = textOf(runningCard(model, detailOf(model), h))
    expect(text).toContain("bun test --watch")
    expect(text).toMatch(/^.*Started at \d\d:\d\d\.$/)
    expect(text).not.toContain("No result yet")
    expect(text).not.toContain(STUCK_HINT)
  })

  test("started on another day says which", () => {
    expect(startedLine(NOW, NOW - 26 * 60 * MIN, true)).toMatch(
      /^Started yesterday at \d\d:\d\d\. No result yet\.$/,
    )
  })

  test("whole window: Done, Snooze, Open in Claude; no Allow, Deny or reply box", () => {
    const c = client()
    const model = run(
      initialModel({ view: "full", now: NOW, maybeInitialItemId: Option.some("i-dash-stuck") }),
      Message.SucceededFetchSnapshot({ snapshot: Effect.runSync(c.snapshot) }),
      Message.SucceededFetchItemDetail({ detail: Effect.runSync(c.itemDetail("i-dash-stuck")) }),
      Message.SucceededFetchDoctor({ report: fakeDoctorReport("ok", NOW) as DoctorReport }),
    ).model
    let html: unknown = null
    scene(
      { update, view },
      given(model),
      tap((simulation) => {
        html = simulation.html
      }),
    )
    const text = textOf(html)
    expect(text).toContain("Running npm run dev for 12 min")
    const buttons = findAll(html, "button").map(textOf)
    expect(buttons).toContain("DoneE")
    expect(buttons.some((b) => b.startsWith("Snooze"))).toBe(true)
    expect(buttons).toContain("Open in Claude")
    expect(text).not.toContain("Allow once")
    expect(text).not.toContain("Short reply")
    expect(text).not.toContain(STUCK_REPLY_UNAVAILABLE)
    expect(findAll(html, "textarea")).toHaveLength(0)
  })
})

describe("Done and Snooze on a stuck call (U-087)", () => {
  test("Done and its shortcut send the dismiss intent; the snooze menu has no Dismiss", () => {
    const model = showing("i-dash-stuck")
    const detail = detailOf(model)
    expect(canMarkDone(detail)).toBe(true)
    expect(snoozeItems(detail)).not.toContain("dismiss")
    expect(names(update(model, Message.ClickedDone()))).toContain("DismissItem")
    expect(names(update(model, Message.PressedDoneShortcut()))).toContain("DismissItem")
    // ⌘↵ and Deny's key have nothing to act on.
    expect(names(update(model, Message.PressedSubmitShortcut({ typing: "none" })))).toEqual([])
    expect(names(update(model, Message.PressedDenyShortcut()))).toEqual([])
  })

  test("a stuck call that ended can't be marked done again", () => {
    const detail = detailOf(showing("h-hooks-watch"))
    expect(canMarkDone(detail)).toBe(false)
  })
})

describe("the fake daemon's stuck call", () => {
  test("an open Review item in a running session, with the call and no reply", () => {
    const c = client()
    const snapshot = Effect.runSync(c.snapshot)
    const item = snapshot.items.find((i) => i.id === "i-dash-stuck")
    expect(item?.kind).toBe("stuck")
    expect(item?.queue).toBe("review")
    expect(item?.runningSince).toBe(NOW - 12 * MIN)
    expect(snapshot.sessions.find((s) => s.id === item?.sessionId)?.state).toBe("running")
    const detail = Effect.runSync(c.itemDetail("i-dash-stuck"))
    expect(detail.running?.tool).toBe("Bash")
    expect(detail.running?.since).toBe(NOW - 12 * MIN)
    expect(detail.running?.preview?._tag).toBe("command")
    expect(detail.replyUnavailable).toBe(STUCK_REPLY_UNAVAILABLE)
  })

  test("dismiss ends it without a duration; snooze keeps it", () => {
    const c = client()
    const dismissed = Effect.runSync(c.dismiss("i-dash-stuck"))
    expect(dismissed.item?.queue).toBe("done")
    expect(dismissed.item?.state).toBe("dismissed")
    expect(dismissed.item?.runningSince).toBeUndefined()
    const other = client()
    const snoozed = Effect.runSync(other.snooze("i-dash-stuck", { until: NOW + 15 * MIN }))
    expect(snoozed.item?.queue).toBe("snoozed")
    expect(snoozed.item?.runningSince).toBe(NOW - 12 * MIN)
  })
})

describe("Settings (U-088)", () => {
  const response = (): SettingsResponse => Effect.runSync(client().getSettings)
  const s = (message: SettingsMessage): Message => Message.GotSettingsMessage({ message })
  const opened = (settings: Partial<Record<string, unknown>> = {}): Model => {
    const r = response()
    return run(
      initialModel({ view: "full", now: NOW, maybeInitialItemId: Option.none() }),
      s(SettingsMessage.RequestedOpen()),
      s(
        SettingsMessage.SucceededFetchSettings({
          response: { ...r, settings: { ...r.settings, ...settings } } as SettingsResponse,
        }),
      ),
    ).model
  }
  const save = (ret: UpdateReturn) =>
    (
      (ret.commands ?? []).find((c) => c.name === "SaveSettings") as unknown as {
        args: { key: string; patch: UserSettingsPatch }
      }
    ).args

  test("the switch and, while it is on, the minutes field in Notifications", () => {
    const on = textOf(settingsBody(opened(), h))
    expect(on).toContain("Tell me when a tool call runs long")
    expect(on).toContain(
      "A command that hangs, or a server started in the foreground, shows up in Review with one notification.",
    )
    expect(on).toContain("After")
    expect(on).toContain("1 to 240 minutes.")
    const view = settingsBody(opened(), h)
    const field = findAll(view, "input").find((n) => attrOf(n, "id") === "setting-stuck-afterMs")
    expect(field === undefined ? null : attrOf(field, "value")).toBe("5")
    const off = settingsBody(opened({ "stuck.enabled": false }), h)
    expect(textOf(off)).toContain("Tell me when a tool call runs long")
    expect(textOf(off)).not.toContain("1 to 240 minutes.")
    expect(findAll(off, "input").some((n) => attrOf(n, "id") === "setting-stuck-afterMs")).toBe(
      false,
    )
  })

  test("minutes typed are saved in ms; the switch sends its key; reset all covers both", () => {
    const typed = run(
      opened(),
      s(SettingsMessage.UpdatedDraft({ key: "stuck.afterMs", value: "12" })),
      s(SettingsMessage.CommittedDraft({ key: "stuck.afterMs" })),
    )
    expect(save(typed)).toMatchObject({
      key: "stuck.afterMs",
      patch: { "stuck.afterMs": 720_000 },
    })
    const toggled = update(
      opened(),
      s(SettingsMessage.ToggledSetting({ key: "stuck.enabled", value: false })),
    )
    expect(save(toggled).patch).toEqual({ "stuck.enabled": false })
    const all = update(opened(), s(SettingsMessage.ClickedResetAll()))
    expect(save(all).key).toBe(RESET_ALL)
    expect(save(all).patch).toMatchObject({ "stuck.enabled": null, "stuck.afterMs": null })
    expect(presentFields(response()).map((f) => f.key)).toEqual(
      expect.arrayContaining(["stuck.enabled", "stuck.afterMs"]),
    )
  })
})
