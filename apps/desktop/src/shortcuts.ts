/** Pure helpers for the keyboard shortcuts (U-013, U-046); no DOM globals, so tests import it. */
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
