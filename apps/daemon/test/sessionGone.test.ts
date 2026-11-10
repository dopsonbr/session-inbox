/**
 * Claude died without a SessionEnd (D-090): its "Waiting in Claude" items leave the inbox and
 * its transcript stops being read, found with an injectable liveness probe.
 */
import { describe, expect, test } from "bun:test"
import { openDb } from "../src/db/db.ts"
import { processAlive } from "../src/services.ts"
import { env, envelope, type Harness, makeClassicHarness, makeHarness } from "./fakes.ts"

const SID = "cdcdcdcd-0000-4000-8000-0000000000d9"
const T = "/t/gone.jsonl"
const base = { session_id: SID, cwd: "/work/x", permission_mode: "default", transcript_path: T }
const ev = (event: string, payload: Record<string, unknown>, pid = 4321) =>
  envelope(event, { ...base, ...payload }, { ...env(), claudePid: pid })
const shape = (h: Harness) => h.engine.snapshot().items.map((i) => [i.state, i.live])
const after = (h: Harness, ms: number) => {
  h.clock.advance(ms)
  h.engine.tick()
}

describe("Claude's process is gone (D-090)", () => {
  test("observed prompt: resolved, session ended, transcript no longer read", async () => {
    const h = makeClassicHarness({ settings: { "holds.enabled": false } })
    h.files.tails[T] = "\n"
    await h.engine.ingest(
      "PermissionRequest",
      ev("PermissionRequest", { tool_name: "Bash", tool_input: { command: "make" } }),
    )
    expect(h.engine.store.session(SID)?.claude_pid).toBe(4321)
    let reads = 0
    const tail = h.files.tail
    h.files.tail = (p, n) => {
      reads++
      return tail(p, n)
    }
    after(h, 2_000)
    expect(shape(h)).toEqual([["open", false]])
    h.dead.add(4321)
    after(h, 10_000)
    expect(shape(h)).toEqual([["resolved", false]])
    expect(h.engine.store.session(SID)?.state).toBe("ended")
    expect(h.engine.snapshot().counts.needsYou).toBe(0)
    expect(
      h.engine.store.one("SELECT 1 AS x FROM events WHERE hook = 'daemon:session-gone'"),
    ).not.toBeNull()
    const n = reads
    after(h, 1_000)
    after(h, 1_000)
    expect(reads).toBe(n)
  })

  test("a lapsed classic hold and a live request go too; a live process keeps them", async () => {
    const h = makeHarness()
    const r = await h.engine.ingest(
      "PermissionRequest",
      ev("PermissionRequest", { tool_name: "Bash", tool_input: { command: "make" } }),
    )
    const waiting = h.engine.waitDecision(r.requestId ?? "", 60)
    after(h, 30_000)
    expect(shape(h)).toEqual([["open", true]])
    h.dead.add(4321)
    after(h, 10_000)
    expect(shape(h)).toEqual([["resolved", false]])
    expect((await waiting).decision).toBe("ask")

    const c = makeClassicHarness()
    await c.engine.ingest(
      "PreToolUse",
      ev("PreToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "rm x" } }),
    )
    after(c, 120_001)
    expect(shape(c)).toEqual([["open", false]])
    c.dead.add(4321)
    after(c, 10_000)
    expect(shape(c)).toEqual([["resolved", false]])
  })

  test("the newest pid wins (a resumed session); no pid, nothing is checked", async () => {
    const h = makeClassicHarness({ settings: { "holds.enabled": false } })
    await h.engine.ingest("UserPromptSubmit", ev("UserPromptSubmit", { prompt: "hi" }, 1111))
    await h.engine.ingest(
      "PermissionRequest",
      ev("PermissionRequest", { tool_name: "Bash", tool_input: { command: "make" } }, 2222),
    )
    expect(h.engine.store.session(SID)?.claude_pid).toBe(2222)
    h.dead.add(1111)
    after(h, 10_000)
    expect(shape(h)).toEqual([["open", false]])

    const n = makeClassicHarness({ settings: { "holds.enabled": false } })
    await n.engine.ingest(
      "PermissionRequest",
      envelope(
        "PermissionRequest",
        { ...base, tool_name: "Bash", tool_input: { command: "make" } },
        { ...env(), claudePid: null as unknown as number },
      ),
    )
    n.dead.add(4321)
    after(n, 10_000)
    expect(shape(n)).toEqual([["open", false]])
  })

  test("only every ~10 s, and an idle session with nothing waiting isn't checked", async () => {
    const h = makeClassicHarness({ settings: { "holds.enabled": false } })
    const asked: number[] = []
    ;(h.engine.deps as { alive?: (pid: number) => boolean }).alive = (pid) => {
      asked.push(pid)
      return true
    }
    await h.engine.ingest("Stop", ev("Stop", {}))
    after(h, 10_000)
    expect(asked).toEqual([])
    await h.engine.ingest(
      "PermissionRequest",
      ev("PermissionRequest", { tool_name: "Bash", tool_input: { command: "make" } }),
    )
    for (let i = 0; i < 10; i++) after(h, 1_000)
    expect(asked).toEqual([4321])
  })

  test("the live probe: our own pid is alive, a pid that can't exist isn't", () => {
    expect(processAlive(process.pid)).toBe(true)
    expect(processAlive(99_999_999)).toBe(false)
  })

  test("migration 005 adds the column", () => {
    const db = openDb(":memory:")
    const cols = db.query("PRAGMA table_info(sessions)").all() as { name: string }[]
    expect(cols.map((c) => c.name)).toContain("claude_pid")
  })
})
