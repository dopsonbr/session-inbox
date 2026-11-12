/** A hold whose budget lapsed stays in "needs you" as Claude's own prompt (D-073). */
import { describe, expect, test } from "bun:test"
import { ANSWER_IN_CLAUDE } from "../src/engine.ts"
import type { NotificationRow } from "../src/store.ts"
import { envelope, type Harness, makeClassicHarness as makeHarness } from "./fakes.ts"

const SID = "eeeeeeee-0000-4000-8000-0000000000e1"
const base = { session_id: SID, cwd: "/work/x", permission_mode: "default" }
const ev = (event: string, payload: Record<string, unknown>) =>
  envelope(event, { ...base, ...payload })
const notes = (h: Harness) =>
  h.engine.store
    .all<NotificationRow>("SELECT * FROM notifications ORDER BY created_at, rowid")
    .map((n) => [n.state, JSON.parse(n.actions_json), n.body])
const items = (h: Harness) => h.engine.snapshot().items.map((i) => [i.kind, i.state, i.live])

const holdBash = (h: Harness) =>
  h.engine.ingest(
    "PreToolUse",
    ev("PreToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "rm x" } }),
  )
const lapse = (h: Harness) => {
  h.clock.advance(120_001)
  h.engine.tick()
}
const QUESTION = { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] }

describe("lapsed hold (D-073)", () => {
  test("lapse through the hook's own poll does the same as the timer", async () => {
    const h = makeHarness()
    const r = await holdBash(h)
    h.clock.advance(120_001)
    expect((await h.engine.waitDecision(r.requestId ?? "", 0)).decision).toBe("ask")
    expect(items(h)).toEqual([["permission", "open", false]])
    expect(notes(h).map((n) => n[0])).toEqual(["cleared", "posted"])
  })

  test("a user decision or Open in Claude still answers it; nothing replaces the notification", async () => {
    for (const d of ["allow", "deny"] as const) {
      const h = makeHarness()
      await holdBash(h)
      h.engine.decide(h.engine.snapshot().items[0]?.id ?? "", d, null)
      expect(items(h)).toEqual([["permission", "answered", false]])
      expect(notes(h)).toHaveLength(1)
    }
    const h = makeHarness()
    await holdBash(h)
    await h.engine.open(h.engine.snapshot().items[0]?.id ?? "")
    expect(items(h)).toEqual([["permission", "answered", false]])
    expect(notes(h)).toHaveLength(1)
    // Answered by "Open in Claude", not waiting: activity confirms it as before.
    await h.engine.ingest("Stop", ev("Stop", {}))
    expect(items(h)[0]).toEqual(["permission", "resolved", false])
  })

  test("opening the session (no item selected) releases a live hold first (C-032)", async () => {
    const h = makeHarness()
    await holdBash(h)
    expect(items(h)).toEqual([["permission", "open", true]])
    const { url } = await h.engine.openSession(SID)
    expect(items(h)).toEqual([["permission", "answered", false]])
    expect(url).toBe(`claude://resume?session=${SID}`)
    expect(h.opener.opened.at(-1)).toBe(url ?? "")
    expect(h.opener.copied.at(-1)).toContain(`claude --resume '${SID}'`)
  })

  test("Stop, a typed prompt or SessionEnd ends it", async () => {
    for (const [event, payload] of [
      ["Stop", {}],
      ["UserPromptSubmit", { prompt: "go on" }],
      ["SessionEnd", { reason: "other" }],
    ] as const) {
      const h = makeHarness()
      await holdBash(h)
      lapse(h)
      await h.engine.ingest(event, ev(event, payload))
      expect(items(h).find(([k]) => k === "permission")).toEqual(["permission", "resolved", false])
    }
  })

  test("snooze, wake and dismiss still work; the wake notification is Open-only", async () => {
    const h = makeHarness()
    await holdBash(h)
    lapse(h)
    const id = h.engine.snapshot().items[0]?.id ?? ""
    h.engine.snooze(id, h.clock.now() + 60_000)
    expect(items(h)).toEqual([["permission", "snoozed", false]])
    h.clock.advance(60_001)
    h.engine.tick()
    expect(items(h)).toEqual([["permission", "open", false]])
    expect(notes(h).at(-1)).toEqual([
      "posted",
      ["open"],
      "Still waiting in Claude: Wants to run rm x",
    ])
    h.engine.dismiss(id)
    expect(items(h)).toEqual([["permission", "dismissed", false]])
  })

  test("a reply can't go through --resume into a session showing its own prompt", async () => {
    const h = makeHarness()
    await holdBash(h)
    lapse(h)
    const id = h.engine.snapshot().items[0]?.id ?? ""
    expect(h.engine.itemDetail(id).replyUnavailable).toBe(ANSWER_IN_CLAUDE)
    expect(() => h.engine.reply(id, "k1", "use trash instead")).toThrow(ANSWER_IN_CLAUDE)
    expect(h.claude.resumes).toHaveLength(0)
  })

  test("AskUserQuestion: the question stays open, its Answer notification becomes Open-only", async () => {
    const h = makeHarness()
    await h.engine.ingest(
      "PreToolUse",
      ev("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q1", tool_input: QUESTION }),
    )
    lapse(h)
    expect(items(h)).toEqual([["question", "open", false]])
    expect(notes(h)).toEqual([
      ["cleared", ["answer", "open"], "Which?"],
      ["posted", ["open"], "Still waiting in Claude: Which?"],
    ])
    const id = h.engine.snapshot().items[0]?.id ?? ""
    // Answering here would need --resume into a session that is showing the question: refused.
    expect(() => h.engine.answers(id, "k1", [{ idx: 0, selected: ["A"] }])).toThrow(
      ANSWER_IN_CLAUDE,
    )
    expect(h.engine.store.questions(id).every((q) => q.answer_json === null)).toBe(true)
    // Claude's own prompt for it: nothing new. Its PostToolUse ends it.
    await h.engine.ingest(
      "PermissionRequest",
      ev("PermissionRequest", { tool_name: "AskUserQuestion", tool_input: QUESTION }),
    )
    await h.engine.ingest(
      "Notification",
      ev("Notification", {
        notification_type: "permission_prompt",
        message: "Claude needs your permission to use AskUserQuestion",
      }),
    )
    expect(items(h)).toEqual([["question", "open", false]])
    expect(notes(h)).toHaveLength(2)
    await h.engine.ingest(
      "PostToolUse",
      ev("PostToolUse", {
        tool_name: "AskUserQuestion",
        tool_use_id: "q1",
        tool_input: QUESTION,
        tool_response: { answers: { "Which?": "B" } },
      }),
    )
    expect(items(h)).toEqual([["question", "resolved", false]])
  })

  test("mute and holds-off still release and expire (the user turned the inbox away)", async () => {
    const h = makeHarness()
    await holdBash(h)
    h.engine.mute(h.engine.snapshot().projects[0]?.id ?? "", true)
    expect(items(h)).toEqual([["permission", "expired", false]])
    const h2 = makeHarness()
    await holdBash(h2)
    h2.engine.updateSettings({ "holds.enabled": false })
    expect(items(h2)).toEqual([["permission", "expired", false]])
  })
})

describe("observed prompts count like live ones", () => {
  test("an observe-mode PermissionRequest item is in needs you and on the badge", async () => {
    const h = makeHarness()
    const badges: number[] = []
    const publish = h.engine.hub.publish.bind(h.engine.hub)
    h.engine.hub.publish = (m) => {
      if (m._tag === "badge") badges.push(m.count)
      publish(m)
    }
    await h.engine.ingest(
      "PermissionRequest",
      ev("PermissionRequest", { tool_name: "Read", tool_input: { file_path: "/etc/hosts" } }),
    )
    const snap = h.engine.snapshot()
    expect(snap.items.map((i) => [i.queue, i.live])).toEqual([["needs-you", false]])
    expect(snap.counts.needsYou).toBe(1)
    expect(badges).toEqual([1])
  })
})
