import type { Item, Session } from "@session-inbox/contracts"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Message } from "../message.ts"

type H = HtmlBuilder<Message>

// ICONS (lucide-style strokes; always aria-hidden — the word next to them carries meaning)

const icon = (h: H, paths: ReadonlyArray<string>, className = "size-3.5"): Html =>
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
  return item.kind === "review" ? "ready" : "needs"
}

export const itemKindLabel = (item: Item): string => {
  if (item.queue === "snoozed") {
    return "Snoozed"
  }
  if (item.state === "answered") {
    return "Answered"
  }
  if (item.kind === "question") {
    return "Question"
  }
  if (item.kind === "permission") {
    return "Permission"
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
  return item.kind === "failed" ? Icon.alert(h, className) : Icon.check(h, className)
}

/** Icon + word, never colour alone. */
export const itemBadge = (h: H, item: Item): Html =>
  h.span(
    [h.Class(`inline-flex items-center gap-1 text-xs font-semibold ${toneText[itemTone(item)]}`)],
    [kindIcon(h, item, "size-3.5"), itemKindLabel(item)],
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
