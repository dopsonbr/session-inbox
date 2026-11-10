/**
 * Pure helpers over daemon state. These only filter, look up and format; they
 * never decide queue, state or priority (that is the daemon's job, G-002).
 */
import { RadioGroup } from "@foldkit/ui"
import type {
  Agent,
  Item,
  ItemDetail,
  Project,
  Question,
  Session,
  Snapshot,
  StreamMessage,
} from "@session-inbox/contracts"
import { Array as Arr, Option, Schema } from "effect"
import { type AnswerDraft, DraftBody, type Form, type QueueTab } from "./model.ts"

type Delta = Extract<StreamMessage, { _tag: "delta" }>

const upsert = <A extends { readonly id: string }>(
  rows: ReadonlyArray<A>,
  changed: ReadonlyArray<A>,
): ReadonlyArray<A> => {
  const byId = new Map(changed.map((row) => [row.id, row]))
  const updated = rows.map((row) => byId.get(row.id) ?? row)
  const known = new Set(rows.map((row) => row.id))
  return [...updated, ...changed.filter((row) => !known.has(row.id))]
}

/** Deltas carry full upserted rows (C-005): replace by id, append new, take counts verbatim. */
export const mergeDelta = (snapshot: Snapshot, delta: Delta): Snapshot => ({
  seq: Math.max(snapshot.seq, delta.seq),
  projects: upsert(snapshot.projects, delta.projects),
  sessions: upsert(snapshot.sessions, delta.sessions),
  agents: upsert(snapshot.agents, delta.agents),
  items: upsert(snapshot.items, delta.items),
  counts: delta.counts,
})

/** Keep existing positions; append ids we haven't seen, so the list never jumps (U-010). */
export const extendOrder = (
  order: ReadonlyArray<string>,
  items: ReadonlyArray<Item>,
): ReadonlyArray<string> => {
  const known = new Set(order)
  return [...order, ...items.map((i) => i.id).filter((id) => !known.has(id))]
}

export const findItem = (snapshot: Snapshot, itemId: string): Option.Option<Item> =>
  Arr.findFirst(snapshot.items, (i) => i.id === itemId)

export const findSession = (snapshot: Snapshot, sessionId: string): Option.Option<Session> =>
  Arr.findFirst(snapshot.sessions, (s) => s.id === sessionId)

export const findProject = (snapshot: Snapshot, projectId: string): Option.Option<Project> =>
  Arr.findFirst(snapshot.projects, (p) => p.id === projectId)

export const findAgent = (snapshot: Snapshot, agentId: string | null): Option.Option<Agent> =>
  agentId === null ? Option.none() : Arr.findFirst(snapshot.agents, (a) => a.id === agentId)

export const orderedItems = (
  snapshot: Snapshot,
  order: ReadonlyArray<string>,
): ReadonlyArray<Item> => {
  const byId = new Map(snapshot.items.map((i) => [i.id, i]))
  return order.flatMap((id) => {
    const item = byId.get(id)
    return item === undefined ? [] : [item]
  })
}

/** Items in a daemon-assigned queue, in stable display order. */
export const itemsInQueue = (
  snapshot: Snapshot,
  order: ReadonlyArray<string>,
  queue: Exclude<QueueTab, "working">,
): ReadonlyArray<Item> => orderedItems(snapshot, order).filter((i) => i.queue === queue)

/** "Working" lists sessions the daemon reports as running. */
export const workingSessions = (snapshot: Snapshot): ReadonlyArray<Session> =>
  snapshot.sessions.filter((s) => s.state === "running")

/** First open item of a session, preferring Needs you, in display order. */
export const firstOpenItemForSession = (
  snapshot: Snapshot,
  order: ReadonlyArray<string>,
  sessionId: string,
): Option.Option<Item> => {
  const open = orderedItems(snapshot, order).filter(
    (i) => i.sessionId === sessionId && i.queue !== "done",
  )
  return Option.orElse(
    Arr.findFirst(open, (i) => i.queue === "needs-you"),
    () => Arr.head(open),
  )
}

// TREE

export type TreeNode = Readonly<{
  id: string
  kind: "project" | "session" | "agent"
  parentId: string | null
  hasChildren: boolean
}>

export const projectNodeId = (projectId: string) => `p:${projectId}`
export const sessionNodeId = (sessionId: string) => `s:${sessionId}`
export const agentNodeId = (agentId: string) => `a:${agentId}`

/** Subagents only; the main agent is the session row itself. */
export const subagentsOf = (snapshot: Snapshot, sessionId: string): ReadonlyArray<Agent> =>
  snapshot.agents.filter((a) => a.sessionId === sessionId && a.parentAgentId !== null)

export const sessionsOf = (snapshot: Snapshot, projectId: string): ReadonlyArray<Session> =>
  snapshot.sessions.filter((s) => s.projectId === projectId && s.state !== "ended")

/** Visible nodes in document order, for roving-tabindex keyboard navigation. */
export const visibleTreeNodes = (
  snapshot: Snapshot,
  expanded: ReadonlyArray<string>,
): ReadonlyArray<TreeNode> =>
  snapshot.projects.flatMap((project) => {
    const pid = projectNodeId(project.id)
    const sessions = sessionsOf(snapshot, project.id)
    const projectNode: TreeNode = {
      id: pid,
      kind: "project",
      parentId: null,
      hasChildren: sessions.length > 0,
    }
    if (!expanded.includes(pid)) {
      return [projectNode]
    }
    return [
      projectNode,
      ...sessions.flatMap((session) => {
        const sid = sessionNodeId(session.id)
        const agents = subagentsOf(snapshot, session.id)
        const sessionNode: TreeNode = {
          id: sid,
          kind: "session",
          parentId: pid,
          hasChildren: agents.length > 0,
        }
        return expanded.includes(sid)
          ? [
              sessionNode,
              ...agents.map(
                (agent): TreeNode => ({
                  id: agentNodeId(agent.id),
                  kind: "agent",
                  parentId: sid,
                  hasChildren: false,
                }),
              ),
            ]
          : [sessionNode]
      }),
    ]
  })

export const needsYouCountForProject = (snapshot: Snapshot, projectId: string): number => {
  const sessionIds = new Set(sessionsOf(snapshot, projectId).map((s) => s.id))
  return snapshot.items.filter((i) => i.queue === "needs-you" && sessionIds.has(i.sessionId)).length
}

export const projectHasOnlyFailures = (snapshot: Snapshot, projectId: string): boolean => {
  const sessionIds = new Set(sessionsOf(snapshot, projectId).map((s) => s.id))
  const mine = snapshot.items.filter((i) => i.queue === "needs-you" && sessionIds.has(i.sessionId))
  return mine.length > 0 && mine.every((i) => i.kind === "failed")
}

// ROUTING

const SETUP_ITEM_ID = "setup"

/**
 * `#/setup` and `#/item/setup` (what a click on the test notification opens) are the Setup
 * panel; `#/update` is the tray's "Check for Updates…"; `#/settings` opens the Settings
 * dialog (the tray's "Settings…", U-041); `#/item/<id>` selects (U-034).
 */
export type HashRoute =
  | Readonly<{ _tag: "item"; itemId: string }>
  | Readonly<{ _tag: "setup" }>
  | Readonly<{ _tag: "update" }>
  | Readonly<{ _tag: "settings" }>
  | Readonly<{ _tag: "inbox" }>

export const routeFromHash = (hash: string): HashRoute => {
  if (/^#\/setup\/?$/.test(hash)) {
    return { _tag: "setup" }
  }
  if (/^#\/update\/?$/.test(hash)) {
    return { _tag: "update" }
  }
  if (/^#\/settings\/?$/.test(hash)) {
    return { _tag: "settings" }
  }
  const match = /^#\/item\/([^/?#]+)/.exec(hash)
  if (match?.[1] === undefined) {
    return { _tag: "inbox" }
  }
  let itemId = match[1]
  try {
    itemId = decodeURIComponent(match[1])
  } catch {
    // A malformed escape: use it as written.
  }
  return itemId === SETUP_ITEM_ID ? { _tag: "setup" } : { _tag: "item", itemId }
}

export const itemIdFromHash = (hash: string): Option.Option<string> => {
  const route = routeFromHash(hash)
  return route._tag === "item" ? Option.some(route.itemId) : Option.none()
}

export const hashForItem = (itemId: string) => `#/item/${encodeURIComponent(itemId)}`
export const SETUP_HASH = "#/setup"

/** A subagent the hook couldn't name still needs a label in the tree and breadcrumbs. */
export const agentDisplayName = (agent: Agent): string =>
  agent.name.trim() === "" ? "agent" : agent.name

// FORM

const emptyAnswer = (idx: number): AnswerDraft => ({ idx, selected: [], other: "" })

const decodeDraft = Schema.decodeUnknownOption(DraftBody)

const answerFromQuestion = (question: Question): AnswerDraft => {
  const answer = question.answer
  if (answer !== null && typeof answer === "object" && "selected" in answer) {
    const a = answer as { selected?: unknown; other?: unknown }
    return {
      idx: question.idx,
      selected: Array.isArray(a.selected) ? a.selected.filter((s) => typeof s === "string") : [],
      other: typeof a.other === "string" ? a.other : "",
    }
  }
  return emptyAnswer(question.idx)
}

/** Initial form for an item: the daemon-held draft wins, then recorded answers, then empty. */
export const formFromDetail = (detail: ItemDetail): Form => {
  const draft = decodeDraft(detail.draft)
  const answers = Option.match(draft, {
    onNone: () => detail.questions.map(answerFromQuestion),
    onSome: (d) =>
      detail.questions.map((q) => d.answers.find((a) => a.idx === q.idx) ?? answerFromQuestion(q)),
  })
  return {
    itemId: detail.item.id,
    answers,
    reply: Option.match(draft, { onNone: () => "", onSome: (d) => d.reply }),
    radioGroups: detail.questions.map((q) =>
      RadioGroup.init({ id: `question-${detail.item.id}-${q.idx}` }),
    ),
  }
}

/**
 * A question the inbox can't answer: not live, still open, and the daemon says why answers
 * can't go from here (Claude's own prompt, or no CLI for the reply). It renders the reason and
 * Open in Claude instead of a form (U-047).
 */
export const answersUnavailable = (detail: ItemDetail): string | null =>
  detail.item.kind === "question" &&
  !detail.item.live &&
  detail.item.queue !== "done" &&
  detail.replyUnavailable !== undefined
    ? detail.replyUnavailable
    : null

export const isAnswerComplete = (answer: AnswerDraft): boolean =>
  answer.selected.length > 0 || answer.other.trim() !== ""

export const areAnswersComplete = (form: Form): boolean =>
  form.answers.length > 0 && form.answers.every(isAnswerComplete)

export const draftBody = (form: Form): DraftBody => ({ answers: form.answers, reply: form.reply })

// TIME

const MIN = 60_000

/** Terse age for tight spots ("waiting 2m", popover rows): "<1m", "2m", "3h", "4d". */
export const formatAge = (now: number, at: number): string => {
  const minutes = Math.max(0, Math.floor((now - at) / MIN))
  if (minutes < 1) {
    return "<1m"
  }
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** Relative time as a phrase: "just now", "2 min ago", "3 h ago", "4 d ago" (U-039). */
export const formatAgo = (now: number, at: number): string => {
  const minutes = Math.max(0, Math.floor((now - at) / MIN))
  if (minutes < 1) {
    return "just now"
  }
  if (minutes < 60) {
    return `${minutes} min ago`
  }
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`
}

export const formatClock = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** Snooze presets → absolute time. "Tomorrow" is 09:00 local the next day. */
export const snoozeUntil = (preset: "15m" | "1h" | "tomorrow", now: number): number => {
  if (preset === "15m") {
    return now + 15 * MIN
  }
  if (preset === "1h") {
    return now + 60 * MIN
  }
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d.getTime()
}
