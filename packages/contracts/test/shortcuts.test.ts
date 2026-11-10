import { describe, expect, test } from "bun:test"
import {
  normalizeShortcut,
  parseShortcut,
  SHORTCUT_ACTIONS,
  SHORTCUT_DEFAULTS,
  shortcutActionOf,
  shortcutClashes,
  shortcutProblem,
  shortcutSettingKey,
  UserSettings,
} from "../src/index.ts"

describe("shortcut settings (C-029)", () => {
  test("every action has a setting key and a usable default", () => {
    for (const action of SHORTCUT_ACTIONS) {
      const key = shortcutSettingKey(action)
      expect(key in UserSettings.fields).toBe(true)
      expect(shortcutActionOf(key)).toBe(action)
      expect(normalizeShortcut(action, SHORTCUT_DEFAULTS[action])).toBe(SHORTCUT_DEFAULTS[action])
      expect(shortcutClashes(SHORTCUT_DEFAULTS, action)).toEqual([])
    }
    expect(shortcutActionOf("shortcuts.nope")).toBeNull()
    expect(shortcutActionOf("holds.enabled")).toBeNull()
  })

  test("parses into canonical spelling and order", () => {
    expect(parseShortcut("shift+mod+k")).toEqual({ modifiers: ["Mod", "Shift"], key: "K" })
    expect(parseShortcut("Mod + enter")).toEqual({ modifiers: ["Mod"], key: "Enter" })
    expect(parseShortcut("j")).toEqual({ modifiers: [], key: "J" })
    expect(parseShortcut("Shift+?")).toEqual({ modifiers: ["Shift"], key: "?" })
    expect(parseShortcut("Mod+Plus")).toEqual({ modifiers: ["Mod"], key: "Plus" })
    expect(parseShortcut("Mod+f5")).toEqual({ modifiers: ["Mod"], key: "F5" })
    for (const bad of ["", "Mod+", "Mod+Mod+K", "Hyper+K", "Mod+Escape", "Tab", "Mod+two words"])
      expect(parseShortcut(bad)).toBeNull()
  })

  test('normalizes, keeps "" as none, and refuses what can\'t be bound', () => {
    expect(normalizeShortcut("jump", " mod+p ")).toBe("Mod+P")
    expect(normalizeShortcut("next", "n")).toBe("N")
    expect(normalizeShortcut("next", "")).toBe("")
    expect(normalizeShortcut("help", "F1")).toBe("F1")
    expect(normalizeShortcut("deny", "Control+Shift+D")).toBe("Control+Shift+D")
    expect(normalizeShortcut("next", "nonsense")).toBeNull()
  })

  test("page shortcuts: no ⌥, and no bare Enter, arrows or Backspace", () => {
    expect(shortcutProblem("next", "Alt+J")).toContain("⌥")
    expect(shortcutProblem("submit", "Enter")).toContain("Add ⌘ or ⌃")
    expect(shortcutProblem("next", "ArrowDown")).toContain("Add ⌘ or ⌃")
    expect(shortcutProblem("deny", "Backspace")).not.toBeNull()
    expect(shortcutProblem("next", "Mod+ArrowDown")).toBeNull()
    expect(shortcutProblem("next", "/")).toBeNull()
    expect(shortcutProblem("next", "")).toBeNull()
  })

  test("the global shortcut needs a modifier and a fixed key", () => {
    expect(shortcutProblem("openInbox", "I")).toContain("every app")
    expect(shortcutProblem("openInbox", "Shift+I")).toContain("every app")
    expect(shortcutProblem("openInbox", "Mod+?")).toContain("letter")
    expect(shortcutProblem("openInbox", "Mod+Enter")).toContain("letter")
    expect(normalizeShortcut("openInbox", "alt+mod+shift+i")).toBe("Mod+Alt+Shift+I")
    expect(normalizeShortcut("openInbox", "Control+F6")).toBe("Control+F6")
  })

  test("clashes are found among page shortcuts, ignoring case and unset ones", () => {
    const bindings = { ...SHORTCUT_DEFAULTS, previous: "j", done: "", help: "" }
    expect(shortcutClashes(bindings, "next")).toEqual(["previous"])
    expect(shortcutClashes(bindings, "previous")).toEqual(["next"])
    expect(shortcutClashes(bindings, "done")).toEqual([])
    // The global key lives in another space: the same press in the page isn't a clash.
    expect(shortcutClashes({ ...SHORTCUT_DEFAULTS, jump: "Mod+Shift+I" }, "openInbox")).toEqual([])
  })
})
