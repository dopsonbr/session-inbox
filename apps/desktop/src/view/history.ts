/**
 * History (`#/history`, U-052): finished items, newest first, grouped by day, searchable. The
 * daemon picks the entries, their outcome and where a word matched (C-027); this renders them.
 */
import type { AttentionKind, HistoryEntry, HistoryMatch } from "@session-inbox/contracts"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "../message.ts"
import type { Model } from "../model.ts"
import { dayKey, dayLabel, formatAgo, formatClock, itemLine, itemRowId } from "../selectors.ts"
import { SettingsMessage } from "../settings.ts"
import { inlineLineView } from "./markdown.ts"
import { Icon, KIND_WORD, outcomeBadge } from "./parts.ts"
import { navEntryClass } from "./setup.ts"

type H = HtmlBuilder<Message>

export const HISTORY_SEARCH_ID = "history-search"

export const KIND_FILTERS: ReadonlyArray<{ kind: AttentionKind | null; label: string }> = [
  { kind: null, label: "All" },
  { kind: "question", label: "Questions" },
  { kind: "permission", label: "Permissions" },
  { kind: "review", label: "Reviews" },
  { kind: "failed", label: "Errors" },
  // No pill for stuck calls: a sixth one doesn't fit the column at 1280 wide (U-086).
]

export const MATCH_WORD: Record<HistoryMatch["where"], string> = {
  question: "question",
  answer: "answer",
  tool: "tool call",
  reply: "reply",
  reason: "reason",
  branch: "branch",
  path: "path",
}

export const matchLine = (match: HistoryMatch): string =>
  `Matched in ${MATCH_WORD[match.where]}: ${match.text}`

export const retentionLine = (days: number): string =>
  `History is kept for ${days === 1 ? "1 day" : `${days} days`}.`

/** Consecutive entries of one local day; entries arrive newest first. */
export const groupByDay = (
  now: number,
  entries: ReadonlyArray<HistoryEntry>,
): ReadonlyArray<{ key: string; label: string; entries: ReadonlyArray<HistoryEntry> }> =>
  entries.reduce<Array<{ key: string; label: string; entries: Array<HistoryEntry> }>>(
    (groups, entry) => {
      const key = dayKey(entry.endedAt)
      const last = groups[groups.length - 1]
      if (last !== undefined && last.key === key) {
        last.entries.push(entry)
      } else {
        groups.push({ key, label: dayLabel(now, entry.endedAt), entries: [entry] })
      }
      return groups
    },
    [],
  )

const searchForm = (model: Model, h: H): Html =>
  h.form(
    [h.Role("search"), h.Class("relative"), h.OnSubmit(Message.SubmittedHistorySearch())],
    [
      h.label([h.For(HISTORY_SEARCH_ID), h.Class("sr-only")], ["Search history"]),
      h.span(
        [
          h.Class(
            "pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle-foreground",
          ),
        ],
        [Icon.search(h)],
      ),
      h.input([
        h.Id(HISTORY_SEARCH_ID),
        h.Type("search"),
        h.Class("input h-9 w-full pl-8 text-[14px]"),
        h.Placeholder("Search history"),
        h.Autocomplete("off"),
        h.Spellcheck(false),
        h.Value(model.history.query),
        h.OnInput((value) => Message.UpdatedHistoryQuery({ value })),
      ]),
    ],
  )

const kindFilter = (model: Model, h: H): Html =>
  h.div(
    [h.Role("group"), h.AriaLabel("Kind"), h.Class("flex flex-nowrap gap-1 overflow-x-auto")],
    KIND_FILTERS.map(({ kind, label }) => {
      const isSelected = model.history.kind === kind
      return h.button(
        [
          h.Type("button"),
          h.AriaPressed(isSelected ? "true" : "false"),
          h.Class(
            `h-7 shrink-0 cursor-pointer rounded-full px-2 text-xs whitespace-nowrap ${
              isSelected
                ? "bg-primary font-semibold text-primary-foreground"
                : "border border-input bg-card font-medium text-muted-foreground hover:bg-accent"
            }`,
          ),
          h.OnClick(Message.SelectedHistoryKind({ kind })),
        ],
        [label],
      )
    }),
  )

const entryRow = (model: Model, entry: HistoryEntry, h: H): Html => {
  const isSelected = Option.contains(model.maybeSelectedItemId, entry.item.id)
  const { item, session, project, match } = entry
  const line = itemLine(item, model.now)
  return h.keyed("li")(
    item.id,
    [],
    [
      h.button(
        [
          h.Type("button"),
          h.AriaCurrent(isSelected ? "true" : "false"),
          h.DataAttribute("row", itemRowId(item.id)),
          h.Class(
            `flex w-full cursor-pointer flex-col gap-1 rounded-[14px] border bg-card px-3.5 py-2.5 text-left hover:bg-accent/60 ${
              isSelected ? "border-foreground/40 ring-1 ring-foreground/20" : "border-border"
            }`,
          ),
          h.OnClick(Message.ClickedHistoryEntry({ itemId: item.id })),
        ],
        [
          h.div(
            [h.Class("flex items-center gap-2 text-xs")],
            [
              outcomeBadge(h, entry.outcome),
              h.span([h.Class("truncate text-subtle-foreground")], [KIND_WORD[item.kind]]),
              h.span(
                [
                  h.Class("ml-auto shrink-0 text-subtle-foreground tabular-nums"),
                  h.Title(formatAgo(model.now, entry.endedAt)),
                ],
                [formatClock(entry.endedAt)],
              ),
            ],
          ),
          h.div(
            // Two lines before it truncates (U-075).
            [h.Class("line-clamp-2 text-[15px] font-medium break-words text-foreground")],
            line === null ? [KIND_WORD[item.kind]] : inlineLineView(h, line),
          ),
          h.div(
            [h.Class("truncate text-[13px] text-muted-foreground")],
            [`${session.title ?? "Untitled session"} · ${project.name}`],
          ),
          match === undefined
            ? h.empty
            : h.div([h.Class("truncate text-xs text-subtle-foreground")], [matchLine(match)]),
        ],
      ),
    ],
  )
}

const muted = (h: H, text: string): Html =>
  h.p([h.Class("py-6 text-[13px] text-muted-foreground")], [text])

const emptyText = (model: Model): string => {
  const q = model.history.query.trim()
  if (q !== "") return `No matches for "${q}".`
  return model.history.kind === null
    ? "Nothing has finished yet. Answered questions, decisions and reviews show up here."
    : "Nothing of this kind has finished yet."
}

const footer = (days: number, h: H): Html =>
  h.p(
    [h.Class("mx-1 mt-1.5 text-xs text-subtle-foreground")],
    [
      `${retentionLine(days)} Change it in `,
      h.button(
        [
          h.Type("button"),
          h.Class("cursor-pointer underline underline-offset-2 hover:text-foreground"),
          h.AriaHasPopup("dialog"),
          h.OnClick(Message.GotSettingsMessage({ message: SettingsMessage.RequestedOpen() })),
        ],
        ["Settings"],
      ),
      " under ",
      h.span([h.Class("font-semibold")], ["Keep history for"]),
      ".",
    ],
  )

const results = (model: Model, h: H): ReadonlyArray<Html> => {
  const { results: state, pending } = model.history
  switch (state._tag) {
    case "Idle":
      return [muted(h, "Loading history…")]
    case "Failed":
      return state.status === 404
        ? [muted(h, "This daemon has no history. Update Session Inbox to get it.")]
        : [
            h.p(
              [h.Class("text-[13px] text-failed"), h.Role("alert")],
              [`Couldn't load history: ${state.error}`],
            ),
            h.button(
              [
                h.Type("button"),
                h.Class("btn self-start"),
                h.DataAttribute("variant", "outline"),
                h.DataAttribute("size", "sm"),
                h.Disabled(pending !== "none"),
                h.OnClick(Message.ClickedRetryHistory()),
              ],
              [pending === "none" ? "Try again" : "Loading…"],
            ),
          ]
    case "Loaded": {
      const groups = groupByDay(model.now, state.entries)
      return [
        state.error === null
          ? h.empty
          : h.p(
              [h.Class("text-[13px] text-failed"), h.Role("alert")],
              [`The last refresh failed: ${state.error}`],
            ),
        state.entries.length === 0
          ? pending === "first"
            ? h.empty
            : muted(h, emptyText(model))
          : h.div(
              [h.Class("flex flex-col gap-3")],
              groups.map((group) =>
                h.keyed("section")(
                  group.key,
                  [h.AriaLabel(group.label), h.Class("flex flex-col gap-2")],
                  [
                    h.h2(
                      [
                        h.Class(
                          "mx-1 text-xs font-semibold uppercase tracking-[0.06em] text-subtle-foreground",
                        ),
                      ],
                      [group.label],
                    ),
                    h.ul(
                      [h.Class("m-0 flex list-none flex-col gap-2 p-0")],
                      group.entries.map((entry) => entryRow(model, entry, h)),
                    ),
                  ],
                ),
              ),
            ),
        state.nextBefore === null
          ? h.empty
          : h.button(
              [
                h.Type("button"),
                h.Class("btn self-center"),
                h.DataAttribute("variant", "outline"),
                h.DataAttribute("size", "sm"),
                h.Disabled(pending !== "none"),
                h.OnClick(Message.ClickedLoadMoreHistory()),
              ],
              [pending === "more" ? "Loading…" : "Load more"],
            ),
        footer(state.retentionDays, h),
      ]
    }
  }
}

/** "Searching…" while a new first page is on its way and something is already shown. */
const statusLine = (model: Model, h: H): Html =>
  h.p(
    [h.Class("min-h-4 text-xs text-subtle-foreground"), h.AriaLive("polite")],
    [
      model.history.pending === "first" && model.history.results._tag !== "Idle"
        ? "Searching…"
        : "",
    ],
  )

export const historyView = (model: Model, h: H): Html =>
  h.section(
    [
      h.AriaLabelledBy("history-title"),
      h.AriaBusy(model.history.pending !== "none"),
      h.Class("history flex min-h-0 flex-col gap-2 overflow-y-auto border-r border-border p-4"),
    ],
    [
      // The title, search and kind filter stay at the top while the list scrolls (U-075).
      h.div(
        [
          h.Class(
            "sticky -top-4 z-10 -mx-4 -mt-4 flex flex-col gap-2 border-b border-border bg-background px-4 pt-4 pb-1",
          ),
        ],
        [
          h.h1(
            [h.Id("history-title"), h.Class("mx-1 text-base font-bold tracking-tight")],
            ["History"],
          ),
          searchForm(model, h),
          kindFilter(model, h),
          statusLine(model, h),
        ],
      ),
      ...results(model, h),
    ],
  )

/** The left-nav link to History, under the projects. */
export const historyNavEntry = (model: Model, h: H): Html => {
  const isCurrent = model.route === "history"
  return h.a(
    [
      h.Href("#/history"),
      ...(isCurrent ? [h.AriaCurrent("page")] : []),
      h.Class(navEntryClass(isCurrent)),
    ],
    [Icon.history(h), h.span([h.Class("flex-1")], ["History"])],
  )
}
