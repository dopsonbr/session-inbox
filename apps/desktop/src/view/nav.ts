import type { Snapshot } from "@session-inbox/contracts"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message, type TreeKey } from "../message.ts"
import type { Model } from "../model.ts"
import {
  findItem,
  needsYouCountForProject,
  projectHasOnlyFailures,
  sessionNodeId,
  type TreeNode,
  visibleTreeNodes,
} from "../selectors.ts"
import { dot, Icon, kbd, type Tone } from "./parts.ts"

type H = HtmlBuilder<Message>

// HEADER

export const headerView = (model: Model, h: H): Html => {
  const counts = Option.match(model.maybeSnapshot, {
    onNone: () => null,
    onSome: (s) => s.counts,
  })
  const count = (value: number | undefined, label: string, tone: string) =>
    h.span([], [h.strong([h.Class(`font-bold ${tone}`)], [String(value ?? "–")]), ` ${label}`])
  return h.header(
    [
      h.Class(
        "flex min-h-14 flex-wrap items-center gap-4 border-b border-border bg-card px-5 py-2",
      ),
    ],
    [
      h.span([h.Class("text-base font-bold tracking-tight")], ["Session Inbox"]),
      h.div(
        [h.Class("flex gap-3.5 text-[13px] text-muted-foreground"), h.AriaLive("polite")],
        [
          count(counts?.needsYou, "need you", "text-needs"),
          count(counts?.working, "working", "text-working"),
          count(counts?.review, "ready to review", "text-ready"),
        ],
      ),
      h.button(
        [
          h.Type("button"),
          h.Class(
            "ml-auto flex h-9 w-64 max-w-full cursor-pointer items-center gap-2 rounded-[10px] border border-input bg-background px-3 text-left text-[13px] text-subtle-foreground hover:bg-accent",
          ),
          h.AriaKeyshortcuts("Meta+K"),
          h.AriaHasPopup("dialog"),
          h.OnClick(Message.ClickedJumpField()),
        ],
        [Icon.search(h), h.span([h.Class("flex-1")], ["Jump to session"]), kbd(h, "⌘K")],
      ),
    ],
  )
}

// TREE

const TREE_KEYS: ReadonlyArray<string> = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "Home",
  "End",
]

const toTreeKey = (key: string): Option.Option<TreeKey> => {
  if (key === " ") {
    return Option.some("Enter")
  }
  return TREE_KEYS.includes(key) ? Option.some(key as TreeKey) : Option.none()
}

const selectedSessionId = (model: Model, snapshot: Snapshot): Option.Option<string> =>
  Option.orElse(
    Option.flatMap(model.maybeSelectedItemId, (itemId) =>
      Option.map(findItem(snapshot, itemId), (item) => item.sessionId),
    ),
    () => model.maybeSelectedSessionId,
  )

const agentTone = (state: string): Tone =>
  state === "waiting"
    ? "needs"
    : state === "running"
      ? "working"
      : state === "failed"
        ? "failed"
        : "ready"

const agentStateWord: Record<string, string> = {
  waiting: "asking",
  running: "working",
  done: "done",
  failed: "failed",
}

type RowContent = Readonly<{
  leading: Html
  label: string
  trailing: Html | null
  emphasis: boolean
}>

const nodeContent = (h: H, snapshot: Snapshot, node: TreeNode, isExpanded: boolean): RowContent => {
  const id = node.id.slice(2)
  if (node.kind === "project") {
    const project = snapshot.projects.find((p) => p.id === id)
    const needs = needsYouCountForProject(snapshot, id)
    const onlyFailures = projectHasOnlyFailures(snapshot, id)
    const trailing =
      needs === 0
        ? project?.muted === true
          ? h.span([h.Class("text-xs text-subtle-foreground")], ["muted"])
          : null
        : h.span(
            [h.Class(`text-xs font-bold ${onlyFailures ? "text-failed" : "text-needs"}`)],
            [
              onlyFailures ? "failed" : `${needs}`,
              h.span([h.Class("sr-only")], [onlyFailures ? "" : " need you"]),
            ],
          )
    return {
      leading: isExpanded ? Icon.chevronDown(h) : Icon.chevronRight(h),
      label: project?.name ?? id,
      trailing,
      emphasis: needs > 0,
    }
  }
  if (node.kind === "session") {
    const session = snapshot.sessions.find((s) => s.id === id)
    const waiting = snapshot.items.some((i) => i.sessionId === id && i.queue === "needs-you")
    const failed = snapshot.items.some(
      (i) => i.sessionId === id && i.queue === "needs-you" && i.kind === "failed",
    )
    const tone: Tone = failed
      ? "failed"
      : waiting
        ? "needs"
        : session?.state === "running"
          ? "working"
          : "neutral"
    return {
      leading: dot(h, tone),
      label: session?.title ?? "Untitled session",
      trailing:
        session === undefined
          ? null
          : h.span(
              [h.Class("text-[11px] text-subtle-foreground")],
              [session.runtime === "desktop" ? "" : session.runtime],
            ),
      emphasis: waiting,
    }
  }
  const agent = snapshot.agents.find((a) => a.id === id)
  const state = agent?.state ?? "running"
  return {
    leading:
      state === "done"
        ? h.span([h.Class("text-ready")], [Icon.check(h, "size-3")])
        : state === "running"
          ? h.span([h.Class("text-working")], [Icon.circle(h, "size-3")])
          : dot(h, agentTone(state)),
    label: `${agent?.name ?? id} · ${agentStateWord[state] ?? state}`,
    trailing: null,
    emphasis: state === "waiting",
  }
}

const LEVEL: Record<TreeNode["kind"], number> = { project: 1, session: 2, agent: 3 }

const treeRow = (
  h: H,
  snapshot: Snapshot,
  node: TreeNode,
  model: Model,
  focusedId: string,
  currentSessionNode: Option.Option<string>,
): Html => {
  const isExpanded = model.expandedNodes.includes(node.id)
  const isCurrent = Option.contains(currentSessionNode, node.id)
  const content = nodeContent(h, snapshot, node, isExpanded)
  const indent = {
    project: "",
    session: "ml-[15px] border-l-2 border-rail pl-2.5",
    agent: "ml-[15px] border-l-2 border-rail pl-[22px]",
  }[node.kind]
  const rowClass = {
    project: "min-h-9 text-[14px] font-semibold",
    session: "min-h-8 text-[13px]",
    agent: "min-h-7 text-[13px] text-muted-foreground",
  }[node.kind]
  return h.keyed("li")(
    node.id,
    [
      h.Role("treeitem"),
      h.AriaLevel(LEVEL[node.kind]),
      ...(node.hasChildren ? [h.AriaExpanded(isExpanded)] : []),
      h.AriaSelected(isCurrent),
      h.Tabindex(node.id === focusedId ? 0 : -1),
      h.DataAttribute("tree-node", node.id),
      h.Class(
        `block cursor-pointer rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring ${indent}`,
      ),
      h.OnClick(Message.ClickedTreeNode({ nodeId: node.id })),
      h.OnKeyDownPreventDefault((key, modifiers) =>
        modifiers.metaKey || modifiers.ctrlKey || modifiers.altKey
          ? Option.none()
          : Option.map(toTreeKey(key), (treeKey) =>
              Message.PressedTreeKey({ nodeId: node.id, key: treeKey }),
            ),
      ),
    ],
    [
      h.div(
        [
          h.Class(
            `flex items-center gap-2 rounded-lg px-2 ${rowClass} ${
              isCurrent
                ? "border border-border bg-card font-semibold"
                : "border border-transparent hover:bg-accent"
            } ${content.emphasis ? "text-foreground" : ""}`,
          ),
        ],
        [
          content.leading,
          h.span([h.Class("min-w-0 flex-1 truncate")], [content.label]),
          content.trailing ?? h.empty,
        ],
      ),
    ],
  )
}

export const navView = (model: Model, h: H): Html =>
  h.nav(
    [
      h.AriaLabel("Projects and sessions"),
      h.Class(
        "flex min-h-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-sidebar px-3 py-4",
      ),
    ],
    [
      h.p(
        [
          h.Id("projects-heading"),
          h.Class(
            "mx-2 mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-subtle-foreground",
          ),
        ],
        ["Projects"],
      ),
      Option.match(model.maybeSnapshot, {
        onNone: () =>
          h.p([h.Class("mx-2 text-[13px] text-muted-foreground")], [loadingText(model)]),
        onSome: (snapshot) => {
          const nodes = visibleTreeNodes(snapshot, model.expandedNodes)
          const currentSessionNode = Option.map(selectedSessionId(model, snapshot), sessionNodeId)
          const focusedId = Option.getOrElse(
            Option.filter(model.maybeFocusedNode, (id) => nodes.some((n) => n.id === id)),
            () =>
              Option.getOrElse(
                Option.filter(currentSessionNode, (id) => nodes.some((n) => n.id === id)),
                () => nodes[0]?.id ?? "",
              ),
          )
          return nodes.length === 0
            ? h.p(
                [h.Class("mx-2 text-[13px] text-muted-foreground")],
                ["No sessions yet. Start Claude Code in a project."],
              )
            : h.ul(
                [
                  h.Role("tree"),
                  h.AriaLabelledBy("projects-heading"),
                  h.Class("flex flex-col gap-0.5"),
                ],
                nodes.map((node) =>
                  treeRow(h, snapshot, node, model, focusedId, currentSessionNode),
                ),
              )
        },
      }),
      whereSessionsRun(model, h),
    ],
  )

const loadingText = (model: Model): string =>
  model.connection._tag === "Offline" ? "Daemon offline — retrying…" : "Loading sessions…"

const whereSessionsRun = (model: Model, h: H): Html => {
  const [tone, text]: [Tone, string] =
    model.connection._tag === "Live"
      ? ["ready", "This Mac · hooks connected"]
      : model.connection._tag === "Connecting"
        ? ["neutral", "This Mac · connecting…"]
        : ["failed", "This Mac · daemon offline"]
  return h.section(
    [h.AriaLabel("Where sessions run"), h.Class("mt-6")],
    [
      h.p(
        [
          h.Class(
            "mx-2 mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-subtle-foreground",
          ),
        ],
        ["Where sessions run"],
      ),
      h.div(
        [
          h.Class("flex flex-col gap-1 px-2 text-[13px] text-muted-foreground"),
          h.AriaLive("polite"),
        ],
        [
          h.div([h.Class("flex items-center gap-2")], [dot(h, tone), text]),
          model.connection._tag === "Offline"
            ? h.p(
                [h.Class("pl-4 text-xs text-subtle-foreground")],
                ["Claude keeps working as if the inbox weren't installed."],
              )
            : h.empty,
        ],
      ),
    ],
  )
}
