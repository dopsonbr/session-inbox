/** Small pure text helpers: titles, summaries, timeline lines, transcript tail. */
import { closeSync, fstatSync, openSync, readSync } from "node:fs"

export const PROVISIONAL_TITLE_MAX = 60

export const provisionalTitle = (prompt: string): string | null => {
  const oneLine = prompt.replace(/\s+/g, " ").trim()
  if (!oneLine) return null
  if (oneLine.length <= PROVISIONAL_TITLE_MAX) return oneLine
  const cut = oneLine.slice(0, PROVISIONAL_TITLE_MAX)
  const sp = cut.lastIndexOf(" ")
  return `${(sp > 30 ? cut.slice(0, sp) : cut).trimEnd()}…`
}

export const TITLE_INSTRUCTION =
  "Write a 3 to 6 word title for a coding session that starts with the request below. " +
  "Reply with the title only: no quotes, no punctuation at the end.\n\nRequest:\n"

export const cleanGeneratedTitle = (out: string): string | null => {
  const line = out
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return null
  const t = line.replace(/^["'`*#\s]+|["'`*.\s]+$/g, "").trim()
  if (!t || t.length > 80) return null
  const words = t.split(/\s+/).length
  return words >= 1 && words <= 10 ? t : null
}

/** First non-empty line, shortened; null for empty input. */
export const firstLine = (s: string | null | undefined, n = 100): string | null => {
  const line = s
    ?.split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return null
  return line.length > n ? `${line.slice(0, n - 1)}…` : line
}

/**
 * A card summary from Claude's last message (D-077): the first line with text once leading
 * `#`s, list and quote markers and emphasis markers are stripped ("## Results" → "Results"),
 * one line, capped like `firstLine`.
 */
export const summaryLine = (s: string | null | undefined, n = 100): string | null => {
  if (!s) return null
  for (const raw of s.split("\n")) {
    const line = raw
      .trim()
      .replace(/^(?:>\s*)+/, "")
      .replace(/^#{1,6}(?:\s+|$)/, "")
      .replace(/^(?:[-*+]|\d{1,3}[.)])\s+/, "")
      .replace(/(\*\*|__)/g, "")
      .replace(/(^|\s)[*_]([^*_\s][^*_]*?)[*_](?=$|\s|[.,:;!?)])/g, "$1$2")
      .replace(/^[*_]+|[*_]+$/g, "")
      .replace(/^#+\s*$/, "")
      .trim()
    if (/^[-*_=\s]*$/.test(line)) continue // rules and empty lines
    return line.length > n ? `${line.slice(0, n - 1)}…` : line
  }
  return null
}

const short = (s: string, n = 80) => {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

const field = (input: unknown, key: string): string | null => {
  const v = (input as Record<string, unknown> | null | undefined)?.[key]
  return typeof v === "string" ? v : null
}

/** How a file path is shown: project-relative where the caller knows the roots (D-064). */
export type ShowPath = (path: string) => string
const asIs: ShowPath = (p) => p

const filePath = (input: unknown, show: ShowPath): string | null => {
  const f = field(input, "file_path") ?? field(input, "notebook_path")
  return f ? show(f) : null
}

/** "Wants to run bun test", "Wants to edit src/x.ts". */
export const permissionSummary = (tool: string, input: unknown, show: ShowPath = asIs): string => {
  const cmd = field(input, "command")
  if (tool === "Bash" && cmd) return `Wants to run ${short(cmd)}`
  const file = filePath(input, show)
  if (
    file &&
    (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit")
  )
    return `Wants to ${tool === "Write" ? "write" : "edit"} ${short(file)}`
  const url = field(input, "url")
  if (tool === "WebFetch" && url) return `Wants to fetch ${short(url)}`
  return `Wants to use ${tool}`
}

/** What a call still in flight is doing: "Running npm run dev", "Fetching https://…" (D-099). */
export const runningSummary = (tool: string, input: unknown, show: ShowPath = asIs): string => {
  const cmd = field(input, "command")
  const file = filePath(input, show)
  switch (tool) {
    case "Bash":
      return cmd ? `Running ${short(cmd)}` : "Running a command"
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return file ? `Editing ${short(file)}` : "Editing a file"
    case "Write":
      return file ? `Writing ${short(file)}` : "Writing a file"
    case "Read":
      return file ? `Reading ${short(file)}` : "Reading a file"
    case "WebFetch": {
      const url = field(input, "url")
      return url ? `Fetching ${short(url)}` : "Fetching a URL"
    }
    default:
      return `Running ${tool}`
  }
}

/** One timeline line for a PostToolUse. */
export const toolLine = (tool: string, input: unknown, show: ShowPath = asIs): string => {
  const cmd = field(input, "command")
  const file = filePath(input, show)
  switch (tool) {
    case "Bash":
      return cmd ? `Ran ${short(cmd)}` : "Ran a command"
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return file ? `Edited ${short(file)}` : "Edited a file"
    case "Write":
      return file ? `Wrote ${short(file)}` : "Wrote a file"
    case "Read":
      return file ? `Read ${short(file)}` : "Read a file"
    case "Grep":
    case "Glob": {
      const p = field(input, "pattern")
      return p ? `Searched ${short(p)}` : "Searched"
    }
    case "WebFetch": {
      const url = field(input, "url")
      return url ? `Fetched ${short(url)}` : "Fetched a URL"
    }
    case "AskUserQuestion":
      return "Got answers to its questions"
    default:
      return `Used ${tool}`
  }
}

export const TRANSCRIPT_TAIL_BYTES = 64 * 1024

/**
 * Whether the transcript's last assistant entry is an error. Reads only the tail.
 * Missing/unreadable transcript ⇒ false (a clean stop).
 */
export const lastTurnErrored = (path: string | null | undefined): boolean => {
  const tail = readTail(path)
  if (tail === null) return false
  const entries = tailEntries(tail)
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as Record<string, unknown>
    const msg = entry.message as Record<string, unknown> | undefined
    const isAssistant = entry.type === "assistant" || msg?.role === "assistant"
    if (!isAssistant) continue
    return entry.isApiErrorMessage === true || entry.error != null || msg?.error != null
  }
  return false
}

/** The last `bytes` of a file as UTF-8, or null when it can't be read. */
export const readTail = (
  path: string | null | undefined,
  bytes = TRANSCRIPT_TAIL_BYTES,
): string | null => {
  if (!path) return null
  let fd: number | null = null
  try {
    fd = openSync(path, "r")
    const size = fstatSync(fd).size
    const len = Math.min(size, bytes)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString("utf8")
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** The first `bytes` of a file as UTF-8, or null when it can't be read. */
export const readHead = (path: string | null | undefined, bytes: number): string | null => {
  if (!path) return null
  let fd: number | null = null
  try {
    fd = openSync(path, "r")
    const len = Math.min(fstatSync(fd).size, bytes)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, 0)
    return buf.toString("utf8")
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// Titles from the transcript (D-059) and cleaned prompt titles (D-060)
// ---------------------------------------------------------------------------

export const TITLE_HEAD_BYTES = 16 * 1024
export const UNTITLED = "Untitled session"

/**
 * The session title Claude itself wrote into the transcript, or null. Liberal on purpose:
 * `{"type":"custom-title","customTitle":…}` (the desktop app's own title, P-015) wins, then any
 * other `*title` type with a string `*itle` field (`ai-title`/`aiTitle`), then a
 * `{"type":"summary","summary":…}`. The latest line of the best kind wins.
 */
export const transcriptTitle = (text: string | null): string | null => {
  if (!text) return null
  let best: { rank: number; title: string } | null = null
  for (const line of text.split("\n")) {
    if (!line.includes('"type"') || !(line.includes('itle"') || line.includes('"summary"')))
      continue
    let o: Record<string, unknown>
    try {
      const v = JSON.parse(line) as unknown
      if (!v || typeof v !== "object" || Array.isArray(v)) continue
      o = v as Record<string, unknown>
    } catch {
      continue
    }
    const type = typeof o.type === "string" ? o.type.toLowerCase() : ""
    let rank = 0
    let title: unknown = null
    if (type === "custom-title") {
      rank = 3
      title = o.customTitle
    }
    if (typeof title !== "string" && type.endsWith("title")) {
      rank = type === "custom-title" ? 3 : 2
      const k = Object.keys(o).find(
        (k) => k !== "type" && /itle$/.test(k) && typeof o[k] === "string",
      )
      title = k ? o[k] : null
    }
    if (type === "summary") {
      rank = 1
      title = o.summary
    }
    if (typeof title !== "string") continue
    const t = title.replace(/\s+/g, " ").trim()
    if (!t) continue
    if (!best || rank >= best.rank) best = { rank, title: t }
  }
  return best?.title ?? null
}

const BACKGROUND = /^Background \(from the session that started this one\):/i
const LEADING_TAG = /^<([A-Za-z][\w:-]*)(?:\s[^>]*)?\/?>/
/** Wrappers whose inside IS the prompt (a message relayed from another session): unwrap, don't drop. */
const UNWRAP_TAGS = new Set(["cross-session-message"])

/**
 * The part of a prompt worth titling a session after (D-060): leading `<tag>…</tag>` blocks
 * (system reminders, task notifications) stripped, a leading "Background (from the session
 * that started this one):" paragraph dropped in favour of what follows `Task:` or the first
 * blank line, whitespace collapsed. Null when nothing readable is left.
 */
export const cleanPromptText = (prompt: string): string | null => {
  let s = prompt.trim()
  for (let guard = 0; guard < 20; guard++) {
    const m = LEADING_TAG.exec(s)
    if (m) {
      const tag = m[1] as string
      if (m[0].endsWith("/>")) {
        s = s.slice(m[0].length).trim()
        continue
      }
      const close = s.indexOf(`</${tag}>`, m[0].length)
      if (UNWRAP_TAGS.has(tag)) {
        s = (close < 0 ? s.slice(m[0].length) : s.slice(m[0].length, close)).trim()
        continue
      }
      s = close < 0 ? "" : s.slice(close + tag.length + 3).trim()
      continue
    }
    if (BACKGROUND.test(s)) {
      const task = /(?:^|\n)\s*Task:\s*/i.exec(s)
      if (task) s = s.slice(task.index + task[0].length).trim()
      else {
        const gap = /\n\s*\n/.exec(s)
        s = gap ? s.slice(gap.index + gap[0].length).trim() : ""
      }
      continue
    }
    break
  }
  const one = s.replace(/\s+/g, " ").trim()
  return /[\p{L}\p{N}]/u.test(one) ? one : null
}

/** Transcript entries of a tail, oldest first; unparsable lines (the cut first one) skipped. */
const tailEntries = (tail: string): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = []
  for (const line of tail.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      const v = JSON.parse(t) as unknown
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as Record<string, unknown>)
    } catch {
      // first line of the tail is usually cut mid-entry
    }
  }
  return out
}

export const CONTEXT_MAX_CHARS = 600

/** One line, cut to `n` chars at a word boundary with an ellipsis. */
export const wordTrim = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, " ").trim()
  if (one.length <= n) return one
  const cut = one.slice(0, n - 1)
  const sp = cut.lastIndexOf(" ")
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`
}

type Block = { type?: unknown; text?: unknown; id?: unknown }
const blocksOf = (entry: Record<string, unknown>): Block[] | string | null => {
  const c = (entry.message as { content?: unknown } | undefined)?.content
  if (typeof c === "string") return c
  return Array.isArray(c) ? (c as Block[]) : null
}

type ToolBlock = {
  type?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
}

const entryAt = (e: Record<string, unknown>): number | null => {
  const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : Number.NaN
  return Number.isFinite(ts) ? ts : null
}

/**
 * tool_use_ids that have a `tool_result` in the tail (ran, failed, or were denied), with the
 * result entry's `timestamp` (epoch ms) when it has one.
 */
export const toolResultIds = (tail: string | null): Map<string, number | null> => {
  const out = new Map<string, number | null>()
  if (!tail) return out
  for (const e of tailEntries(tail)) {
    const b = blocksOf(e)
    if (!Array.isArray(b)) continue
    for (const x of b as ToolBlock[])
      if (x.type === "tool_result" && typeof x.tool_use_id === "string")
        out.set(x.tool_use_id, entryAt(e))
  }
  return out
}

/** The timestamp of the oldest entry in the tail that has one (what the tail still covers). */
export const tailStartsAt = (tail: string | null): number | null => {
  if (!tail) return null
  for (const e of tailEntries(tail)) {
    const at = entryAt(e)
    if (at !== null) return at
  }
  return null
}

/**
 * The `tool_use` blocks in the tail for `name` whose input equals `input` (`same` compares,
 * e.g. by canonical JSON), newest first, with whether each already has a `tool_result` and the
 * entry's `timestamp` (epoch ms) when it has one (D-075, D-076).
 */
export const toolUsesIn = (
  tail: string | null,
  name: string,
  same: (input: unknown) => boolean,
): Array<{ id: string; hasResult: boolean; at: number | null; resultAt: number | null }> => {
  if (!tail) return []
  const entries = tailEntries(tail)
  const results = toolResultIds(tail)
  const out: Array<{ id: string; hasResult: boolean; at: number | null; resultAt: number | null }> =
    []
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as Record<string, unknown>
    const b = blocksOf(e)
    if (!Array.isArray(b)) continue
    const at = entryAt(e)
    for (const x of [...(b as ToolBlock[])].reverse())
      if (x.type === "tool_use" && x.name === name && typeof x.id === "string" && same(x.input))
        out.push({
          id: x.id,
          hasResult: results.has(x.id),
          at,
          resultAt: results.get(x.id) ?? null,
        })
  }
  return out
}

/**
 * What Claude said just before a tool call (D-057): the last assistant text in the
 * transcript tail before the `tool_use` block with `toolUseId` (or before the end when that
 * block isn't there yet), never reaching back past a typed user prompt. Null when none.
 * With `requireToolUse` the block must be in the tail: a later read (D-066) must not mistake
 * what Claude said after the call for what it said before it.
 */
export const lastAssistantText = (
  tail: string | null,
  toolUseId: string | null,
  max = CONTEXT_MAX_CHARS,
  opts: { requireToolUse?: boolean } = {},
): string | null => {
  if (!tail) return null
  const entries = tailEntries(tail)
  const hasToolUse = (e: Record<string, unknown>) => {
    const b = blocksOf(e)
    return Array.isArray(b) && b.some((x) => x.type === "tool_use" && x.id === toolUseId)
  }
  const at = toolUseId ? entries.findLastIndex(hasToolUse) : -1
  if (opts.requireToolUse && at < 0) return null
  const end = at >= 0 ? at + 1 : entries.length
  for (let i = end - 1; i >= 0; i--) {
    const entry = entries[i] as Record<string, unknown>
    const role = (entry.message as { role?: unknown } | undefined)?.role ?? entry.type
    const blocks = blocksOf(entry)
    if (role === "user") {
      // Tool results belong to the same turn; a typed prompt starts a new one.
      const isPrompt =
        typeof blocks === "string" || (blocks?.some((b) => b.type === "text") ?? false)
      if (isPrompt) return null
      continue
    }
    if (role !== "assistant" || blocks === null) continue
    const parts: string[] = []
    if (typeof blocks === "string") parts.push(blocks)
    else
      for (const b of blocks) {
        // In the tool_use entry itself, only text before that block counts.
        if (i === at && b.type === "tool_use" && b.id === toolUseId) break
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text)
      }
    const text = parts.join("\n").trim()
    if (text) return wordTrim(text, max)
  }
  return null
}
