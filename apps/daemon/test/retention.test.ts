import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { openDb } from "../src/db/db.ts"
import { reclaimSpace } from "../src/retention.ts"
import { envelope, type Harness, makeHarness } from "./fakes.ts"

const DAY = 24 * 3600_000
const A = "eeeeeeee-0000-4000-8000-00000000000a"
const B = "eeeeeeee-0000-4000-8000-00000000000b"
const C = "eeeeeeee-0000-4000-8000-00000000000c"

const n = (h: Harness, sql: string, ...params: unknown[]) =>
  (h.engine.deps.db.query(sql).get(...(params as never[])) as { n: number }).n

const seed = async (h: Harness) => {
  const a = { session_id: A, cwd: "/w/a" }
  // A: a finished session with lots of tool calls, a review item that was superseded.
  await h.engine.ingest("Stop", envelope("Stop", { ...a, last_assistant_message: "Done" }))
  await h.engine.ingest("UserPromptSubmit", envelope("UserPromptSubmit", { ...a, prompt: "more" }))
  for (let i = 0; i < 20; i++)
    await h.engine.ingest(
      "PostToolUse",
      envelope("PostToolUse", { ...a, tool_name: "Bash", tool_input: { command: `echo ${i}` } }),
    )
  await h.engine.ingest("SessionEnd", envelope("SessionEnd", { ...a, reason: "prompt_input_exit" }))
  // B: still waiting on you, from long ago.
  const b = { session_id: B, cwd: "/w/b" }
  await h.engine.ingest(
    "PostToolUse",
    envelope("PostToolUse", { ...b, tool_name: "Read", tool_input: { file_path: "/w/b/x" } }),
  )
  await h.engine.ingest(
    "Notification",
    envelope("Notification", { ...b, notification_type: "idle_prompt", message: "Waiting" }),
  )
}

describe("retention (D-063)", () => {
  test("prunes finished history older than the cutoff, never what the UI counts", async () => {
    const h = makeHarness()
    await seed(h)
    h.clock.advance(15 * DAY)
    await h.engine.ingest(
      "PostToolUse",
      envelope("PostToolUse", { session_id: C, cwd: "/w/c", tool_name: "Bash", tool_input: {} }),
    )
    const before = h.engine.snapshot()
    const bItem = before.items.find((i) => i.sessionId === B)
    expect(bItem?.state).toBe("open")

    const counts = h.engine.prune(false)
    expect(counts).not.toBeNull()
    expect(counts?.sessions).toBe(1)
    expect(counts?.items).toBe(1)
    expect(counts?.events).toBeGreaterThan(20)

    // A is gone completely; B keeps its open item and the event that raised it.
    expect(n(h, "SELECT COUNT(*) AS n FROM sessions WHERE id = ?", A)).toBe(0)
    expect(n(h, "SELECT COUNT(*) AS n FROM agents WHERE session_id = ?", A)).toBe(0)
    expect(n(h, "SELECT COUNT(*) AS n FROM attention_items WHERE session_id = ?", A)).toBe(0)
    expect(n(h, "SELECT COUNT(*) AS n FROM events WHERE session_id = ?", A)).toBe(0)
    expect(n(h, "SELECT COUNT(*) AS n FROM events WHERE session_id = ?", B)).toBe(1)
    expect(n(h, "SELECT COUNT(*) AS n FROM events WHERE session_id = ?", C)).toBe(1)
    const detail = h.engine.itemDetail(bItem?.id ?? "")
    expect(detail.timeline.filter((e) => e.isSource)).toHaveLength(1)

    const after = h.engine.snapshot()
    expect(after.counts).toEqual(before.counts)
    expect(after.items.map((i) => i.id)).toEqual(before.items.map((i) => i.id))
    const pruned = h.engine.deps.db
      .query("SELECT payload_json FROM events WHERE hook = 'daemon:pruned'")
      .all() as { payload_json: string }[]
    expect(pruned).toHaveLength(1)
    expect(JSON.parse(pruned[0]?.payload_json ?? "{}")).toMatchObject({ sessions: 1, days: 14 })

    // Nothing left to prune: no second event.
    expect(h.engine.prune(false)).toBeNull()
    expect(n(h, "SELECT COUNT(*) AS n FROM events WHERE hook = 'daemon:pruned'")).toBe(1)
  })

  test("the retention setting moves the cutoff and is clamped", async () => {
    const h = makeHarness()
    await seed(h)
    h.engine.updateSettings({ "storage.retentionDays": 30 })
    h.clock.advance(15 * DAY)
    expect(h.engine.prune(false)).toBeNull()
    h.engine.updateSettings({ "storage.retentionDays": 0 })
    expect(h.engine.userSettings().settings["storage.retentionDays"]).toBe(1)
    expect(h.engine.prune(false)?.sessions).toBe(1)
  })

  test("the tick prunes once a day", async () => {
    const h = makeHarness()
    await seed(h)
    h.engine.tick() // first pass: nothing old yet
    h.clock.advance(15 * DAY)
    h.engine.tick()
    expect(n(h, "SELECT COUNT(*) AS n FROM sessions WHERE id = ?", A)).toBe(0)
    await h.engine.idle()
  })

  test("answered items and queued replies keep their rows", async () => {
    const h = makeHarness()
    await h.engine.ingest("Stop", envelope("Stop", { session_id: A, cwd: "/w/a" }))
    const id = h.engine.snapshot().items[0]?.id ?? ""
    h.engine.reply(id, "k", "go on")
    await h.engine.idle()
    h.clock.advance(20 * DAY)
    h.engine.prune(false)
    expect(n(h, "SELECT COUNT(*) AS n FROM attention_items WHERE id = ?", id)).toBe(1)
  })
})

describe("reclaiming space", () => {
  test("new files use incremental auto-vacuum; a mostly-free file gets a full VACUUM", () => {
    const file = join(mkdtempSync("/tmp/si-ret-"), "inbox.db")
    const db = openDb(file)
    expect(db.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 })
    db.exec("CREATE TABLE junk (x TEXT)")
    const ins = db.query("INSERT INTO junk VALUES (?)")
    db.transaction(() => {
      for (let i = 0; i < 2000; i++) ins.run("y".repeat(2000))
    })()
    db.exec("DELETE FROM junk")
    expect(reclaimSpace(db, false)).toBe("incremental")
    expect(
      (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count,
    ).toBe(0)
    db.close()
  })

  test("an older file: full VACUUM only at startup and only when mostly free", () => {
    const db = new Database(join(mkdtempSync("/tmp/si-ret-"), "old.db"))
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("CREATE TABLE junk (x TEXT)")
    const ins = db.query("INSERT INTO junk VALUES (?)")
    db.transaction(() => {
      for (let i = 0; i < 2000; i++) ins.run("y".repeat(2000))
    })()
    db.exec("DELETE FROM junk")
    expect(reclaimSpace(db, false)).toBe("none")
    expect(reclaimSpace(db, true)).toBe("full")
    expect(db.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 })
    expect(reclaimSpace(db, true)).toBe("none")
    db.close()
  })
})
