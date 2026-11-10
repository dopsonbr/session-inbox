/**
 * SQLite access. bun:sqlite directly (see DECISIONS.md D-002): the daemon is the
 * single writer and every domain step runs as one synchronous transaction.
 */
import { Database } from "bun:sqlite"
import m001 from "./migrations/001_init.sql" with { type: "text" }
import m002 from "./migrations/002_review_group.sql" with { type: "text" }
import m003 from "./migrations/003_approval_preview.sql" with { type: "text" }

/** Numbered migrations, embedded so `bun build --compile` carries them. Append only. */
export const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  { version: 1, sql: m001 },
  { version: 2, sql: m002 },
  { version: 3, sql: m003 },
]

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

export const openDb = (file: string): Database => {
  const db = new Database(file, { create: true, strict: true })
  // New files reclaim pruned pages without a full VACUUM (D-063). Only possible before the
  // file has any content, so before switching to WAL too.
  const empty = db.query("SELECT COUNT(*) AS n FROM sqlite_master").get() as { n: number }
  if (empty.n === 0) db.exec("PRAGMA auto_vacuum = INCREMENTAL")
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA synchronous = NORMAL")
  migrate(db)
  return db
}

export const migrate = (db: Database): number => {
  const row = db.query("PRAGMA user_version").get() as { user_version: number }
  let current = row.user_version
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    db.transaction(() => {
      db.exec(m.sql)
      db.exec(`PRAGMA user_version = ${m.version}`)
    })()
    current = m.version
  }
  return current
}
