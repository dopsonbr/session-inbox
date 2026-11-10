import type { Item, Snapshot } from "@session-inbox/contracts"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Message } from "../message.ts"
import type { Model } from "../model.ts"
import { findProject, findSession, formatAge, hashForItem, itemsInQueue } from "../selectors.ts"
import { inlineLineView } from "./markdown.ts"
import { dot, itemKindLabel, itemTone, kbd } from "./parts.ts"
import { compactSetupRowView } from "./setup.ts"
import { compactUpdateRowView } from "./update.ts"

type H = HtmlBuilder<Message>

// COMPACT (menu-bar popover, `?view=compact`). Links navigate the main window's URL;
// the shell decides which window handles it (U-012).

const row = (model: Model, snapshot: Snapshot, item: Item, isFirst: boolean, h: H): Html => {
  const session = findSession(snapshot, item.sessionId)
  const project = Option.flatMap(session, (s) => findProject(snapshot, s.projectId))
  const title = Option.getOrElse(
    Option.flatMap(session, (s) => Option.fromNullishOr(s.title)),
    () => "Untitled session",
  )
  const projectName = Option.getOrElse(
    Option.map(project, (p) => p.name),
    () => "",
  )
  // Review rows say what was done (the summary, inline Markdown, one line); others say what's asked.
  const subtitle: ReadonlyArray<Html | string> =
    item.queue === "review" && item.summary !== null
      ? inlineLineView(h, item.summary)
      : [`${itemKindLabel(item)} · ${projectName}`]
  return h.keyed("li")(
    item.id,
    [],
    [
      h.a(
        [
          h.Href(`/${hashForItem(item.id)}`),
          h.Class(
            `flex items-center gap-2.5 px-3.5 py-2.5 no-underline hover:bg-accent focus-visible:bg-accent ${isFirst ? "bg-needs-tint" : ""}`,
          ),
        ],
        [
          dot(h, itemTone(item)),
          h.span(
            [h.Class("min-w-0 flex-1")],
            [
              h.span(
                [h.Class("block truncate text-[14px] font-semibold text-foreground")],
                [title],
              ),
              h.span([h.Class("block truncate text-xs text-muted-foreground")], subtitle),
            ],
          ),
          h.span(
            [h.Class("text-xs text-muted-foreground")],
            [formatAge(model.now, item.createdAt)],
          ),
        ],
      ),
    ],
  )
}

/** How many "Ready to review" rows the popover lists when nothing needs you. */
export const COMPACT_REVIEW_LIMIT = 5

/** When nothing needs you, the popover shows what's ready to review instead of empty space. */
const reviewList = (model: Model, snapshot: Snapshot, h: H): Html => {
  const items = itemsInQueue(snapshot, model.itemOrder, "review").slice(0, COMPACT_REVIEW_LIMIT)
  if (items.length === 0) {
    return h.empty
  }
  return h.section(
    [h.AriaLabelledBy("compact-review-label"), h.Class("border-t border-border pb-1")],
    [
      h.p(
        [
          h.Id("compact-review-label"),
          h.Class(
            "px-3.5 pt-3 pb-1 text-xs font-semibold tracking-[0.06em] text-subtle-foreground uppercase",
          ),
        ],
        ["Ready to review"],
      ),
      h.ul(
        [h.AriaLabelledBy("compact-review-label"), h.Class("m-0 list-none p-0")],
        items.map((item) => row(model, snapshot, item, false, h)),
      ),
    ],
  )
}

export const compactView = (model: Model, h: H): Html =>
  h.main(
    [h.Class("flex min-h-screen flex-col bg-card text-card-foreground")],
    Option.match(model.maybeSnapshot, {
      onNone: () => [
        h.p(
          [h.Class("p-4 text-[13px] text-muted-foreground")],
          [model.connection._tag === "Offline" ? "Daemon offline — retrying…" : "Loading…"],
        ),
      ],
      onSome: (snapshot) => {
        const items = itemsInQueue(snapshot, model.itemOrder, "needs-you")
        return [
          h.header(
            [h.Class("flex items-center gap-2.5 border-b border-border px-3.5 py-3")],
            [
              h.span([h.Class("text-[14px] font-bold")], [`${snapshot.counts.needsYou} need you`]),
              h.span(
                [h.Class("text-[13px] text-muted-foreground")],
                [`${snapshot.counts.working} working · ${snapshot.counts.review} to review`],
              ),
            ],
          ),
          compactUpdateRowView(model, h),
          compactSetupRowView(model, h),
          items.length === 0
            ? h.div(
                [],
                [
                  h.p(
                    [
                      h.Class(
                        "flex items-center gap-2 px-3.5 py-4 text-[13px] text-muted-foreground",
                      ),
                    ],
                    [dot(h, "ready"), "Nothing needs you right now."],
                  ),
                  reviewList(model, snapshot, h),
                ],
              )
            : h.ul(
                [h.AriaLabel("Needs you"), h.Class("m-0 list-none p-0")],
                items.map((item, index) => row(model, snapshot, item, index === 0, h)),
              ),
          h.div(
            [h.Class("mt-auto flex gap-2 border-t border-border px-3.5 py-2.5")],
            [
              h.a(
                [
                  h.Href("/"),
                  h.Class("btn w-full no-underline"),
                  h.DataAttribute("size", "lg"),
                  h.AriaKeyshortcuts("Meta+Shift+I"),
                ],
                ["Open inbox", kbd(h, "⌘⇧I")],
              ),
            ],
          ),
        ]
      },
    }),
  )
