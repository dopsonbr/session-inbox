/**
 * Daemon settings: code defaults, overridden by rows in the `settings` table
 * (value_json), overridden by explicit overrides (tests).
 */
import type { Database } from "bun:sqlite"
import type { AnswerMode } from "./domain/questions.ts"

export interface Settings {
  /** Generate a 3–6 word title with `claude -p --model haiku`. */
  "titles.generate": boolean
  /**
   * Hold hooks at all. Off for a channel installed beside another that holds (H-016):
   * two daemons holding the same call would each wait for their own answer.
   */
  "holds.enabled": boolean
  /** Tools whose PreToolUse may be held (when Claude itself would ask). */
  "holds.tools": string[]
  /** How long a held hook waits for a decision before falling back to `ask`. */
  "holds.budgetMs": number
  /** Bash command prefixes Claude runs without asking; never held. TODO-SPIKE: confirm list. */
  "holds.safeBashPrefixes": string[]
  /** How answers to a live AskUserQuestion travel back through the hook. */
  "questions.answerMode": AnswerMode
  /** Per-runtime override, written automatically when updatedInput answers don't land (P-004). */
  "questions.answerModeByRuntime": Record<string, AnswerMode>
  /** osascript fallback when no shell is connected. */
  "notifications.fallback": boolean
  /** Review (clean stop) notifications are coalesced within this window. */
  "notifications.reviewGroupMs": number
  /** Answered items not confirmed within this window are flagged unconfirmed. */
  "items.confirmWindowMs": number
  "outbox.maxAttempts": number
  "outbox.backoffMs": number
}

export const DEFAULT_SETTINGS: Settings = {
  "titles.generate": true,
  "holds.enabled": true,
  "holds.tools": ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch"],
  "holds.budgetMs": 120_000,
  "holds.safeBashPrefixes": [
    "ls",
    "pwd",
    "echo",
    "cat",
    "head",
    "tail",
    "wc",
    "which",
    "git status",
    "git diff",
    "git log",
  ],
  "questions.answerMode": "updatedInput",
  "questions.answerModeByRuntime": {},
  "notifications.fallback": true,
  "notifications.reviewGroupMs": 30_000,
  "items.confirmWindowMs": 5 * 60_000,
  "outbox.maxAttempts": 3,
  "outbox.backoffMs": 5_000,
}

export const loadSettings = (
  db: Database,
  overrides: Partial<Settings> = {},
  defaults: Partial<Settings> = {},
): Settings => {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...defaults }
  const rows = db.query("SELECT key, value_json FROM settings").all() as {
    key: string
    value_json: string
  }[]
  for (const r of rows) {
    if (!(r.key in DEFAULT_SETTINGS)) continue
    try {
      out[r.key] = JSON.parse(r.value_json)
    } catch {
      // ignore a corrupt row; the default stands
    }
  }
  return { ...(out as unknown as Settings), ...overrides }
}
