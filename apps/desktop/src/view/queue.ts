import type { Item, Session, Snapshot } from "@session-inbox/contracts"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "../message.ts"
import type { Model, QueueTab } from "../model.ts"
import {
  findAgent,
  findProject,
  findSession,
  formatAge,
  formatClock,
  itemsInQueue,
  workingSessions,
} from "../selectors.ts"
import { dot, Icon, itemBadge } from "./parts.ts"

type H = HtmlBuilder<Message>

const TABS: ReadonlyArray<{ tab: QueueTab; label: string; count: (s: Snapshot) => number }> = [
  { tab: "needs-you", label: "Needs you", count: (s) => s.counts.needsYou },
  { tab: "working", label: "Working", count: (s) => s.counts.working },
  { tab: "review", label: "Ready to review", count: (s) => s.counts.review },
  { tab: "snoozed", label: "Snoozed", count: (s) => s.counts.snoozed },
]

const tabsView = (model: Model, snapshot: Snapshot, h: H): Html =>
  h.div(
    [h.Role("tablist"), h.AriaLabel("Queues"), h.Class("mb-1 flex flex-wrap gap-1.5")],
    TABS.map(({ tab, label, count }) => {
      const isSelected = model.queueTab === tab
      return h.button(
        [
          h.Type("button"),
          h.Role("tab"),
          h.Id(`tab-${tab}`),
          h.AriaSelected(isSelected),
          h.AriaControls("queue-panel"),
          h.Class(
            `h-8 cursor-pointer rounded-full px-3 text-[13px] ${
              isSelected
                ? "bg-primary font-semibold text-primary-foreground"
                : "border border-input bg-card font-medium text-muted-foreground hover:bg-accent"
            }`,
          ),
          h.OnClick(Message.SelectedQueueTab({ tab })),
        ],
        [`${label} `, h.span([h.Class("tabular-nums")], [String(count(snapshot))])],
      )
    }),
  )

const breadcrumb = (snapshot: Snapshot, item: Item): string => {
  const session = findSession(snapshot, item.sessionId)
  const project = Option.flatMap(session, (s) => findProject(snapshot, s.projectId))
  const agent = Option.filter(findAgent(snapshot, item.agentId), (a) => a.parentAgentId !== null)
  return [
    Option.getOrElse(
      Option.map(project, (p) => p.name),
      () => "",
    ),
    Option.getOrElse(
      Option.map(agent, (a) => a.name),
      () => "",
    ),
  ]
    .filter((part) => part !== "")
    .join(" › ")
}

const itemCard = (model: Model, snapshot: Snapshot, item: Item, h: H): Html => {
  const isSelected = Option.contains(model.maybeSelectedItemId, item.id)
  const isNeedsYou = item.queue === "needs-you"
  const session = findSession(snapshot, item.sessionId)
  const title = Option.getOrElse(
    Option.flatMap(session, (s) => Option.fromNullishOr(s.title)),
    () => "Untitled session",
  )
  const age =
    item.queue === "snoozed" && item.snoozeUntil !== null
      ? `until ${formatClock(item.snoozeUntil)}`
      : isNeedsYou && item.kind !== "failed"
        ? `waiting ${formatAge(model.now, item.createdAt)}`
        : formatAge(model.now, item.createdAt)
  // Only Needs you gets the heavy border (design rule); other selections get a neutral ring.
  const border = isNeedsYou
    ? isSelected
      ? "border-2 border-needs-strong"
      : "border border-border"
    : isSelected
      ? "border border-foreground/40 ring-1 ring-foreground/20"
      : "border border-border"
  return h.keyed("li")(
    item.id,
    [],
    [
      h.button(
        [
          h.Type("button"),
          h.AriaCurrent(isSelected ? "true" : "false"),
          h.Class(
            `flex w-full cursor-pointer flex-col gap-1.5 rounded-[14px] bg-card px-3.5 py-3 text-left hover:bg-accent/60 ${border}`,
          ),
          h.OnClick(Message.ClickedItem({ itemId: item.id })),
        ],
        [
          h.div(
            [h.Class("flex items-center gap-2 text-xs")],
            [
              itemBadge(h, item),
              h.span([h.Class("truncate text-subtle-foreground")], [breadcrumb(snapshot, item)]),
              item.unread ? h.span([h.Class("sr-only")], ["unread"]) : h.empty,
              h.span([h.Class("ml-auto shrink-0 text-subtle-foreground")], [age]),
            ],
          ),
          h.div(
            [
              h.Class(
                `flex items-center gap-2 text-[15px] text-foreground ${item.unread ? "font-semibold" : "font-medium"}`,
              ),
            ],
            [
              item.unread
                ? h.span([h.Class("size-1.5 shrink-0 rounded-full bg-working"), h.AriaHidden(true)])
                : h.empty,
              h.span([h.Class("truncate")], [title]),
            ],
          ),
          item.summary === null
            ? h.empty
            : h.div([h.Class("text-[13px] text-muted-foreground")], [item.summary]),
        ],
      ),
    ],
  )
}

const sessionCard = (model: Model, snapshot: Snapshot, session: Session, h: H): Html => {
  const project = findProject(snapshot, session.projectId)
  const isSelected = Option.contains(model.maybeSelectedSessionId, session.id)
  const working = snapshot.agents.filter((a) => a.sessionId === session.id && a.state === "running")
  return h.keyed("li")(
    session.id,
    [],
    [
      h.button(
        [
          h.Type("button"),
          h.AriaCurrent(isSelected ? "true" : "false"),
          h.Class(
            `flex w-full cursor-pointer flex-col gap-1.5 rounded-[14px] border bg-card px-3.5 py-3 text-left hover:bg-accent/60 ${
              isSelected ? "border-foreground/40 ring-1 ring-foreground/20" : "border-border"
            }`,
          ),
          h.OnClick(Message.ClickedSession({ sessionId: session.id })),
        ],
        [
          h.div(
            [h.Class("flex items-center gap-2 text-xs")],
            [
              h.span(
                [h.Class("inline-flex items-center gap-1 font-semibold text-working")],
                [Icon.activity(h), "Working"],
              ),
              h.span(
                [h.Class("text-subtle-foreground")],
                [
                  Option.getOrElse(
                    Option.map(project, (p) => p.name),
                    () => "",
                  ),
                ],
              ),
              h.span(
                [h.Class("ml-auto text-subtle-foreground")],
                [`active ${formatAge(model.now, session.lastEventAt)}`],
              ),
            ],
          ),
          h.div(
            [h.Class("text-[15px] font-medium text-foreground")],
            [session.title ?? "Untitled session"],
          ),
          h.div(
            [h.Class("text-[13px] text-muted-foreground")],
            [working.length <= 1 ? "Main agent working" : `${working.length} agents working`],
          ),
        ],
      ),
    ],
  )
}

const emptyText: Record<QueueTab, string> = {
  "needs-you": "Nothing needs you right now.",
  working: "No sessions are working.",
  review: "Nothing waiting for review.",
  snoozed: "Nothing snoozed.",
}

export const queueView = (model: Model, h: H): Html =>
  h.section(
    [
      h.AriaLabel("Queue"),
      h.Class("flex min-h-0 flex-col gap-2 overflow-y-auto border-r border-border p-4"),
    ],
    Option.match(model.maybeSnapshot, {
      onNone: () => [
        h.p([h.Class("text-[13px] text-muted-foreground")], ["Waiting for the daemon…"]),
      ],
      onSome: (snapshot) => {
        const cards =
          model.queueTab === "working"
            ? workingSessions(snapshot).map((s) => sessionCard(model, snapshot, s, h))
            : itemsInQueue(snapshot, model.itemOrder, model.queueTab).map((i) =>
                itemCard(model, snapshot, i, h),
              )
        return [
          tabsView(model, snapshot, h),
          h.div(
            [h.Id("queue-panel"), h.Role("tabpanel"), h.AriaLabelledBy(`tab-${model.queueTab}`)],
            [
              cards.length === 0
                ? h.p(
                    [h.Class("flex items-center gap-2 py-6 text-[13px] text-muted-foreground")],
                    [dot(h, "ready"), emptyText[model.queueTab]],
                  )
                : h.ul([h.Class("flex flex-col gap-2")], cards),
            ],
          ),
          h.p(
            [h.Class("mx-1 mt-3.5 text-xs text-subtle-foreground")],
            [
              "Routine progress never shows up here. Only questions, permission requests, stops and failures do.",
            ],
          ),
        ]
      },
    }),
  )
