/**
 * Keyboard shortcuts as settings (C-029). One setting per action, `shortcuts.<action>`, whose
 * value is a key press in the grammar below, or "" for "no shortcut". The daemon stores and
 * validates them; the UI binds the page shortcuts and the menu-bar app binds the global one.
 *
 * Grammar: modifiers joined to one key with `+`, modifiers first and in this order:
 * `Mod` (⌘ on a Mac), `Control`, `Alt`, `Shift`. The key is what `KeyboardEvent.key` reports
 * (a single character, upper-cased) or one of NAMED_KEYS; a literal plus is `Plus` and the
 * space bar is `Space`. Examples: `Mod+K`, `J`, `Shift+?`, `Mod+Backspace`, `Mod+Alt+Shift+I`.
 */

export const SHORTCUT_ACTIONS = [
  "jump",
  "submit",
  "deny",
  "next",
  "previous",
  "done",
  "settings",
  "help",
  "openInbox",
] as const
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number]

/** Registered system-wide by the menu-bar app; the rest work inside the inbox window. */
export const GLOBAL_SHORTCUT_ACTIONS: ReadonlyArray<ShortcutAction> = ["openInbox"]
export const isGlobalShortcut = (action: ShortcutAction): boolean =>
  GLOBAL_SHORTCUT_ACTIONS.includes(action)

export type ShortcutSettingKey = `shortcuts.${ShortcutAction}`
export const shortcutSettingKey = (action: ShortcutAction): ShortcutSettingKey =>
  `shortcuts.${action}`
export const SHORTCUT_SETTING_KEYS: ReadonlyArray<ShortcutSettingKey> =
  SHORTCUT_ACTIONS.map(shortcutSettingKey)
export const shortcutActionOf = (key: string): ShortcutAction | null => {
  const action = key.startsWith("shortcuts.") ? key.slice("shortcuts.".length) : ""
  return (SHORTCUT_ACTIONS as ReadonlyArray<string>).includes(action)
    ? (action as ShortcutAction)
    : null
}

/** The GA defaults. The beta install's menu-bar app opens with `Mod+Alt+Shift+I` (S-012). */
export const SHORTCUT_DEFAULTS: Readonly<Record<ShortcutAction, string>> = {
  jump: "Mod+K",
  submit: "Mod+Enter",
  deny: "Mod+Backspace",
  next: "J",
  previous: "K",
  done: "E",
  settings: "Mod+,",
  help: "Shift+?",
  openInbox: "Mod+Shift+I",
}
export const BETA_OPEN_INBOX_SHORTCUT = "Mod+Alt+Shift+I"

export const SHORTCUT_MODIFIERS = ["Mod", "Control", "Alt", "Shift"] as const
export type ShortcutModifier = (typeof SHORTCUT_MODIFIERS)[number]

const FUNCTION_KEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`)
/** Keys with a name. Escape and Tab are left out on purpose: they close and move focus. */
export const NAMED_KEYS: ReadonlyArray<string> = [
  "Enter",
  "Backspace",
  "Delete",
  "Space",
  "Plus",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  ...FUNCTION_KEYS,
]

export interface ParsedShortcut {
  readonly modifiers: ReadonlyArray<ShortcutModifier>
  readonly key: string
}

const canonical = (list: ReadonlyArray<string>, token: string): string | undefined =>
  list.find((k) => k.toLowerCase() === token.toLowerCase())

/** Split a key press into modifiers and key, in canonical spelling; null when malformed. */
export const parseShortcut = (raw: string): ParsedShortcut | null => {
  const tokens = raw.split("+").map((t) => t.trim())
  const keyToken = tokens.pop()
  if (keyToken === undefined || keyToken === "" || /\s/.test(keyToken)) return null
  const modifiers: ShortcutModifier[] = []
  for (const token of tokens) {
    const modifier = canonical(SHORTCUT_MODIFIERS, token) as ShortcutModifier | undefined
    if (modifier === undefined || modifiers.includes(modifier)) return null
    modifiers.push(modifier)
  }
  modifiers.sort((a, b) => SHORTCUT_MODIFIERS.indexOf(a) - SHORTCUT_MODIFIERS.indexOf(b))
  const key = [...keyToken].length === 1 ? keyToken.toUpperCase() : canonical(NAMED_KEYS, keyToken)
  return key === undefined ? null : { modifiers, key }
}

export const formatShortcut = (parsed: ParsedShortcut): string =>
  [...parsed.modifiers, parsed.key].join("+")

/** Why a key press can't be this action's shortcut, in words for the Settings pane. */
export const shortcutProblem = (action: ShortcutAction, raw: string): string | null => {
  if (raw === "") return null
  const parsed = parseShortcut(raw)
  if (parsed === null) return "That isn't a key press this app can use."
  const { modifiers, key } = parsed
  const isCommand = modifiers.includes("Mod") || modifiers.includes("Control")
  if (isGlobalShortcut(action)) {
    // It fires in every app, so it must not be a key you type, and the menu-bar app can
    // only register keys with a fixed position on the keyboard.
    if (!isCommand && !modifiers.includes("Alt"))
      return "A shortcut that works in every app needs ⌘, ⌃ or ⌥."
    if (!/^[A-Z0-9]$/.test(key) && !FUNCTION_KEYS.includes(key))
      return "Use a letter, a digit or F1 to F12 for this one."
    return null
  }
  // ⌥ changes the character a Mac keyboard types, so a page shortcut with it can't be matched.
  if (modifiers.includes("Alt")) return "⌥ can't be used here. Use ⌘, ⌃ or a plain key."
  if (!isCommand && [...key].length > 1 && !FUNCTION_KEYS.includes(key))
    return `${key} on its own is needed for typing and moving around. Add ⌘ or ⌃.`
  return null
}

/**
 * A shortcut setting as the daemon stores it: "" (none) or the canonical spelling.
 * Null when it isn't usable for this action (the daemon answers 400).
 */
export const normalizeShortcut = (action: ShortcutAction, raw: string): string | null => {
  const trimmed = raw.trim()
  if (trimmed === "") return ""
  if (shortcutProblem(action, trimmed) !== null) return null
  const parsed = parseShortcut(trimmed)
  return parsed === null ? null : formatShortcut(parsed)
}

/** Other actions bound to the same key press ("" never clashes). Page and global don't mix. */
export const shortcutClashes = (
  bindings: Readonly<Partial<Record<ShortcutAction, string>>>,
  action: ShortcutAction,
): ReadonlyArray<ShortcutAction> => {
  const mine = bindings[action]
  if (mine === undefined || mine === "") return []
  return SHORTCUT_ACTIONS.filter(
    (other) =>
      other !== action &&
      isGlobalShortcut(other) === isGlobalShortcut(action) &&
      bindings[other]?.toLowerCase() === mine.toLowerCase(),
  )
}
