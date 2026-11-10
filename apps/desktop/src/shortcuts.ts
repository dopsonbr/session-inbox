/** Pure helpers for the keyboard shortcuts (U-013, U-046, U-078); no DOM globals, so tests import it. */
import {
  isGlobalShortcut,
  parseShortcut,
  SHORTCUT_ACTIONS,
  SHORTCUT_DEFAULTS,
  type ShortcutAction,
  shortcutActionOf,
} from "@session-inbox/contracts"
import type { ShortcutTyping } from "./message.ts"

/** Marks the detail pane's own form (reply box, a question's fields); ⌘↵ there submits it. */
export const DETAIL_FORM = "detail-form"
export const DETAIL_FORM_ATTR = `data-${DETAIL_FORM}`

type PathNode = {
  tagName?: unknown
  isContentEditable?: unknown
  hasAttribute?: (name: string) => boolean
}

const isEditable = (node: PathNode) => {
  const tag = typeof node.tagName === "string" ? node.tagName.toLowerCase() : ""
  return (
    tag === "input" || tag === "textarea" || tag === "select" || node.isContentEditable === true
  )
}

/** From a key event's composed path: was it typed in a field, and was that field the detail's? */
export const shortcutTyping = (path: ReadonlyArray<unknown>): ShortcutTyping => {
  const nodes = path.filter((n): n is PathNode => typeof n === "object" && n !== null)
  if (!nodes.some(isEditable)) return "none"
  return nodes.some((n) => n.hasAttribute?.(DETAIL_FORM_ATTR) === true) ? "detailForm" : "elsewhere"
}

// BINDINGS (U-078): action → key press in the C-029 grammar, "" = none.

export type ShortcutBindings = Readonly<Record<ShortcutAction, string>>

export const DEFAULT_BINDINGS: ShortcutBindings = { ...SHORTCUT_DEFAULTS }

/**
 * Apply a `shortcuts` stream message (or a settings answer): known actions with a string value
 * replace the current one; unknown actions are ignored, missing ones keep their value.
 */
export const mergeBindings = (
  current: ShortcutBindings,
  incoming: Readonly<Record<string, unknown>>,
): ShortcutBindings => {
  const next: Record<ShortcutAction, string> = { ...current }
  for (const action of SHORTCUT_ACTIONS) {
    const value = incoming[action]
    if (typeof value === "string") next[action] = value
  }
  return next
}

/** The `shortcuts.*` keys of a settings object, keyed by action (for `mergeBindings`). */
export const bindingsInSettings = (
  settings: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(settings).flatMap(([key, value]) => {
      const action = shortcutActionOf(key)
      return action === null ? [] : [[action, value]]
    }),
  )

// DISPLAY

const MODIFIER_SYMBOL = { Mod: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧" } as const

const KEY_SYMBOL: Readonly<Record<string, string>> = {
  Enter: "↵",
  Backspace: "⌫",
  Delete: "⌦",
  Space: "Space",
  Plus: "+",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: "Page Up",
  PageDown: "Page Down",
}

/** A single character that isn't a letter or digit: typing it already involves Shift or not. */
const isSymbol = (key: string) => [...key].length === 1 && !/^[\p{L}\p{N}]$/u.test(key)

/**
 * A key press as the app prints it: `Mod+Shift+I` → "⌘⇧I", `Mod+Enter` → "⌘↵", `J` → "J",
 * `Shift+?` → "?" (a symbol's ⇧ is dropped: the symbol already says it). "" → "".
 */
export const displayShortcut = (raw: string): string => {
  if (raw === "") return ""
  const parsed = parseShortcut(raw)
  if (parsed === null) return raw
  const modifiers = parsed.modifiers.filter((m) => !(m === "Shift" && isSymbol(parsed.key)))
  return [...modifiers.map((m) => MODIFIER_SYMBOL[m]), KEY_SYMBOL[parsed.key] ?? parsed.key].join(
    "",
  )
}

/** For `aria-keyshortcuts`: ⌘ is `Meta` there. "" (none, or unreadable) means no attribute. */
export const ariaShortcut = (raw: string): string => {
  const parsed = raw === "" ? null : parseShortcut(raw)
  if (parsed === null) return ""
  const key = parsed.key === "Plus" ? "+" : parsed.key
  return [...parsed.modifiers.map((m) => (m === "Mod" ? "Meta" : m)), key].join("+")
}

// RECORDING: a keydown → a key press in the grammar.

/** What the Settings pane reads off a keydown while it records one. */
export type KeyPress = Readonly<{
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}>

const MODIFIER_KEYS = [
  "Meta",
  "Control",
  "Alt",
  "AltGraph",
  "Shift",
  "CapsLock",
  "Fn",
  "FnLock",
  "Hyper",
  "Super",
  "OS",
  "Symbol",
  "SymbolLock",
  "NumLock",
  "ScrollLock",
]

/** A keydown of a modifier on its own: recording waits for the real key. */
export const isModifierOnly = (press: Pick<KeyPress, "key">): boolean =>
  MODIFIER_KEYS.includes(press.key) || press.key === "Dead" || press.key === "Unidentified"

const keyFromCode = (code: string): string | null => {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter !== null) return letter[1] ?? null
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit !== null) return digit[1] ?? null
  return /^F([1-9]|1[0-2])$/.test(code) ? code : null
}

const keyFromKey = (key: string): string => {
  if (key === " ") return "Space"
  if (key === "+") return "Plus"
  return [...key].length === 1 ? key.toUpperCase() : key
}

/**
 * The grammar for a recorded keydown; null for a modifier on its own. A page shortcut uses
 * `event.key` (what the layout types). The global one uses `event.code` for letters, digits and
 * F-keys, since ⌥ changes `key` on a Mac (⌥I types "ˆ"); anything else falls back to `key` and
 * `shortcutProblem` then says why it can't be used.
 */
export const shortcutFromKeyPress = (press: KeyPress, action: ShortcutAction): string | null => {
  if (isModifierOnly(press)) return null
  const fromCode = isGlobalShortcut(action) ? keyFromCode(press.code) : null
  const key = fromCode ?? keyFromKey(press.key)
  const modifiers = [
    press.metaKey ? "Mod" : null,
    press.ctrlKey ? "Control" : null,
    press.altKey ? "Alt" : null,
    press.shiftKey ? "Shift" : null,
  ].filter((m): m is string => m !== null)
  return [...modifiers, key].join("+")
}

/** Esc with no modifiers cancels recording. */
export const isCancelPress = (press: KeyPress): boolean =>
  press.key === "Escape" && !press.metaKey && !press.ctrlKey && !press.altKey && !press.shiftKey

// BINDING TABLE (what subscriptions hand to `Dom.streamFromKeyBindings`)

export type ModKey = "Meta" | "Control"

export type BindingEntry = Readonly<{
  action: Exclude<ShortcutAction, "openInbox">
  /** For Foldkit: `Mod` already resolved to `modKey`. */
  keys: string
  whileTyping: "Allow" | "Suppress"
  /** `submit` with ⌘/⌃: the update decides by where it was typed (`shortcutTyping`). */
  readsTyping: boolean
}>

/**
 * The page's key bindings from the current ones. Skipped: unset actions, the global one, key
 * presses that don't parse (or that Foldkit refuses: Mod with Control where Mod is Control),
 * and a key press already taken by an earlier action in SHORTCUT_ACTIONS order (Foldkit
 * throws on duplicates). Nothing at all while the Settings pane records a key press.
 */
export const bindingTable = (
  bindings: ShortcutBindings,
  options: Readonly<{ isRecording: boolean; modKey: ModKey }>,
): ReadonlyArray<BindingEntry> => {
  if (options.isRecording) return []
  const taken = new Set<string>()
  const table: Array<BindingEntry> = []
  for (const action of SHORTCUT_ACTIONS) {
    if (action === "openInbox" || isGlobalShortcut(action)) continue
    const raw = bindings[action]
    const parsed = raw === "" ? null : parseShortcut(raw)
    if (parsed === null) continue
    const hasMod = parsed.modifiers.includes("Mod")
    const hasControl = parsed.modifiers.includes("Control")
    if (hasMod && hasControl && options.modKey === "Control") continue
    const keys = [
      ...parsed.modifiers.map((m) => (m === "Mod" ? options.modKey : m)),
      parsed.key,
    ].join("+")
    const identity = keys.toLowerCase()
    if (taken.has(identity)) continue
    taken.add(identity)
    const isCommand = hasMod || hasControl
    table.push({
      action,
      keys,
      // ⌘⌫ / ⌃⌫ still deletes text in a field; a plain key is for typing.
      whileTyping: isCommand && action !== "deny" ? "Allow" : "Suppress",
      readsTyping: action === "submit" && isCommand,
    })
  }
  return table
}

/** The Settings row labels, in SHORTCUT_ACTIONS order (U-078). */
export const SHORTCUT_LABELS: Readonly<Record<ShortcutAction, string>> = {
  openInbox: "Open the inbox from any app",
  jump: "Jump to a session",
  submit: "Main action: Allow once, Send answers or Send reply",
  deny: "Deny",
  next: "Next item in the list",
  previous: "Previous item in the list",
  done: "Done: clear a review or failed item",
  settings: "Open Settings",
  help: "Show the shortcut list",
}

/** Settings rows: the system-wide one first, then the page ones. */
export const SHORTCUT_ROW_ORDER: ReadonlyArray<ShortcutAction> = [
  "openInbox",
  ...SHORTCUT_ACTIONS.filter((a) => a !== "openInbox"),
]

/** What a row says for an action with no key press. */
export const NOT_SET_TEXT = "Not set"
