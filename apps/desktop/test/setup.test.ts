import { describe, expect, test } from "bun:test"
import { Dialog } from "@foldkit/ui"
import type { DoctorReport, Snapshot } from "@session-inbox/contracts"
import { Effect, Option } from "effect"
import { makeFakeClient } from "../src/client/fake.ts"
import { fakeDoctorReport } from "../src/client/fakeDoctor.ts"
import { makeHttpClient } from "../src/client/http.ts"
import { Message } from "../src/message.ts"
import type { Model } from "../src/model.ts"
import { SettingsMessage } from "../src/settings.ts"
import { init, initialModel, testNotifyToast, type UpdateReturn, update } from "../src/update.ts"
import { compactView } from "../src/view/compact.ts"
import { setupNavEntry, setupView } from "../src/view/setup.ts"
import { attrOf, findAll, h, textOf } from "./vnode.ts"

const NOW = 1_800_000_000_000
const names = (ret: UpdateReturn) => (ret.commands ?? []).map((c) => c.name)
const argsOf = (ret: UpdateReturn, name: string): unknown =>
  (ret.commands?.find((c) => c.name === name) as unknown as { args: unknown } | undefined)?.args
const run = (start: Model, ...messages: ReadonlyArray<Message>): UpdateReturn =>
  messages.reduce<UpdateReturn>((acc, m) => update(acc.model, m), { model: start })
const fresh = (view: "full" | "compact" = "full"): Model =>
  initialModel({ view, now: NOW, maybeInitialItemId: Option.none() })
const report = (kind: "ok" | "attention" | "firstrun"): DoctorReport =>
  fakeDoctorReport(kind, NOW) as DoctorReport
const withReport = (model: Model, kind: "ok" | "attention" | "firstrun") =>
  update(model, Message.SucceededFetchDoctor({ report: report(kind) })).model
const snapshotOf = (options: Parameters<typeof makeFakeClient>[0] = {}): Snapshot =>
  Effect.runSync(
    makeFakeClient({ now: () => NOW, simulate: false, delayScale: 0, ...options }).snapshot,
  )
const toastTitles = (model: Model) =>
  (
    model.toasts as unknown as { entries: ReadonlyArray<{ payload: { title: string } }> }
  ).entries.map((e) => e.payload.title)

describe("setup check: fetching", () => {
  test("every stream hello and every doctor message refetch the report", () => {
    const hello = update(
      fresh(),
      Message.ReceivedStreamMessage({ message: { _tag: "hello", seq: 1 } }),
    )
    expect(names(hello)).toContain("FetchDoctor")
    expect(hello.model.isDoctorLoading).toBe(true)
    const doctor = update(
      fresh(),
      Message.ReceivedStreamMessage({ message: { _tag: "doctor", seq: 2, attention: 1 } }),
    )
    expect(names(doctor)).toEqual(["FetchDoctor"])
  })

  test("report, unavailable (404) and failure", () => {
    const loaded = withReport(fresh(), "attention")
    expect(loaded.doctor._tag).toBe("Loaded")
    expect(loaded.isDoctorLoading).toBe(false)
    const unavailable = update(fresh(), Message.FoundDoctorUnavailable()).model
    expect(unavailable.doctor._tag).toBe("Unavailable")
    const failedFirst = update(fresh(), Message.FailedFetchDoctor({ error: "boom" })).model
    expect(failedFirst.doctor).toEqual({ _tag: "Failed", error: "boom" })
    // A failed re-check keeps the report it had and says so.
    const failedLater = update(loaded, Message.FailedFetchDoctor({ error: "boom" })).model
    expect(failedLater.doctor).toMatchObject({ _tag: "Loaded", error: "boom" })
  })

  test("Re-check refetches", () => {
    expect(names(update(fresh(), Message.ClickedRecheck()))).toEqual(["FetchDoctor"])
  })

  test("the HTTP client treats a 404 /v1/doctor as unavailable, other errors as errors", async () => {
    const respond = (status: number, body: unknown) => async () =>
      new Response(JSON.stringify(body), { status })
    const missing = makeHttpClient({ token: "", fetch: respond(404, { error: "not_found" }) })
    expect(await Effect.runPromise(missing.doctor)).toEqual(Option.none())
    const ok = makeHttpClient({ token: "", fetch: respond(200, report("ok")) })
    expect(Option.isSome(await Effect.runPromise(ok.doctor))).toBe(true)
    const broken = makeHttpClient({ token: "", fetch: respond(500, { message: "nope" }) })
    expect((await Effect.runPromise(Effect.flip(broken.doctor))).status).toBe(500)
  })
})

describe("setup check: routes", () => {
  test("#/setup and #/item/setup open Setup and refetch; #/item/setup settles on #/setup", () => {
    const a = update(fresh(), Message.ChangedHash({ hash: "#/setup" }))
    expect(a.model.route).toBe("setup")
    expect(names(a)).toEqual(["FetchDoctor"])
    const b = update(fresh(), Message.ChangedHash({ hash: "#/item/setup" }))
    expect(b.model.route).toBe("setup")
    expect(b.model.maybeSelectedItemId).toEqual(Option.none())
    expect(argsOf(b, "SetHash")).toEqual({ hash: "#/setup" })
  })

  test("booting on #/setup shows Setup; on #/update checks for updates and clears the hash", () => {
    const setup = init({
      view: "full",
      now: NOW,
      maybeInitialItemId: Option.none(),
      initialRoute: "setup",
    })
    expect(setup.model.route).toBe("setup")
    const upd = init({
      view: "full",
      now: NOW,
      maybeInitialItemId: Option.none(),
      initialRoute: "update",
    })
    expect(upd.model.route).toBe("inbox")
    expect(upd.model.updateRequest).toBe("Checking")
    expect(names(upd)).toEqual(["FetchSnapshot", "CheckForUpdates", "SetHash"])
  })

  test("#/update while running: back to the inbox with a check", () => {
    const onSetup = update(fresh(), Message.ChangedHash({ hash: "#/setup" })).model
    const ret = update(onSetup, Message.ChangedHash({ hash: "#/update" }))
    expect(ret.model.route).toBe("inbox")
    expect(names(ret)).toEqual(["CheckForUpdates", "SetHash"])
  })

  test("#/settings opens the Settings dialog at boot and while running, and puts the hash back", () => {
    const boot = init({
      view: "full",
      now: NOW,
      maybeInitialItemId: Option.none(),
      initialRoute: "settings",
    })
    expect(boot.model.route).toBe("inbox")
    expect(boot.model.settings.dialog.isOpen).toBe(true)
    expect(names(boot)).toContain("SetHash")
    const onSetup = update(fresh(), Message.ChangedHash({ hash: "#/setup" })).model
    const ret = update(onSetup, Message.ChangedHash({ hash: "#/settings" }))
    expect(ret.model.route).toBe("inbox")
    expect(ret.model.settings.dialog.isOpen).toBe(true)
    expect(names(ret)).toContain("SetHash")
    // The popover has no Settings.
    const compact = init({
      view: "compact",
      now: NOW,
      maybeInitialItemId: Option.none(),
      initialRoute: "settings",
    })
    expect(compact.model.settings.dialog.isOpen).toBe(false)
  })

  test("the Settings footer link closes Settings on the way to Setup", () => {
    const opened = update(
      fresh(),
      Message.GotSettingsMessage({ message: SettingsMessage.RequestedOpen() }),
    ).model
    expect(opened.settings.dialog.isOpen).toBe(true)
    const ret = update(opened, Message.ChangedHash({ hash: "#/setup" }))
    expect(ret.model.settings.dialog.isOpen).toBe(false)
    expect(ret.model.route).toBe("setup")
  })

  test("picking an item leaves Setup; boot auto-selection doesn't", () => {
    const onSetup = update(fresh(), Message.ChangedHash({ hash: "#/setup" })).model
    const booted = update(onSetup, Message.SucceededFetchSnapshot({ snapshot: snapshotOf() })).model
    expect(booted.route).toBe("setup")
    expect(Option.isSome(booted.maybeSelectedItemId)).toBe(true)
    const clicked = update(booted, Message.ClickedItem({ itemId: "i-hooks-failed" })).model
    expect(clicked.route).toBe("inbox")
    // "Back to the inbox" (#/) restores the selected item's hash.
    const back = update(booted, Message.ChangedHash({ hash: "#/" }))
    expect(back.model.route).toBe("inbox")
    expect(argsOf(back, "SetHash")).toEqual({
      hash: `#/item/${Option.getOrThrow(booted.maybeSelectedItemId)}`,
    })
  })

  test("⌘↵ and ⌘⌫ do nothing while Setup is showing", () => {
    const onSetup = update(fresh(), Message.ChangedHash({ hash: "#/setup" })).model
    expect(names(update(onSetup, Message.PressedSubmitShortcut({ typing: "none" })))).toEqual([])
    expect(names(update(onSetup, Message.PressedDenyShortcut()))).toEqual([])
  })
})

describe("setup check: fixes and the test notification", () => {
  test("copy → Copied for a moment; a refused copy toasts the command", () => {
    const copy = update(fresh(), Message.ClickedCopyFix({ checkId: "claude-cli", value: "x" }))
    expect(names(copy)).toEqual(["CopyFix"])
    const done = run(
      fresh(),
      Message.CompletedCopyFix({ checkId: "claude-cli", value: "x", isCopied: true }),
    )
    expect(done.model.maybeCopiedFix).toEqual(Option.some("claude-cli"))
    expect(names(done)).toEqual(["WaitCopied"])
    const cleared = update(done.model, Message.CompletedCopiedWait({ checkId: "claude-cli" }))
    expect(cleared.model.maybeCopiedFix).toEqual(Option.none())
    const refused = update(
      fresh(),
      Message.CompletedCopyFix({ checkId: "claude-cli", value: "claude /login", isCopied: false }),
    )
    expect(toastTitles(refused.model)).toEqual(["Couldn't copy"])
  })

  test("test notification: one request at a time, a literal toast, then a refetch", () => {
    const sending = update(fresh(), Message.ClickedTestNotification())
    expect(names(sending)).toEqual(["SendTestNotification"])
    expect(names(update(sending.model, Message.ClickedTestNotification()))).toEqual([])
    const done = update(
      sending.model,
      Message.SucceededTestNotification({ via: "fallback", message: null }),
    )
    expect(done.model.isTestNotifying).toBe(false)
    expect(toastTitles(done.model)).toEqual(["Sent as a plain macOS notification"])
    expect(names(done)).toContain("FetchDoctor")
    const failed = update(sending.model, Message.FailedTestNotification({ error: "404 Not Found" }))
    expect(toastTitles(failed.model)).toEqual(["Couldn't send a test notification"])
  })

  test("toast copy per via", () => {
    expect(testNotifyToast("shell", null).payload.description).toContain("Session Inbox banner")
    expect(testNotifyToast("fallback", null).payload.description).toContain("Script Editor")
    expect(testNotifyToast("none", null)).toMatchObject({ variant: "Warning" })
    expect(testNotifyToast("none", "Daemon says why").payload.description).toBe("Daemon says why")
    expect(testNotifyToast(null, null).payload.title).toBe("Test notification sent")
  })
})

describe("setup views", () => {
  const onSetup = (kind: "ok" | "attention" | "firstrun" | "unavailable" | "unknown") => {
    const routed = update(fresh(), Message.ChangedHash({ hash: "#/setup" })).model
    if (kind === "unknown") return routed
    if (kind === "unavailable") return update(routed, Message.FoundDoctorUnavailable()).model
    return withReport({ ...routed, isDoctorLoading: false }, kind)
  }

  test("every check renders verbatim with a status word for screen readers", () => {
    const view = setupView(onSetup("attention"), h)
    const text = textOf(view)
    for (const check of report("attention").checks) {
      expect(text).toContain(check.title)
      expect(text).toContain(check.detail)
    }
    expect(text).toContain("Warning: claude CLI isn't logged in")
    expect(text).toContain("Problem: Notifications are turned off")
    expect(text).toContain("2 need attention")
    expect(text).not.toContain("Welcome")
  })

  test("url fixes are plain anchors (new tab only for the web); copy fixes show the command", () => {
    const view = setupView(onSetup("attention"), h)
    const anchors = findAll(view, "a")
    const settings = anchors.find((a) =>
      String(attrOf(a, "href")).startsWith("x-apple.systempreferences:"),
    )
    expect(settings).toBeDefined()
    expect(attrOf(settings as never, "target")).toBeUndefined()
    const notes = anchors.find((a) => String(attrOf(a, "href")).startsWith("https://"))
    expect(attrOf(notes as never, "target")).toBe("_blank")
    expect(textOf(view)).toContain("claude /login")
    expect(textOf(view)).toContain("Copy login command")
    const copied = setupView(
      { ...onSetup("attention"), maybeCopiedFix: Option.some("claude-cli") },
      h,
    )
    expect(textOf(copied)).toContain("Copied")
  })

  test("first run: welcome with the three things to do", () => {
    const text = textOf(setupView(onSetup("firstrun"), h))
    expect(text).toContain("Welcome")
    expect(text).toContain("Allow notifications when macOS asks.")
    expect(text).toContain("Restart Claude sessions that were already open")
    expect(text).toContain("needs your approval")
  })

  test("all good, unknown, unavailable", () => {
    expect(textOf(setupView(onSetup("ok"), h))).toContain("Everything checks out")
    expect(textOf(setupView(onSetup("unknown"), h))).toContain("Running the setup check")
    expect(textOf(setupView(onSetup("unavailable"), h))).toContain("has no setup check")
  })

  test("nav entry: hidden until a report, badge when attention > 0", () => {
    expect(setupNavEntry(fresh(), h)).toBeNull()
    expect(setupNavEntry(update(fresh(), Message.FoundDoctorUnavailable()).model, h)).toBeNull()
    const ok = textOf(setupNavEntry(withReport(fresh(), "ok"), h))
    expect(ok).toBe("Setup check")
    const attention = setupNavEntry(withReport(fresh(), "attention"), h)
    expect(textOf(attention)).toBe("Setup check2")
  })

  test("popover: a setup row only when something needs attention", () => {
    const base = update(
      fresh("compact"),
      Message.SucceededFetchSnapshot({ snapshot: snapshotOf() }),
    ).model
    expect(textOf(compactView(withReport(base, "ok"), h))).not.toContain("Setup:")
    const row = textOf(compactView(withReport(base, "attention"), h))
    expect(row).toContain("Setup: 2 checks need attention")
  })
})

describe("popover: ready to review when nothing needs you", () => {
  test("lists review items under a quiet label, linking to each item", () => {
    const model = update(
      fresh("compact"),
      Message.SucceededFetchSnapshot({ snapshot: snapshotOf({ needs: "none" }) }),
    ).model
    const view = compactView(model, h)
    const text = textOf(view)
    expect(text).toContain("Nothing needs you right now.")
    expect(text).toContain("Ready to review")
    expect(text).toContain("ESC/POS driver done")
    expect(text).not.toContain("**")
    const hrefs = findAll(view, "a").map((a) => attrOf(a, "href"))
    expect(hrefs).toContain("/#/item/i-receipts-review")
    expect(hrefs).toContain("/#/item/i-docs-review")
  })

  test("not shown while something needs you", () => {
    const model = update(
      fresh("compact"),
      Message.SucceededFetchSnapshot({ snapshot: snapshotOf() }),
    ).model
    expect(textOf(compactView(model, h))).not.toContain("Ready to review")
  })
})

describe("settings dialog: Esc discards an uncommitted edit", () => {
  test("typing then closing the dialog (Esc) and the blur that follows save nothing", () => {
    const client = makeFakeClient({ now: () => NOW, simulate: false, delayScale: 0 })
    const s = (message: SettingsMessage) => Message.GotSettingsMessage({ message })
    const ret = run(
      fresh(),
      s(SettingsMessage.RequestedOpen()),
      s(SettingsMessage.SucceededFetchSettings({ response: Effect.runSync(client.getSettings) })),
      s(SettingsMessage.UpdatedDraft({ key: "holds.budgetMs", value: "45" })),
      s(SettingsMessage.GotDialogMessage({ message: Dialog.Message.RequestedClose() })),
      s(SettingsMessage.CommittedDraft({ key: "holds.budgetMs" })),
    )
    expect(names(ret)).toEqual([])
    expect(ret.model.settings.drafts).toEqual({})
  })
})
