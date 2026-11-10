import type { AttentionKind, HistoryOutcome, Item, Session } from "@session-inbox/contracts"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Message } from "../message.ts"
import { ariaShortcut, displayShortcut } from "../shortcuts.ts"

type H = HtmlBuilder<Message>

// ICONS (lucide-style strokes; always aria-hidden — the word next to them carries meaning)

const icon = (h: H, paths: ReadonlyArray<string>, className = "size-[14px]"): Html =>
  h.svg(
    [
      h.ViewBox("0 0 24 24"),
      h.Fill("none"),
      h.Stroke("currentColor"),
      h.StrokeWidth("2.25"),
      h.StrokeLinecap("round"),
      h.StrokeLinejoin("round"),
      h.AriaHidden(true),
      h.Class(`${className} shrink-0`),
    ],
    paths.map((d) => h.path([h.D(d)])),
  )

export const Icon = {
  chevronDown: (h: H, c?: string) => icon(h, ["M6 9l6 6 6-6"], c),
  chevronRight: (h: H, c?: string) => icon(h, ["M9 6l6 6-6 6"], c),
  check: (h: H, c?: string) => icon(h, ["M5 12l5 5 9-10"], c),
  question: (h: H, c?: string) =>
    icon(
      h,
      ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3", "M12 17h.01"],
      c,
    ),
  shield: (h: H, c?: string) => icon(h, ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"], c),
  alert: (h: H, c?: string) =>
    icon(h, ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M15 9l-6 6", "M9 9l6 6"], c),
  warn: (h: H, c?: string) =>
    icon(
      h,
      [
        "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
        "M12 9v4",
        "M12 17h.01",
      ],
      c,
    ),
  info: (h: H, c?: string) =>
    icon(h, ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 16v-4", "M12 8h.01"], c),
  copy: (h: H, c?: string) => icon(h, ["M9 9h11v11H9z", "M5 15H4V4h11v1"], c),
  wrench: (h: H, c?: string) =>
    icon(
      h,
      ["M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"],
      c,
    ),
  activity: (h: H, c?: string) => icon(h, ["M22 12h-4l-3 9L9 3l-3 9H2"], c),
  clock: (h: H, c?: string) => icon(h, ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"], c),
  send: (h: H, c?: string) => icon(h, ["M22 2L11 13", "M22 2l-7 20-4-9-9-4 20-7z"], c),
  external: (h: H, c?: string) =>
    icon(
      h,
      ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
      c,
    ),
  search: (h: H, c?: string) =>
    icon(h, ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M21 21l-4.3-4.3"], c),
  circle: (h: H, c?: string) => icon(h, ["M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z"], c),
  gear: (h: H, c?: string) =>
    icon(
      h,
      [
        "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
        "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
      ],
      c,
    ),
  history: (h: H, c?: string) =>
    icon(h, ["M3 12a9 9 0 1 0 2.6-6.4L3 8", "M3 3v5h5", "M12 7v5l3 2"], c),
  keyboard: (h: H, c?: string) =>
    icon(
      h,
      [
        "M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z",
        "M7 10h.01M11 10h.01M15 10h.01M8 14h8",
      ],
      c,
    ),
  inbox: (h: H, c?: string) =>
    icon(h, ["M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z", "M4 13h4l1 2h6l1-2h4"], c),
}

// STATUS

export type Tone = "needs" | "working" | "ready" | "failed" | "neutral"

export const toneText: Record<Tone, string> = {
  needs: "text-needs",
  working: "text-working",
  ready: "text-ready",
  failed: "text-failed",
  neutral: "text-subtle-foreground",
}

export const toneDot: Record<Tone, string> = {
  needs: "bg-needs-strong",
  working: "bg-working",
  ready: "bg-ready",
  failed: "bg-failed-strong",
  neutral: "bg-subtle-foreground",
}

export const itemTone = (item: Item): Tone => {
  if (item.queue === "snoozed" || item.queue === "done") {
    return "neutral"
  }
  if (item.kind === "failed") {
    return "failed"
  }
  // Still running: a fact, not a request (orange) or an ending (green, red). U-084.
  if (item.kind === "stuck") {
    return "working"
  }
  return item.kind === "review" ? "ready" : "needs"
}

/** "2 questions", "1 question"; plain "Question" when the daemon gave no count. */
export const questionLabel = (count: number | undefined): string =>
  count === undefined || count < 1 ? "Question" : count === 1 ? "1 question" : `${count} questions`

export const itemKindLabel = (item: Item): string => {
  if (item.queue === "snoozed") {
    return "Snoozed"
  }
  if (item.state === "answered") {
    return "Answered"
  }
  if (item.kind === "question") {
    return questionLabel(item.questionCount)
  }
  if (item.kind === "permission") {
    return "Permission"
  }
  if (item.kind === "stuck") {
    return "Still running"
  }
  return item.kind === "failed" ? "Stopped with errors" : "Ready to review"
}

const kindIcon = (h: H, item: Item, className?: string): Html => {
  if (item.queue === "snoozed") {
    return Icon.clock(h, className)
  }
  if (item.state === "answered") {
    return Icon.send(h, className)
  }
  if (item.kind === "question") {
    return Icon.question(h, className)
  }
  if (item.kind === "permission") {
    return Icon.shield(h, className)
  }
  if (item.kind === "stuck") {
    return Icon.clock(h, className)
  }
  return item.kind === "failed" ? Icon.alert(h, className) : Icon.check(h, className)
}

/** Icon + word, never colour alone. */
export const itemBadge = (h: H, item: Item): Html =>
  h.span(
    [h.Class(`inline-flex items-center gap-1 text-xs font-semibold ${toneText[itemTone(item)]}`)],
    [kindIcon(h, item, "size-[12px]"), itemKindLabel(item)],
  )

// HISTORY OUTCOMES (C-027): the daemon decides the outcome; these only word it (U-056).

export const OUTCOME_LABEL: Record<HistoryOutcome, string> = {
  allowed: "Allowed",
  "always-allowed": "Always allowed",
  denied: "Denied",
  answered: "Answered",
  replied: "Replied",
  "in-claude": "Handled in Claude",
  "moved-on": "Session moved on",
  expired: "Not answered",
  dismissed: "Dismissed",
}

const OUTCOME_TONE: Record<HistoryOutcome, Tone> = {
  allowed: "ready",
  "always-allowed": "ready",
  denied: "failed",
  answered: "ready",
  replied: "ready",
  "in-claude": "neutral",
  "moved-on": "neutral",
  expired: "needs",
  dismissed: "neutral",
}

const outcomeIcon = (h: H, outcome: HistoryOutcome, className?: string): Html => {
  switch (outcome) {
    case "allowed":
    case "always-allowed":
      return Icon.check(h, className)
    case "denied":
      return Icon.alert(h, className)
    case "answered":
    case "replied":
      return Icon.send(h, className)
    case "in-claude":
      return Icon.external(h, className)
    case "moved-on":
      return Icon.chevronRight(h, className)
    case "expired":
      return Icon.clock(h, className)
    case "dismissed":
      return Icon.circle(h, className)
  }
}

/** Icon + word, never colour alone. */
export const outcomeBadge = (h: H, outcome: HistoryOutcome): Html =>
  h.span(
    [
      h.Class(
        `inline-flex items-center gap-1 text-xs font-semibold ${toneText[OUTCOME_TONE[outcome]]}`,
      ),
    ],
    [outcomeIcon(h, outcome, "size-[12px]"), OUTCOME_LABEL[outcome]],
  )

/** What kind of item it was, without its state: History rows and the kind filter. */
export const KIND_WORD: Record<AttentionKind, string> = {
  question: "Question",
  permission: "Permission",
  review: "Ready to review",
  failed: "Stopped with errors",
  // What it was, once it ended: "Still running" would be wrong in History (U-086).
  stuck: "Ran long",
}

const KIND_ICON: Record<AttentionKind, (h: H, c?: string) => Html> = {
  question: Icon.question,
  permission: Icon.shield,
  review: Icon.check,
  failed: Icon.alert,
  stuck: Icon.clock,
}

/** A finished item's kind, quiet: icon + word. */
export const kindBadge = (h: H, kind: AttentionKind): Html =>
  h.span(
    [h.Class("inline-flex items-center gap-1 text-xs font-semibold text-subtle-foreground")],
    [KIND_ICON[kind](h, "size-[12px]"), KIND_WORD[kind]],
  )

export const sessionStateLabel = (session: Session): string =>
  ({ running: "Working", waiting: "Waiting on you", idle: "Idle", ended: "Ended" })[session.state]

export const sessionTone = (session: Session): Tone =>
  (({ running: "working", waiting: "needs", idle: "neutral", ended: "neutral" }) as const)[
    session.state
  ]

export const runtimeLabel = (session: Session): string =>
  ({
    desktop: "This Mac · desktop app",
    cli: "This Mac · CLI",
    cloud: "Cloud",
    unknown: "This Mac",
  })[session.runtime]

export const dot = (h: H, tone: Tone): Html =>
  h.span([
    h.Class(`inline-block size-2 shrink-0 rounded-full ${toneDot[tone]}`),
    h.AriaHidden(true),
  ])

export const kbd = (h: H, text: string): Html =>
  h.kbd(
    [
      h.Class(
        "ml-1 rounded border border-current/25 px-1 font-sans text-[11px] font-medium opacity-80",
      ),
    ],
    [text],
  )

/** A button's hint for a shortcut setting (U-078): nothing when the action has no key press. */
export const shortcutHint = (h: H, binding: string): Html =>
  binding === "" ? h.empty : kbd(h, displayShortcut(binding))

/** `aria-keyshortcuts` for a shortcut setting, or no attribute when it has none (U-078). */
export const keyshortcuts = (h: H, binding: string) => {
  const value = ariaShortcut(binding)
  return value === "" ? [] : [h.AriaKeyshortcuts(value)]
}
