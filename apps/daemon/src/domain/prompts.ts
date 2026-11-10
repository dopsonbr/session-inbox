/**
 * Is a permission prompt Claude is showing one the inbox already tracks? (D-010, D-067)
 * Pure: the engine gathers the session's permission/question items and asks here.
 */

/** Hold lapses / "ask" releases this recent still count as the same prompt. */
export const PROMPT_RECENT_MS = 30_000

/**
 * The tool a permission-prompt Notification names: "Claude needs your permission to use
 * Read" → "Read". Liberal (quotes, trailing punctuation, MCP display names); null when the
 * message doesn't say.
 */
export const promptTool = (message: string | null | undefined): string | null => {
  if (!message) return null
  const line = message.split("\n").find((l) => /permission to use/i.test(l))
  if (!line) return null
  const m = /permission to use\s+(.+)$/i.exec(line.trim())
  const name = m?.[1]
    ?.trim()
    .replace(/[.!?:;,]+$/, "")
    .replace(/^["'`“‘]+|["'`”’]+$/g, "")
    .trim()
  return name ? name : null
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")

/**
 * Does the tool named in a prompt message refer to `tool` (an approval's tool_name)? Exact,
 * or equal ignoring case and punctuation; an MCP tool (`mcp__server__tool`) also matches a
 * display name that contains both its server and tool parts.
 */
export const sameTool = (named: string, tool: string): boolean => {
  if (named === tool) return true
  const a = norm(named)
  if (a !== "" && a === norm(tool)) return true
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp?.[1] && mcp[2]) return a.includes(norm(mcp[1])) && a.includes(norm(mcp[2]))
  return false
}

export interface PromptCandidate {
  readonly itemId: string
  /** open or snoozed: still in the inbox. */
  readonly open: boolean
  /** The approval's tool; "AskUserQuestion" for question items; null when unknown. */
  readonly tool: string | null
  /** The approval's decision, if any. */
  readonly decision: string | null
  readonly decidedAt: number | null
  /** The session had activity (a tool ran, a prompt, a stop) after `decidedAt`. */
  readonly activitySince: boolean
  /** When the person dismissed it, if they did (D-085). */
  readonly dismissedAt?: number | null
}

/** A prompt item dismissed this recently is still "the same prompt" (D-085). */
export const DISMISSED_RECENT_MS = 60_000

/**
 * More than one open item a prompt for `tool` (null: any) could be about: a Notification, which
 * names no agent or call, can't tell which (D-084).
 */
export const ambiguousPrompt = (
  candidates: ReadonlyArray<PromptCandidate>,
  tool: string | null,
): boolean =>
  candidates.filter((c) => c.open && (tool === null || (c.tool !== null && sameTool(tool, c.tool))))
    .length > 1

/**
 * The item a permission prompt for `tool` is about, or null when it's a new prompt:
 * - an open item for the same tool (a live hold, a hold waiting in Claude, an observed prompt);
 * - an item for the same tool whose hold lapsed or was released with `ask` within 30 s, or with
 *   no session activity since (Claude can't start another call while that prompt waits).
 * - an item for the same tool the person dismissed within the last 60 s (D-085).
 * Items decided allow / deny / allow-always never match: that call ran or was refused.
 * With no tool named, only an open item matches.
 */
export const matchPrompt = (
  candidates: ReadonlyArray<PromptCandidate>,
  tool: string | null,
  now: number,
): PromptCandidate | null => {
  const dismissed = (c: PromptCandidate) =>
    c.dismissedAt != null && now - c.dismissedAt <= DISMISSED_RECENT_MS
  if (tool === null) return candidates.find((c) => c.open) ?? candidates.find(dismissed) ?? null
  const same = candidates.filter((c) => c.tool !== null && sameTool(tool, c.tool))
  const open = same.find((c) => c.open)
  if (open) return open
  const gone = same.find(dismissed)
  if (gone) return gone
  return (
    same.find(
      (c) =>
        c.decision === "ask" &&
        c.decidedAt !== null &&
        (now - c.decidedAt <= PROMPT_RECENT_MS || !c.activitySince),
    ) ?? null
  )
}
