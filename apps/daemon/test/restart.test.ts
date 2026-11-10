/**
 * A daemon restart while a request is live (D-080, H-050): the hook keeps re-polling the same
 * request id, so a decision made after the restart still lands; with no hook left the request
 * lapses into Claude's own prompt instead of "succeeding" into the void.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Routes } from "@session-inbox/contracts"
import { startDaemon } from "../src/daemon.ts"
import { openDb } from "../src/db/db.ts"
import { ANSWER_IN_CLAUDE, ApiFailure, STILL_WAITING_PREFIX } from "../src/engine.ts"
import type { ApprovalRow, ItemRow, NotificationRow } from "../src/store.ts"
import {
  envelope,
  FakeClaude,
  FakeClock,
  FakeGit,
  FakeNotifier,
  FakeOpener,
  type Harness,
  makeHarness,
  silentLog,
} from "./fakes.ts"

const SID = "ffffffff-0000-4000-8000-0000000000f1"
const base = { session_id: SID, cwd: "/work/x", permission_mode: "default" }
const ev = (event: string, payload: Record<string, unknown>) =>
  envelope(event, { ...base, ...payload })
const bash = { command: "rm -rf build" }

const homes: string[] = []
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})
const dbFile = () => {
  const dir = mkdtempSync("/tmp/si-rs-")
  homes.push(dir)
  return join(dir, "inbox.db")
}

type Mode = "permissionRequest" | "preToolUse"
const start = async (mode: Mode) => {
  const file = dbFile()
  const a = makeHarness({ dbFile: file, settings: { "holds.via": mode } })
  const pre = await a.engine.ingest(
    "PreToolUse",
    ev("PreToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: bash }),
  )
  const r =
    mode === "preToolUse"
      ? pre.requestId
      : (
          await a.engine.ingest(
            "PermissionRequest",
            ev("PermissionRequest", { tool_name: "Bash", tool_input: bash }),
          )
        ).requestId
  expect(r).not.toBeNull()
  // Killed: nothing ran on the way down, and the hook's poll went with it.
  a.engine.deps.db.close()
  // The new engine (same clock time) counts every recovered live request as polled at startup.
  const b = makeHarness({ dbFile: file, settings: { "holds.via": mode } })
  return { b, requestId: r as string }
}
const item = (h: Harness) =>
  h.engine.store.one<ItemRow>("SELECT * FROM attention_items WHERE kind = 'permission'") as ItemRow
const approval = (h: Harness) =>
  h.engine.store.one<ApprovalRow>("SELECT * FROM approvals") as ApprovalRow
const notes = (h: Harness) =>
  h.engine.store
    .all<NotificationRow>("SELECT * FROM notifications ORDER BY created_at, rowid")
    .map((n) => [n.state, JSON.parse(n.actions_json), n.body])

describe("restart with a live request", () => {
  for (const mode of ["permissionRequest", "preToolUse"] as const) {
    test(`${mode}: the hook reconnects within the window and the decision is delivered`, async () => {
      const { b, requestId } = await start(mode)
      b.clock.advance(10_000)
      b.engine.tick()
      expect(approval(b).live).toBe(1)
      const waiting = b.engine.waitDecision(requestId, 30)
      b.clock.advance(30_000)
      b.engine.tick()
      expect(approval(b).live).toBe(1) // a poll is attached: never lapsed
      b.engine.decide(item(b).id, "allow", null)
      expect((await waiting).decision).toBe("allow")
      expect(item(b).state).toBe("answered")
    })

    test(`${mode}: no hook came back: lapsed after 20 s, visible, and decide answers 409`, async () => {
      const { b } = await start(mode)
      b.clock.advance(20_000)
      b.engine.tick()
      expect(approval(b).live).toBe(1)
      b.clock.advance(1_000)
      b.engine.tick()
      expect(approval(b)).toMatchObject({ live: 0, decision: "ask" })
      expect(item(b).state).toBe("open")
      expect(b.engine.snapshot().counts.needsYou).toBe(1)
      const last = notes(b).at(-1)
      expect(last?.[0]).toBe("posted")
      expect(last?.[1]).toEqual(["open"])
      expect(String(last?.[2])).toStartWith(STILL_WAITING_PREFIX)
      expect(
        b.engine.store.one("SELECT 1 AS x FROM events WHERE hook = 'daemon:hold-orphaned'"),
      ).not.toBeNull()
      let err: unknown = null
      try {
        b.engine.decide(item(b).id, "allow", null)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(ApiFailure)
      expect((err as ApiFailure).status).toBe(409)
      expect((err as ApiFailure).message).toBe(ANSWER_IN_CLAUDE)
      // Claude's own prompt still ends it the usual way.
      await b.engine.ingest(
        "PostToolUse",
        ev("PostToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: bash }),
      )
      expect(item(b).state).toBe("resolved")
    })

    test(`${mode}: decide before the tick noticed: lapse first, then 409`, async () => {
      const { b } = await start(mode)
      b.clock.advance(25_000)
      expect(() => b.engine.decide(item(b).id, "allow", null)).toThrow(ANSWER_IN_CLAUDE)
      expect(approval(b)).toMatchObject({ live: 0, decision: "ask" })
      expect(item(b).state).toBe("open")
    })
  }

  test("a slow ingest the hook gave up on: Allow from the inbox doesn't succeed into the void", async () => {
    const h = makeHarness()
    await h.engine.ingest(
      "PermissionRequest",
      ev("PermissionRequest", { tool_name: "Bash", tool_input: bash }),
    )
    // The hook's 500 ms ingest timeout fired; it never polls.
    h.clock.advance(21_000)
    expect(() => h.engine.decide(item(h).id, "allow", null)).toThrow(ANSWER_IN_CLAUDE)
    expect(item(h).state).toBe("open")
  })
})

describe("graceful stop (real daemon)", () => {
  test("closing the socket mid-poll resolves nothing; the row stays live", async () => {
    const home = mkdtempSync("/tmp/si-rs-")
    homes.push(home)
    const claudeDir = mkdtempSync("/tmp/si-rs-c-")
    homes.push(claudeDir)
    const svc = {
      clock: new FakeClock(),
      git: new FakeGit(),
      claude: new FakeClaude(),
      notifier: new FakeNotifier(),
      opener: new FakeOpener(),
      log: silentLog,
    }
    const d = await startDaemon({ home, port: 0, uiDir: home, claudeConfigDir: claudeDir }, svc)
    const ingest = await fetch(`http://localhost${Routes.hookIngest("PermissionRequest")}`, {
      unix: d.socketPath,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ev("PermissionRequest", { tool_name: "Bash", tool_input: bash })),
    }).then((r) => r.json() as Promise<{ requestId: string | null }>)
    expect(ingest.requestId).not.toBeNull()
    const polling = fetch(`http://localhost${Routes.hookDecision(ingest.requestId ?? "", 30)}`, {
      unix: d.socketPath,
    }).catch(() => null)
    await Bun.sleep(50)
    await d.stop()
    await polling
    const db = openDb(join(home, "inbox.db"))
    const a = db.query("SELECT live, decision FROM approvals").get()
    const i = db.query("SELECT state FROM attention_items").get()
    const answered = db
      .query("SELECT COUNT(*) AS n FROM events WHERE hook = 'daemon:answered-in-claude'")
      .get()
    db.close()
    expect(a).toEqual({ live: 1, decision: null })
    expect(i).toEqual({ state: "open" })
    expect(answered).toEqual({ n: 0 })
  })
})
