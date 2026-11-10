/**
 * History retention (D-063). Hook payloads are stored raw and PostToolUse rows are large,
 * so finished history older than `storage.retentionDays` is deleted once at startup and then
 * daily. Nothing the UI counts or shows (open/snoozed/answered items, sessions that aren't
 * ended, the 24 h snapshot window) is touched, and foreign keys are respected.
 */
import type { Database } from "bun:sqlite"

export interface PruneCounts {
  events: number
  items: number
  sessions: number
  notifications: number
  outbox: number
  drafts: number
  intents: number
}

export const DAY_MS = 24 * 3600_000

export const pruneTotal = (c: PruneCounts) =>
  c.events + c.items + c.sessions + c.notifications + c.outbox + c.drafts + c.intents

/** Finished item states; open, snoozed and answered items are never pruned. */
const FINISHED = "('resolved','expired','dismissed')"

/**
 * Delete what is older than `cutoff` (epoch ms). Runs inside the caller's transaction.
 * Order matters for the foreign keys: an item's children, the items, then events no
 * remaining item points at, then ended sessions with nothing left.
 */
export const pruneHistory = (db: Database, cutoff: number): PruneCounts => {
  const run = (sql: string, ...params: unknown[]) =>
    db.query(sql).run(...(params as never[])).changes
  db.exec("DROP TABLE IF EXISTS temp.prune_items")
  db.exec("CREATE TEMP TABLE prune_items (id TEXT PRIMARY KEY)")
  try {
    // Finished items untouched since the cutoff, with no reply still waiting to go out.
    run(
      `INSERT INTO temp.prune_items (id)
         SELECT i.id FROM attention_items i
          WHERE i.state IN ${FINISHED} AND i.updated_at < ?
            AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.item_id = i.id AND o.state IN ('queued','sending'))
            AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.item_id = i.id AND a.live = 1)`,
      cutoff,
    )
    const inPrune = "IN (SELECT id FROM temp.prune_items)"
    run(`DELETE FROM questions WHERE item_id ${inPrune}`)
    run(`DELETE FROM approvals WHERE item_id ${inPrune}`)
    run(`DELETE FROM review_group WHERE item_id ${inPrune}`)
    const drafts = run(`DELETE FROM drafts WHERE item_id ${inPrune}`)
    const notifications =
      run(`DELETE FROM notifications WHERE item_id ${inPrune}`) +
      run(
        "DELETE FROM notifications WHERE state IN ('cleared','acted','clicked') AND created_at < ?",
        cutoff,
      )
    const outbox =
      run(`DELETE FROM outbox WHERE item_id ${inPrune}`) +
      run("DELETE FROM outbox WHERE state IN ('delivered','failed') AND created_at < ?", cutoff)
    const items = run(`DELETE FROM attention_items WHERE id ${inPrune}`)
    const intents = run("DELETE FROM intents WHERE created_at < ?", cutoff)
    // Events no remaining item refers to (source_seq is a foreign key; answered_seq isn't,
    // but keep it too so a confirmation window can still be explained).
    const events = run(
      `DELETE FROM events WHERE received_at < ?
         AND seq NOT IN (SELECT source_seq FROM attention_items WHERE source_seq IS NOT NULL)
         AND seq NOT IN (SELECT answered_seq FROM attention_items WHERE answered_seq IS NOT NULL)`,
      cutoff,
    )
    // Sessions that ended before the cutoff and have nothing left that points at them.
    db.exec("DROP TABLE IF EXISTS temp.prune_sessions")
    db.exec("CREATE TEMP TABLE prune_sessions (id TEXT PRIMARY KEY)")
    run(
      `INSERT INTO temp.prune_sessions (id)
         SELECT s.id FROM sessions s WHERE s.state = 'ended' AND s.last_event_at < ?
            AND NOT EXISTS (SELECT 1 FROM attention_items i WHERE i.session_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.session_id = s.id)`,
      cutoff,
    )
    run("DELETE FROM agents WHERE session_id IN (SELECT id FROM temp.prune_sessions)")
    const sessions = run("DELETE FROM sessions WHERE id IN (SELECT id FROM temp.prune_sessions)")
    db.exec("DROP TABLE temp.prune_sessions")
    return { events, items, sessions, notifications, outbox, drafts, intents }
  } finally {
    db.exec("DROP TABLE IF EXISTS temp.prune_items")
  }
}

/**
 * Give the space back without blocking: checkpoint the WAL, then an incremental vacuum
 * (a no-op unless auto_vacuum is INCREMENTAL). With `allowFull` (startup only), a full VACUUM
 * when more than a quarter of the file is free pages; it also switches the file to
 * incremental auto-vacuum so later passes can reclaim space cheaply.
 */
export const reclaimSpace = (db: Database, allowFull: boolean): "full" | "incremental" | "none" => {
  const pragma = (name: string) =>
    Number(Object.values((db.query(`PRAGMA ${name}`).get() as Record<string, unknown>) ?? {})[0])
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  const pages = pragma("page_count")
  const free = pragma("freelist_count")
  if (allowFull && pages > 0 && free / pages > 0.25) {
    db.exec("PRAGMA auto_vacuum = INCREMENTAL")
    db.exec("VACUUM")
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    return "full"
  }
  if (pragma("auto_vacuum") === 2 && free > 0) {
    db.exec("PRAGMA incremental_vacuum")
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    return "incremental"
  }
  return "none"
}
