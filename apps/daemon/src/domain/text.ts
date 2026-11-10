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

const short = (s: string, n = 80) => {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

const field = (input: unknown, key: string): string | null => {
  const v = (input as Record<string, unknown> | null | undefined)?.[key]
  return typeof v === "string" ? v : null
}

/** "Wants to run bun test", "Wants to edit src/x.ts". */
export const permissionSummary = (tool: string, input: unknown): string => {
  const cmd = field(input, "command")
  if (tool === "Bash" && cmd) return `Wants to run ${short(cmd)}`
  const file = field(input, "file_path") ?? field(input, "notebook_path")
  if (
    file &&
    (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit")
  )
    return `Wants to ${tool === "Write" ? "write" : "edit"} ${short(file)}`
  const url = field(input, "url")
  if (tool === "WebFetch" && url) return `Wants to fetch ${short(url)}`
  return `Wants to use ${tool}`
}

/** One timeline line for a PostToolUse. */
export const toolLine = (tool: string, input: unknown): string => {
  const cmd = field(input, "command")
  const file = field(input, "file_path") ?? field(input, "notebook_path")
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

/**
 * What Claude said just before a tool call (D-057): the last assistant text in the
 * transcript tail before the `tool_use` block with `toolUseId` (or before the end when that
 * block isn't there yet), never reaching back past a typed user prompt. Null when none.
 */
export const lastAssistantText = (
  tail: string | null,
  toolUseId: string | null,
  max = CONTEXT_MAX_CHARS,
): string | null => {
  if (!tail) return null
  const entries = tailEntries(tail)
  const hasToolUse = (e: Record<string, unknown>) => {
    const b = blocksOf(e)
    return Array.isArray(b) && b.some((x) => x.type === "tool_use" && x.id === toolUseId)
  }
  const at = toolUseId ? entries.findLastIndex(hasToolUse) : -1
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
