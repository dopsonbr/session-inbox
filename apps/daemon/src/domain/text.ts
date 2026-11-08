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
  if (!path) return false
  let fd: number | null = null
  try {
    fd = openSync(path, "r")
    const size = fstatSync(fd).size
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString("utf8").split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim()
      if (!line) continue
      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue // first line of the tail is usually cut mid-entry
      }
      const msg = entry.message as Record<string, unknown> | undefined
      const isAssistant = entry.type === "assistant" || msg?.role === "assistant"
      if (!isAssistant) continue
      return entry.isApiErrorMessage === true || entry.error != null || msg?.error != null
    }
    return false
  } catch {
    return false
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
