/**
 * The fake daemon's `GET /v1/history` (C-027), for `dev:mock` and tests. Like the fake's queues,
 * this plays the daemon: it picks outcomes, matches words and pages. Nothing else in the UI does.
 */
import {
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
  type HistoryEntry,
  type HistoryMatch,
  type HistoryOutcome,
  type HistoryPage,
  type HistoryQuery,
  type Item,
} from "@session-inbox/contracts"
import type { Fixtures, ItemExtras } from "./fixtures.ts"

const DAY = 24 * 60 * 60_000

/** The outcome the fixture names, else one read off the state, as the daemon would decide. */
export const fakeOutcome = (item: Item, extras: ItemExtras | undefined): HistoryOutcome => {
  if (extras?.outcome !== undefined) return extras.outcome
  if (item.state === "dismissed") return "dismissed"
  if (item.state === "expired") return "expired"
  const decision = extras?.approval?.decision ?? null
  if (decision === "allow") return "allowed"
  if (decision === "allow-always") return "always-allowed"
  if (decision === "deny") return "denied"
  if (item.state === "answered") {
    return item.kind === "question" && (extras?.questions.length ?? 0) > 0 ? "answered" : "replied"
  }
  return item.kind === "question" || item.kind === "permission" ? "in-claude" : "moved-on"
}

type Where = HistoryMatch["where"]

const answerText = (answer: unknown): string => {
  if (answer === null || typeof answer !== "object") return ""
  const a = answer as { selected?: unknown; other?: unknown }
  const selected = Array.isArray(a.selected) ? a.selected.filter((s) => typeof s === "string") : []
  return [...selected, ...(typeof a.other === "string" ? [a.other] : [])].join(", ")
}

const inputField = (input: unknown, key: string): string => {
  if (input === null || typeof input !== "object") return ""
  const value = (input as Record<string, unknown>)[key]
  return typeof value === "string" ? value : ""
}

/** One line around the first hit of `word`, with an ellipsis where it was cut. */
export const excerpt = (text: string, word: string): string => {
  const line = text.replace(/\s+/g, " ").trim()
  const at = line.toLowerCase().indexOf(word)
  const start = Math.max(0, at - 30)
  const end = Math.min(line.length, at + word.length + 50)
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`
}

const cursorOf = (entry: HistoryEntry) => `${entry.endedAt}:${entry.item.id}`

const isOlderThan = (entry: HistoryEntry, cursor: string): boolean => {
  const split = cursor.indexOf(":")
  const endedAt = Number(cursor.slice(0, split))
  const id = cursor.slice(split + 1)
  return entry.endedAt < endedAt || (entry.endedAt === endedAt && entry.item.id < id)
}

export type FakeHistoryOptions = Readonly<{
  now: number
  retentionDays: number
  /** The page size when the query names none (the daemon's is HISTORY_LIMIT_DEFAULT). */
  pageSize?: number
}>

export const fakeHistoryPage = (
  db: Fixtures,
  query: HistoryQuery,
  options: FakeHistoryOptions,
): HistoryPage => {
  const words = (query.q ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean)
  const oldest = options.now - options.retentionDays * DAY
  const all = db.items.flatMap((item): ReadonlyArray<HistoryEntry> => {
    if (item.queue !== "done" || (query.kind != null && item.kind !== query.kind)) return []
    const session = db.sessions.find((s) => s.id === item.sessionId)
    const project = db.projects.find((p) => p.id === session?.projectId)
    if (session === undefined || project === undefined) return []
    const extras = db.extras[item.id]
    const approval = extras?.approval ?? null
    const endedAt = approval?.decidedAt ?? item.updatedAt
    if (endedAt < oldest) return []
    // What the row shows, then what it doesn't (with where it is), then branch names.
    const shown = [item.summary ?? "", session.title ?? "", project.name]
    const hidden: ReadonlyArray<[Where, string]> = [
      ...(extras?.questions ?? []).flatMap(
        (q): ReadonlyArray<[Where, string]> => [
          ["question", [q.header ?? "", q.text, ...q.options.map((o) => o.label)].join(" ")],
          ["answer", answerText(q.answer)],
        ],
      ),
      ...(approval === null
        ? []
        : ([
            ["tool", [approval.tool, inputField(approval.input, "command")].join(" ")],
            ["tool", inputField(approval.input, "url")],
            ["path", inputField(approval.input, "file_path")],
          ] as ReadonlyArray<[Where, string]>)),
      ["reason", extras?.denyReason ?? ""],
      ...(extras?.outbox ?? []).map((o): [Where, string] => ["reply", o.body]),
      ["path", session.cwd ?? ""],
    ]
    const other = [session.branch ?? "", session.worktree ?? ""]
    const has = (text: string, word: string) => text.toLowerCase().includes(word)
    let match: HistoryMatch | undefined
    for (const word of words) {
      if (shown.some((text) => has(text, word))) continue
      const hit = hidden.find(([, text]) => has(text, word))
      if (hit !== undefined) {
        match ??= { where: hit[0], text: excerpt(hit[1], word) }
      } else if (!other.some((text) => has(text, word))) {
        return []
      }
    }
    return [
      {
        item,
        session,
        project,
        outcome: fakeOutcome(item, extras),
        endedAt,
        ...(match === undefined ? {} : { match }),
      },
    ]
  })
  const sorted = all
    .filter((entry) => query.before == null || isOlderThan(entry, query.before))
    .sort((a, b) => b.endedAt - a.endedAt || (a.item.id < b.item.id ? 1 : -1))
  const limit = Math.max(
    1,
    Math.min(HISTORY_LIMIT_MAX, query.limit ?? options.pageSize ?? HISTORY_LIMIT_DEFAULT),
  )
  const entries = sorted.slice(0, limit)
  const last = entries[entries.length - 1]
  return {
    entries,
    nextBefore: sorted.length > limit && last !== undefined ? cursorOf(last) : null,
    retentionDays: options.retentionDays,
  }
}
