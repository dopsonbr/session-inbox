/**
 * History (C-027, D-096): finished items, how each ended, and a plain substring search over
 * what the inbox showed and what was answered. Read-only, and no index: finished items are
 * pruned after `storage.retentionDays` (D-063), so the tables stay small.
 */
import {
  type AttentionKind,
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
  type HistoryEntry,
  type HistoryMatch,
  type HistoryOutcome,
  type HistoryPage,
  type HistoryQuery,
} from "@session-inbox/contracts"
import {
  type ApprovalRow,
  type ItemRow,
  type OutboxRow,
  type ProjectRow,
  type QuestionRow,
  type SessionRow,
  type Store,
  toProject,
  toSession,
} from "./store.ts"

const KINDS: ReadonlyArray<AttentionKind> = ["question", "permission", "failed", "review"]
const MAX_WORDS = 8
const MAX_WORD_LENGTH = 100
const EXCERPT_BEFORE = 40
const EXCERPT_LENGTH = 120

/** The query a request asked for, or the reason it is malformed (a 400). */
export const parseHistoryQuery = (
  params: URLSearchParams,
): { ok: true; query: HistoryQuery } | { ok: false; error: string } => {
  const kind = params.get("kind")
  if (kind !== null && !KINDS.includes(kind as AttentionKind))
    return { ok: false, error: `kind must be one of ${KINDS.join(", ")}` }
  const before = params.get("before")
  if (before !== null && decodeCursor(before) === null)
    return { ok: false, error: "before is not a cursor from nextBefore" }
  const rawLimit = params.get("limit")
  const limit = rawLimit === null ? HISTORY_LIMIT_DEFAULT : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_LIMIT_MAX)
    return { ok: false, error: `limit must be 1 to ${HISTORY_LIMIT_MAX}` }
  return {
    ok: true,
    query: { q: params.get("q") ?? "", kind: kind as AttentionKind | null, before, limit },
  }
}

/** Lower-cased search words: split on whitespace, deduped, bounded. */
export const historyWords = (q: string | undefined): string[] =>
  [
    ...new Set(
      (q ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w !== "")
        .map((w) => w.slice(0, MAX_WORD_LENGTH)),
    ),
  ].slice(0, MAX_WORDS)

/**
 * How a finished item ended, from what its rows already record (C-027):
 * the terminal state, whether an answer went out from the inbox (`answered_at`), and the
 * approval's decision.
 */
export const outcomeOf = (
  item: Pick<ItemRow, "kind" | "state" | "answered_at">,
  approval: Pick<ApprovalRow, "decision"> | null,
): HistoryOutcome => {
  if (item.state === "dismissed") return "dismissed"
  if (item.state === "expired") return "expired"
  const answeredHere = item.answered_at !== null
  if (item.kind === "permission") {
    if (!answeredHere) return "in-claude"
    switch (approval?.decision) {
      case "allow":
        return "allowed"
      case "allow-always":
        return "always-allowed"
      case "deny":
        return "denied"
      // "Ask in Claude" hands the call to Claude's own prompt.
      case "ask":
        return "in-claude"
      // No hold to decide (a prompt Claude only told us about): the answer was a reply.
      default:
        return "replied"
    }
  }
  if (item.kind === "question") return answeredHere ? "answered" : "in-claude"
  return answeredHere ? "replied" : "moved-on"
}

const encodeCursor = (endedAt: number, id: string) => `${endedAt}:${id}`
const decodeCursor = (cursor: string): { endedAt: number; id: string } | null => {
  const at = cursor.indexOf(":")
  if (at < 1 || at === cursor.length - 1) return null
  const endedAt = Number(cursor.slice(0, at))
  return Number.isFinite(endedAt) ? { endedAt, id: cursor.slice(at + 1) } : null
}

/** A LIKE pattern for "contains `word`", with LIKE's own wildcards escaped by a backslash. */
const contains = (word: string) => `%${word.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
/** The same word as it appears inside a JSON string (quotes and backslashes escaped). */
const inJson = (word: string) => JSON.stringify(word).slice(1, -1)

const ENDED = "COALESCE(i.answered_at, i.updated_at)"
const TEXT_COLUMNS = ["i.summary", "s.title", "s.branch", "s.cwd", "p.name"]
const WORD_CLAUSE = `(
  ${TEXT_COLUMNS.map((col) => `${col} LIKE ?1 ESCAPE '\\'`).join(" OR ")}
  OR EXISTS (SELECT 1 FROM questions q WHERE q.item_id = i.id AND (
       q.text LIKE ?1 ESCAPE '\\' OR q.header LIKE ?1 ESCAPE '\\'
       OR q.options_json LIKE ?2 ESCAPE '\\' OR q.answer_json LIKE ?2 ESCAPE '\\'))
  OR EXISTS (SELECT 1 FROM approvals a WHERE a.item_id = i.id AND (
       a.tool LIKE ?1 ESCAPE '\\' OR a.reason LIKE ?1 ESCAPE '\\' OR a.input_json LIKE ?2 ESCAPE '\\'))
  OR EXISTS (SELECT 1 FROM outbox o WHERE o.item_id = i.id AND o.body LIKE ?1 ESCAPE '\\')
)`

/** One line of `text` around the first place `word` occurs, or null when it doesn't. */
export const excerptAround = (text: string, word: string): string | null => {
  const line = text.replace(/\s+/g, " ").trim()
  const at = line.toLowerCase().indexOf(word)
  if (at < 0) return null
  const start = Math.max(0, at - EXCERPT_BEFORE)
  const end = Math.min(line.length, start + EXCERPT_LENGTH)
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`
}

/** Every string inside a parsed JSON value, in document order. */
const strings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") out.push(value)
  else if (Array.isArray(value)) for (const v of value) strings(v, out)
  else if (value !== null && typeof value === "object")
    for (const v of Object.values(value)) strings(v, out)
  return out
}

const parsed = (json: string | null): unknown => {
  if (json === null) return null
  try {
    return JSON.parse(json) as unknown
  } catch {
    return null
  }
}

interface Related {
  session: SessionRow
  project: ProjectRow
  approval: ApprovalRow | null
  questions: QuestionRow[]
  replies: OutboxRow[]
}

/**
 * Where the search matched when the row's own lines don't show it: the first word that
 * isn't in the summary, session title or project name, found in what the item
 * carried. Absent when every word is already visible.
 */
export const matchOf = (item: ItemRow, r: Related, words: string[]): HistoryMatch | undefined => {
  const visible = [item.summary, r.session.title, r.project.name]
    .filter((t): t is string => t !== null)
    .join("\n")
    .toLowerCase()
  const hidden = words.find((w) => !visible.includes(w))
  if (hidden === undefined) return undefined
  const sources: Array<[HistoryMatch["where"], string[]]> = [
    [
      "question",
      r.questions.flatMap((q) => [q.header ?? "", q.text, ...strings(parsed(q.options_json))]),
    ],
    ["answer", r.questions.flatMap((q) => strings(parsed(q.answer_json)))],
    ["tool", r.approval ? [r.approval.tool, ...strings(parsed(r.approval.input_json))] : []],
    ["reason", r.approval?.reason ? [r.approval.reason] : []],
    ["reply", r.replies.map((o) => o.body)],
    ["branch", r.session.branch ? [r.session.branch] : []],
    ["path", r.session.cwd ? [r.session.cwd] : []],
  ]
  for (const [where, texts] of sources)
    for (const text of texts) {
      const excerpt = excerptAround(text, hidden)
      if (excerpt !== null) return { where, text: excerpt }
    }
  return undefined
}

export const historyPage = (
  store: Store,
  query: HistoryQuery,
  retentionDays: number,
): HistoryPage => {
  const words = historyWords(query.q)
  const limit = Math.min(HISTORY_LIMIT_MAX, Math.max(1, query.limit ?? HISTORY_LIMIT_DEFAULT))
  const where = ["i.state IN ('answered','resolved','expired','dismissed')"]
  const params: Array<string | number> = []
  // Numbered parameters (?1, ?2) repeat inside one word's clause; each word gets its own pair.
  const bind = (value: string | number) => `?${params.push(value)}`
  if (query.kind) where.push(`i.kind = ${bind(query.kind)}`)
  const cursor = query.before ? decodeCursor(query.before) : null
  if (cursor) {
    const at = bind(cursor.endedAt)
    where.push(`(${ENDED} < ${at} OR (${ENDED} = ${at} AND i.id < ${bind(cursor.id)}))`)
  }
  for (const word of words) {
    const plain = bind(contains(word))
    const json = bind(contains(inJson(word)))
    where.push(WORD_CLAUSE.replaceAll("?1", plain).replaceAll("?2", json))
  }
  const rows = store.all<ItemRow & { ended_at: number }>(
    `SELECT i.*, ${ENDED} AS ended_at FROM attention_items i
       JOIN sessions s ON s.id = i.session_id
       JOIN projects p ON p.id = s.project_id
      WHERE ${where.join("\n        AND ")}
      ORDER BY ended_at DESC, i.id DESC LIMIT ${bind(limit + 1)}`,
    ...params,
  )
  const page = rows.slice(0, limit)
  const entries = page.flatMap((row): HistoryEntry[] => {
    const session = store.session(row.session_id)
    const project = session ? store.project(session.project_id) : null
    if (!session || !project) return []
    const approval = store.approval(row.id)
    const related: Related = {
      session,
      project,
      approval,
      questions: words.length > 0 ? store.questions(row.id) : [],
      replies:
        words.length > 0
          ? store.all<OutboxRow>(
              "SELECT * FROM outbox WHERE item_id = ? ORDER BY created_at",
              row.id,
            )
          : [],
    }
    const match = words.length > 0 ? matchOf(row, related, words) : undefined
    return [
      {
        item: store.itemView(row),
        session: toSession(session),
        project: toProject(project),
        outcome: outcomeOf(row, approval),
        endedAt: row.ended_at,
        ...(match ? { match } : {}),
      },
    ]
  })
  const last = page[page.length - 1]
  return {
    entries,
    nextBefore: rows.length > limit && last ? encodeCursor(last.ended_at, last.id) : null,
    retentionDays,
  }
}
