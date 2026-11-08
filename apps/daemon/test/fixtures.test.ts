import { describe, expect, test } from "bun:test"
import type { ApprovalRow, ItemRow, NotificationRow } from "../src/store.ts"
import { FakeGit, type Harness, makeHarness } from "./fakes.ts"
import { type Fixture, loadFixtures, replay } from "./replay.ts"

const rows = (h: Harness) => ({
  items: h.engine.store.all<ItemRow>("SELECT * FROM attention_items ORDER BY created_at"),
  notifications: h.engine.store.all<NotificationRow>(
    "SELECT * FROM notifications ORDER BY created_at",
  ),
  approvals: h.engine.store.all<ApprovalRow>("SELECT * FROM approvals"),
  events: h.engine.store.all<{ seq: number; hook: string; decode_error: string | null }>(
    "SELECT seq, hook, decode_error FROM events ORDER BY seq",
  ),
})

const synthetic = new Map(loadFixtures("synthetic").map((f) => [f.name, f]))
const fx = (name: string): Fixture => {
  const f = synthetic.get(name)
  if (!f) throw new Error(`missing fixtures/synthetic/${name}.jsonl`)
  return f
}

describe("synthetic fixture replay", () => {
  test("question via AskUserQuestion → held, answered through the hook, confirmed", async () => {
    const h = makeHarness()
    const r = await replay(h, fx("question"))
    const { items, notifications, approvals } = rows(h)
    expect(r.requestIds).toHaveLength(1)
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe("question")
    expect(items[0]?.state).toBe("resolved")
    expect(notifications).toHaveLength(1)
    expect(JSON.parse(notifications[0]?.actions_json ?? "[]")).toEqual(["answer", "open"])
    const a = approvals[0] as ApprovalRow
    expect(a.decision).toBe("allow")
    const updated = JSON.parse(a.updated_input_json ?? "{}")
    expect(updated.answers).toEqual({
      "Which integration tests should I run before opening the PR?": "Only *Usom* tests",
      "How many retries on a 5xx before the breaker counts it as a failure?": "4",
    })
    expect(updated.questions).toHaveLength(2) // original tool_input preserved
    const decision = await h.engine.waitDecision(a.hook_request_id, 0)
    expect(decision.decision).toBe("allow")
    const s = h.engine.snapshot().sessions[0]
    expect(s?.runtime).toBe("desktop")
    expect(s?.hostSessionId).toBe("local_aaaa-1111")
    expect(s?.title).toBe("Generated Title")
    expect(h.claude.titles).toHaveLength(1)
    expect(h.engine.answerModeFor("desktop")).toBe("updatedInput")
  })

  test("permission hold → allow → PostToolUse resolves", async () => {
    const h = makeHarness()
    const r = await replay(h, fx("permission-allow"))
    const { items, notifications, approvals } = rows(h)
    expect(r.requestIds).toHaveLength(1)
    expect(items.map((i) => [i.kind, i.state])).toEqual([["permission", "resolved"]])
    expect(items[0]?.summary).toBe("Wants to run bun run migrate")
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.critical).toBe(1)
    expect(JSON.parse(notifications[0]?.actions_json ?? "[]")).toEqual(["allow", "deny", "open"])
    expect(approvals[0]?.decision).toBe("allow")
    expect(h.notifier.posted).toHaveLength(1) // no shell connected ⇒ osascript fallback
  })

  test("permission timeout → expired, decision ask", async () => {
    const h = makeHarness()
    const r = await replay(h, fx("permission-timeout"))
    const { items, approvals } = rows(h)
    expect(items[0]?.state).toBe("expired")
    expect(approvals[0]?.decision).toBe("ask")
    expect(approvals[0]?.live).toBe(0)
    expect((await h.engine.waitDecision(r.requestIds[0] ?? "", 5)).decision).toBe("ask")
  })

  test("clean stop → review, one quiet grouped notification after the window", async () => {
    const h = makeHarness()
    await replay(h, fx("review"))
    const { items, notifications } = rows(h)
    expect(items.map((i) => [i.kind, i.state])).toEqual([["review", "open"]])
    expect(items[0]?.summary).toBe("Fixed rounding in receipt totals. All 42 tests pass.")
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.critical).toBe(0)
    expect(h.engine.snapshot().counts).toMatchObject({ review: 1, needsYou: 0 })
  })

  test("errored stop → failed", async () => {
    const h = makeHarness()
    await replay(h, fx("failed"))
    const { items, notifications } = rows(h)
    expect(items.map((i) => [i.kind, i.state])).toEqual([["failed", "open"]])
    expect(notifications).toHaveLength(1)
  })

  test("subagent tree", async () => {
    const h = makeHarness()
    await replay(h, fx("subagents"))
    const agents = h.engine.snapshot().agents
    const sid = "66666666-6666-4666-8666-666666666666"
    expect(agents.map((a) => [a.id, a.name, a.parentAgentId, a.state])).toEqual([
      [`${sid}:main`, "main", null, "running"],
      [`${sid}:ag1`, "Explore", `${sid}:main`, "done"],
      [`${sid}:ag2`, "code-reviewer", `${sid}:main`, "running"],
    ])
    expect(rows(h).items).toHaveLength(0)
    const tl = h.engine.timeline(sid)
    expect(tl.find((t) => t.hook === "PostToolUse")?.agentId).toBe(`${sid}:ag1`)
  })

  test("routine activity makes no items and no notifications; junk is stored", async () => {
    const h = makeHarness()
    const r = await replay(h, fx("routine"))
    const { items, notifications, events } = rows(h)
    expect(r.requestIds).toHaveLength(0)
    expect(items).toHaveLength(0)
    expect(notifications).toHaveLength(0)
    expect(events.some((e) => e.hook === "FutureHookEvent")).toBe(true)
    expect(events.filter((e) => e.decode_error !== null)).toHaveLength(1)
    // seq is monotonic
    const seqs = events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  test("snooze → wake notifies once", async () => {
    const h = makeHarness()
    await replay(h, fx("snooze"))
    const { items, notifications } = rows(h)
    expect(items.map((i) => [i.kind, i.state])).toEqual([["question", "open"]])
    expect(items[0]?.unread).toBe(1)
    expect(notifications).toHaveLength(2) // the original + exactly one on wake
  })
})

describe("recorded fixture replay (fixtures/recorded, from the spike)", () => {
  const recorded = loadFixtures("recorded")
  test("loader tolerates a missing/empty dir", () => {
    expect(Array.isArray(recorded)).toBe(true)
  })
  for (const f of recorded) {
    test(`${f.name} replays without decode failures`, async () => {
      const git = new FakeGit({
        "/private/tmp/si-spike-a-wt": {
          root: "/private/tmp/si-spike-a",
          worktree: "/private/tmp/si-spike-a-wt",
          branch: "wt1",
        },
      })
      const h = makeHarness({ git })
      await replay(h, f)
      const { events, notifications } = rows(h)
      expect(events.filter((e) => e.decode_error !== null)).toEqual([])
      expect(events.length).toBeGreaterThanOrEqual(f.steps.filter((s) => s.kind === "hook").length)
      expect(notifications).toHaveLength(0) // none of the recorded sessions asked anything
      const snap = h.engine.snapshot()
      expect(snap.sessions.length).toBeGreaterThan(0)
      if (f.name === "worktree") {
        expect(snap.projects[0]?.rootPath).toBe("/private/tmp/si-spike-a")
        expect(snap.sessions[0]?.worktree).toBe("/private/tmp/si-spike-a-wt")
      }
    })
  }

  test("resume -p keeps the original runtime and confirms an answered reply", async () => {
    const h = makeHarness()
    const sid = "c1dc349a-426d-4435-8442-119ae7697f9a"
    const base = { session_id: sid, cwd: "/private/tmp/si-spike-a" }
    const desktop = { entrypoint: "claude-desktop", hostSessionId: "local_x1", claudePid: 1 }
    await h.engine.ingest("SessionStart", {
      event: "SessionStart",
      payload: { ...base, hook_event_name: "SessionStart", source: "startup" },
      env: desktop,
      sentAt: 0,
    })
    await h.engine.ingest("Stop", {
      event: "Stop",
      payload: { ...base, hook_event_name: "Stop" },
      env: desktop,
      sentAt: 0,
    })
    h.clock.advance(31_000)
    h.engine.tick()
    const review = h.engine.snapshot().items[0]
    expect(review?.kind).toBe("review")
    h.engine.reply(review?.id ?? "", "k1", "please also update the docs")
    await h.engine.idle()
    expect(h.claude.resumes).toEqual([
      { sessionId: sid, cwd: "/private/tmp/si-spike-a", body: "please also update the docs" },
    ])
    const resumed = f("session-resume")
    if (resumed) await replay(h, resumed)
    else
      await h.engine.ingest("SessionStart", {
        event: "SessionStart",
        payload: { ...base, hook_event_name: "SessionStart", source: "resume" },
        env: { entrypoint: "sdk-cli", hostSessionId: null, claudePid: 2 },
        sentAt: 0,
      })
    const snap = h.engine.snapshot()
    expect(snap.sessions[0]?.runtime).toBe("desktop")
    expect(snap.sessions[0]?.hostSessionId).toBe("local_x1")
    expect(snap.items.find((i) => i.id === review?.id)?.state).toBe("resolved")
  })
  const f = (name: string) => recorded.find((r) => r.name === name)
})
