/** Configurable shortcuts in the UI (U-078): pure helpers, the Model, Settings rows and views. */
import { describe, expect, test } from "bun:test"
import { SHORTCUT_DEFAULTS, type StreamMessage } from "@session-inbox/contracts"
import { Effect, Option, Stream } from "effect"
import { makeFakeClient } from "../src/client/fake.ts"
import { Message } from "../src/message.ts"
import type { Model } from "../src/model.ts"
import { SettingsMessage } from "../src/settings.ts"
import {
  ariaShortcut,
  bindingTable,
  DEFAULT_BINDINGS,
  displayShortcut,
  type KeyPress,
  mergeBindings,
  shortcutFromKeyPress,
} from "../src/shortcuts.ts"
import { initialModel, type UpdateReturn, update } from "../src/update.ts"
import { approvalCard, doneButton } from "../src/view/detail.ts"
import { headerView, navView } from "../src/view/nav.ts"
import { shortcutRows } from "../src/view/overlays.ts"
import { FIXED_KEYS_TEXT, RECORDING_TEXT, settingsBody } from "../src/view/settings.ts"
import { attrOf, findAll, h, textOf } from "./vnode.ts"

const NOW = 1_800_000_000_000
const client = () => makeFakeClient({ now: () => NOW, simulate: false, delayScale: 0 })
const run = (start: Model, ...messages: ReadonlyArray<Message>): UpdateReturn =>
  messages.reduce<UpdateReturn>((acc, m) => update(acc.model, m), { model: start })
const s = (message: SettingsMessage): Message => Message.GotSettingsMessage({ message })
const names = (ret: UpdateReturn) => (ret.commands ?? []).map((c) => c.name)
const savePatch = (ret: UpdateReturn) => {
  const command = (ret.commands ?? []).find((c) => c.name === "SaveSettings") as unknown as
    | { args: { key: string; seq: number; patch: Record<string, unknown> } }
    | undefined
  if (command === undefined) throw new Error("expected SaveSettings")
  return command.args
}

const fresh = (): Model =>
  initialModel({ view: "full", now: NOW, maybeInitialItemId: Option.none() })

const opened = (start: Model = fresh()): Model =>
  run(
    start,
    s(SettingsMessage.RequestedOpen()),
    s(
      SettingsMessage.SucceededFetchSettings({
        response: Effect.runSync(client().getSettings),
      }),
    ),
  ).model

const showing = (itemId: string): Model => {
  const c = client()
  return run(
    initialModel({ view: "full", now: NOW, maybeInitialItemId: Option.some(itemId) }),
    Message.SucceededFetchSnapshot({ snapshot: Effect.runSync(c.snapshot) }),
    Message.SucceededFetchItemDetail({ detail: Effect.runSync(c.itemDetail(itemId)) }),
  ).model
}

const press = (key: string, more: Partial<KeyPress> = {}): KeyPress => ({
  key,
  code: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...more,
})

const shortcutsMessage = (bindings: Record<string, string>): Message =>
  Message.ReceivedStreamMessage({ message: { _tag: "shortcuts", seq: 1, bindings } })

describe("a keydown as a key press (recording)", () => {
  test("letters are upper-cased; modifiers come from the event in grammar order", () => {
    expect(shortcutFromKeyPress(press("n"), "next")).toBe("N")
    expect(shortcutFromKeyPress(press("k", { metaKey: true }), "jump")).toBe("Mod+K")
    expect(
      shortcutFromKeyPress(
        press("x", { metaKey: true, ctrlKey: true, altKey: true, shiftKey: true }),
        "jump",
      ),
    ).toBe("Mod+Control+Alt+Shift+X")
    expect(shortcutFromKeyPress(press("Enter", { ctrlKey: true }), "submit")).toBe("Control+Enter")
  })

  test("symbols as typed, Space and Plus by name", () => {
    expect(shortcutFromKeyPress(press("?", { shiftKey: true }), "help")).toBe("Shift+?")
    expect(shortcutFromKeyPress(press(",", { metaKey: true }), "settings")).toBe("Mod+,")
    expect(shortcutFromKeyPress(press(" "), "next")).toBe("Space")
    expect(shortcutFromKeyPress(press("+", { shiftKey: true }), "next")).toBe("Shift+Plus")
  })

  test("the global one reads event.code, so ⌥ doesn't change the key", () => {
    const optionI = press("ˆ", { code: "KeyI", metaKey: true, altKey: true, shiftKey: true })
    expect(shortcutFromKeyPress(optionI, "openInbox")).toBe("Mod+Alt+Shift+I")
    expect(shortcutFromKeyPress(press("¡", { code: "Digit1", altKey: true }), "openInbox")).toBe(
      "Alt+1",
    )
    expect(shortcutFromKeyPress(press("F5", { code: "F5", ctrlKey: true }), "openInbox")).toBe(
      "Control+F5",
    )
    // A page shortcut uses key: ⌥ makes it unusable and shortcutProblem says so.
    expect(shortcutFromKeyPress(optionI, "jump")).toBe("Mod+Alt+Shift+ˆ")
  })

  test("a modifier on its own is not a key press", () => {
    for (const key of ["Meta", "Control", "Alt", "Shift", "CapsLock"]) {
      expect(shortcutFromKeyPress(press(key, { metaKey: true }), "jump")).toBeNull()
    }
  })
})

describe("how a key press is printed", () => {
  test("every default", () => {
    expect(displayShortcut(SHORTCUT_DEFAULTS.jump)).toBe("⌘K")
    expect(displayShortcut(SHORTCUT_DEFAULTS.submit)).toBe("⌘↵")
    expect(displayShortcut(SHORTCUT_DEFAULTS.deny)).toBe("⌘⌫")
    expect(displayShortcut(SHORTCUT_DEFAULTS.next)).toBe("J")
    expect(displayShortcut(SHORTCUT_DEFAULTS.previous)).toBe("K")
    expect(displayShortcut(SHORTCUT_DEFAULTS.done)).toBe("E")
    expect(displayShortcut(SHORTCUT_DEFAULTS.settings)).toBe("⌘,")
    expect(displayShortcut(SHORTCUT_DEFAULTS.help)).toBe("?")
    expect(displayShortcut(SHORTCUT_DEFAULTS.openInbox)).toBe("⌘⇧I")
    expect(displayShortcut("Mod+Alt+Shift+I")).toBe("⌘⌥⇧I")
  })

  test("named keys, ⌃, and ⇧ kept on letters but dropped on symbols", () => {
    expect(displayShortcut("Control+Delete")).toBe("⌃⌦")
    expect(displayShortcut("Mod+Space")).toBe("⌘Space")
    expect(displayShortcut("Mod+Plus")).toBe("⌘+")
    expect(displayShortcut("Mod+ArrowUp")).toBe("⌘↑")
    expect(displayShortcut("Shift+N")).toBe("⇧N")
    expect(displayShortcut("Mod+Shift+!")).toBe("⌘!")
    expect(displayShortcut("")).toBe("")
  })

  test("aria-keyshortcuts says Meta for ⌘ and nothing for none", () => {
    expect(ariaShortcut("Mod+Enter")).toBe("Meta+Enter")
    expect(ariaShortcut("Shift+?")).toBe("Shift+?")
    expect(ariaShortcut("Mod+Plus")).toBe("Meta++")
    expect(ariaShortcut("")).toBe("")
  })
})

describe("the binding table", () => {
  const meta = { isRecording: false, modKey: "Meta" as const }

  test("defaults: eight page bindings, Mod resolved, the global one left out", () => {
    const table = bindingTable(DEFAULT_BINDINGS, meta)
    expect(table.map((e) => e.action)).toEqual([
      "jump",
      "submit",
      "deny",
      "next",
      "previous",
      "done",
      "settings",
      "help",
    ])
    expect(table.find((e) => e.action === "jump")?.keys).toBe("Meta+K")
    expect(bindingTable(DEFAULT_BINDINGS, { ...meta, modKey: "Control" })[0]?.keys).toBe(
      "Control+K",
    )
  })

  test("while typing: ⌘/⌃ ones allowed except deny; plain keys never; submit reads the field", () => {
    const by = (action: string) =>
      bindingTable(DEFAULT_BINDINGS, meta).find((e) => e.action === action)
    expect(by("jump")?.whileTyping).toBe("Allow")
    expect(by("settings")?.whileTyping).toBe("Allow")
    expect(by("submit")).toMatchObject({ whileTyping: "Allow", readsTyping: true })
    expect(by("deny")?.whileTyping).toBe("Suppress")
    expect(by("next")?.whileTyping).toBe("Suppress")
    expect(by("help")?.whileTyping).toBe("Suppress")
    const plainSubmit = bindingTable({ ...DEFAULT_BINDINGS, submit: "F5" }, meta)
    expect(plainSubmit.find((e) => e.action === "submit")).toMatchObject({
      whileTyping: "Suppress",
      readsTyping: false,
    })
    const ctrlNext = bindingTable({ ...DEFAULT_BINDINGS, next: "Control+N" }, meta)
    expect(ctrlNext.find((e) => e.action === "next")?.whileTyping).toBe("Allow")
  })

  test("unset and unreadable are skipped; a shared key press keeps only the first", () => {
    const table = bindingTable(
      { ...DEFAULT_BINDINGS, jump: "", done: "j", help: "Mod+Shift+Nope+" },
      meta,
    )
    const actions = table.map((e) => e.action)
    expect(actions).not.toContain("jump")
    expect(actions).not.toContain("done")
    expect(actions).not.toContain("help")
    expect(actions).toContain("next")
  })

  test("Mod with Control is skipped only where Mod is Control", () => {
    const both = { ...DEFAULT_BINDINGS, jump: "Mod+Control+K" }
    expect(bindingTable(both, meta)[0]?.keys).toBe("Meta+Control+K")
    expect(bindingTable(both, { ...meta, modKey: "Control" })[0]?.action).toBe("submit")
  })

  test("nothing at all while Settings records a key press", () => {
    expect(bindingTable(DEFAULT_BINDINGS, { ...meta, isRecording: true })).toEqual([])
  })
})

describe("bindings in the Model", () => {
  test("start at the defaults; a stream message replaces known actions only", () => {
    expect(fresh().shortcuts).toEqual(DEFAULT_BINDINGS)
    const next = update(fresh(), shortcutsMessage({ next: "N", jump: "", bogus: "X" })).model
    expect(next.shortcuts.next).toBe("N")
    expect(next.shortcuts.jump).toBe("")
    expect(next.shortcuts.previous).toBe("K")
    expect("bogus" in next.shortcuts).toBe(false)
    expect(mergeBindings(DEFAULT_BINDINGS, { next: 5 }).next).toBe("J")
  })

  test("a saved shortcut setting replaces the binding", () => {
    const response = Effect.runSync(client().putSettings({ "shortcuts.next": "N" }))
    const ret = run(
      opened(),
      s(SettingsMessage.ClickedRecordShortcut({ key: "shortcuts.next" })),
      s(SettingsMessage.PressedRecordingKey({ press: press("n") })),
    )
    const { key, seq } = savePatch(ret)
    const saved = update(
      ret.model,
      s(SettingsMessage.SucceededSaveSettings({ key, seq, response })),
    )
    expect(saved.model.shortcuts.next).toBe("N")
  })

  test("the fake daemon sends shortcuts after hello and when one changes", async () => {
    const c = client()
    const first = await Effect.runPromise(Stream.runCollect(Stream.take(c.stream(null), 2)))
    const messages = Array.from(first) as Array<StreamMessage>
    expect(messages[0]?._tag).toBe("hello")
    expect(messages[1]).toMatchObject({ _tag: "shortcuts", bindings: SHORTCUT_DEFAULTS })
    const later = Effect.runPromise(Stream.runCollect(Stream.take(c.stream(null), 3)))
    await new Promise((r) => setTimeout(r, 10))
    Effect.runSync(c.putSettings({ "shortcuts.next": "n" }))
    const all = Array.from(await later) as Array<StreamMessage>
    expect(all[2]).toMatchObject({ _tag: "shortcuts", bindings: { next: "N" } })
  })

  test("the fake daemon refuses an unusable key press with the key's name", () => {
    const failed = Effect.runSync(Effect.flip(client().putSettings({ "shortcuts.jump": "Alt+K" })))
    expect(failed.status).toBe(400)
    expect(failed.message).toStartWith("shortcuts.jump: ")
  })
})

describe("recording in Settings", () => {
  const start = () =>
    run(opened(), s(SettingsMessage.ClickedRecordShortcut({ key: "shortcuts.next" })))
  const loadedShown = (model: Model) =>
    model.settings.load._tag === "Loaded"
      ? (model.settings.load.loaded.shown as Record<string, unknown>)
      : {}

  test("Change starts recording one row; Cancel, Esc and closing stop it", () => {
    const recording = start().model
    expect(recording.settings.recording).toBe("shortcuts.next")
    const other = update(
      recording,
      s(SettingsMessage.ClickedRecordShortcut({ key: "shortcuts.done" })),
    ).model
    expect(other.settings.recording).toBe("shortcuts.done")
    expect(
      update(recording, s(SettingsMessage.ClickedCancelRecording())).model.settings.recording,
    ).toBeNull()
    const escaped = update(
      recording,
      s(SettingsMessage.PressedRecordingKey({ press: press("Escape") })),
    )
    expect(escaped.model.settings.recording).toBeNull()
    expect(names(escaped)).toEqual([])
    expect(
      update(recording, s(SettingsMessage.RequestedClose())).model.settings.recording,
    ).toBeNull()
  })

  test("a key press with a problem shows it and keeps recording; nothing is saved", () => {
    const ret = run(
      start().model,
      s(SettingsMessage.PressedRecordingKey({ press: press("Backspace") })),
    )
    expect(names(ret)).toEqual([])
    expect(ret.model.settings.recording).toBe("shortcuts.next")
    expect(ret.model.settings.status["shortcuts.next"]).toMatchObject({
      _tag: "Failed",
      error: "Backspace on its own is needed for typing and moving around. Add ⌘ or ⌃.",
    })
    const view = settingsBody(ret.model, h)
    expect(textOf(view)).toContain("Backspace on its own is needed")
    expect(findAll(view, "p").some((p) => attrOf(p, "role") === "alert")).toBe(true)
  })

  test("a good key press saves just that key and stops recording", () => {
    const ret = run(start().model, s(SettingsMessage.PressedRecordingKey({ press: press("n") })))
    expect(savePatch(ret).patch).toEqual({ "shortcuts.next": "N" })
    expect(ret.model.settings.recording).toBeNull()
    expect(loadedShown(ret.model)["shortcuts.next"]).toBe("N")
  })

  test("the daemon's 400 shows under the row without the key's name", () => {
    const ret = run(start().model, s(SettingsMessage.PressedRecordingKey({ press: press("n") })))
    const { key, seq } = savePatch(ret)
    const failed = update(
      ret.model,
      s(
        SettingsMessage.FailedSaveSettings({
          key,
          seq,
          error: "shortcuts.next: That isn't a key press this app can use.",
        }),
      ),
    ).model
    expect(failed.settings.status["shortcuts.next"]).toMatchObject({
      error: "That isn't a key press this app can use.",
    })
    expect(loadedShown(failed)["shortcuts.next"]).toBe("J")
  })

  test("Clear saves an empty key press; Reset sends null", () => {
    const cleared = run(
      opened(),
      s(SettingsMessage.ClickedClearShortcut({ key: "shortcuts.done" })),
    )
    expect(savePatch(cleared).patch).toEqual({ "shortcuts.done": "" })
    const reset = run(opened(), s(SettingsMessage.ClickedReset({ key: "shortcuts.done" })))
    expect(savePatch(reset).patch).toEqual({ "shortcuts.done": null })
  })

  test("Reset all includes every shortcut", () => {
    const all = run(opened(), s(SettingsMessage.ClickedResetAll()))
    const patch = savePatch(all).patch
    for (const action of Object.keys(SHORTCUT_DEFAULTS)) {
      expect(patch[`shortcuts.${action}`]).toBeNull()
    }
  })
})

describe("views print the current key presses", () => {
  test("the Settings group: rows, Not set, Clear and Reset only when they apply", () => {
    const model = opened()
    const text = textOf(settingsBody(model, h))
    expect(text).toContain("Shortcuts")
    expect(text).toContain("Open the inbox from any app")
    expect(text).toContain("Works system-wide, from the menu-bar app.")
    expect(text).toContain(FIXED_KEYS_TEXT)
    const buttons = (m: Model) => findAll(settingsBody(m, h), "button").map((b) => textOf(b))
    expect(buttons(model).filter((b) => b === "Change")).toHaveLength(9)
    expect(buttons(model).filter((b) => b === "Clear")).toHaveLength(9)
    expect(buttons(model).filter((b) => b === "Reset")).toHaveLength(0)
    const cleared = run(model, s(SettingsMessage.ClickedClearShortcut({ key: "shortcuts.done" })))
    expect(textOf(settingsBody(cleared.model, h))).toContain("Not set")
    expect(buttons(cleared.model).filter((b) => b === "Clear")).toHaveLength(8)
    expect(buttons(cleared.model).filter((b) => b === "Reset")).toHaveLength(1)
    const recording = run(
      model,
      s(SettingsMessage.ClickedRecordShortcut({ key: "shortcuts.done" })),
    )
    expect(textOf(settingsBody(recording.model, h))).toContain(RECORDING_TEXT)
    expect(buttons(recording.model)).toContain("Cancel")
  })

  test("a clash is a warning naming the other action", () => {
    const ret = run(opened(), s(SettingsMessage.ClickedRecordShortcut({ key: "shortcuts.done" })))
    const saved = run(ret.model, s(SettingsMessage.PressedRecordingKey({ press: press("j") })))
    expect(names(saved)).toEqual(["SaveSettings"])
    const text = textOf(settingsBody(saved.model, h))
    expect(text).toContain(
      "Also set for Next item in the list. Only the first one listed will work.",
    )
    expect(text).toContain(
      "Also set for Done: clear a review or failed item. Only the first one listed will work.",
    )
  })

  test("next set to N: the dialog row says N; an unset one says Not set", () => {
    const model = update(fresh(), shortcutsMessage({ next: "N", jump: "" })).model
    const rows = shortcutRows(model.shortcuts)
    expect(rows.find((r) => r.does === "Next item in the list")?.keys).toEqual(["N"])
    expect(rows.find((r) => r.does === "Jump to a session")?.keys).toEqual([])
    expect(rows.slice(-2).map((r) => r.does)).toEqual([
      "Move in the session tree",
      "Close a dialog or menu",
    ])
    expect(textOf(navView(model, h))).not.toContain("⌘K")
  })

  test("Done prints the current key press and aria-keyshortcuts follow it", () => {
    const base = showing("i-receipts-review")
    const done = (m: Model) => findAll(doneButton(m, h), "button")[0]
    expect(textOf(done(base))).toBe("DoneE")
    const changed = update(base, shortcutsMessage({ done: "Shift+D" })).model
    expect(textOf(done(changed))).toBe("Done⇧D")
    expect(attrOf(done(changed) as never, "aria-keyshortcuts")).toBe("Shift+D")
    const unset = update(base, shortcutsMessage({ done: "" })).model
    expect(textOf(done(unset))).toBe("Done")
    expect(attrOf(done(unset) as never, "aria-keyshortcuts")).toBeUndefined()
  })

  test("Allow once and Deny print submit and deny", () => {
    const card = (m: Model) => {
      if (m.detail._tag !== "Loaded" || m.detail.detail.approval === null) {
        throw new Error("no approval")
      }
      return approvalCard(m, m.detail.detail, m.detail.detail.approval, h)
    }
    const base = showing("i-ravelo-migrate")
    const buttonText = (m: Model) => findAll(card(m), "button").map((b) => textOf(b))
    expect(buttonText(base)).toContain("Allow once⌘↵")
    expect(buttonText(base)).toContain("Deny⌘⌫")
    const changed = update(base, shortcutsMessage({ submit: "Control+Enter", deny: "" })).model
    expect(buttonText(changed)).toContain("Allow once⌃↵")
    expect(buttonText(changed)).toContain("Deny")
  })

  test("the nav's ? follows help, and the header's jump field follows jump", () => {
    const model = update(fresh(), shortcutsMessage({ help: "F1", jump: "Mod+J" })).model
    expect(textOf(navView(model, h))).toContain("ShortcutsF1")
    expect(textOf(headerView(model, h))).toContain("Jump to session⌘J")
    expect(textOf(headerView(fresh(), h))).toContain("Jump to session⌘K")
  })
})
