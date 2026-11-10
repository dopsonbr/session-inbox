/**
 * Calls that run long (D-099, C-030): a PreToolUse with no PostToolUse for `stuck.afterMs`
 * raises a `stuck` item in Review; the call ending, the turn ending or Done settles it.
 */
import { describe, expect, test } from "bun:test"
import { STUCK_NO_REPLY } from "../src/engine.ts"
import type { NotificationRow } from "../src/store.ts"
import { attachPoll, envelope, type Harness, makeHarness } from "./fakes.ts"

const SID = "ffffffff-0000-4000-8000-0000000000f1"
const MIN = 60_000
const ev = (event: string, payload: Record<string, unknown> = {}) =>
  envelope(event, { session_id: SID, cwd: "/work/app", permission_mode: "default", ...payload })
const bash = (command: string, extra: Record<string, unknown> = {}) => ({
  tool_name: "Bash",
  tool_input: { command, ...extra },
})
const pre = (h: Harness, id: string, call: Record<string, unknown>, agent?: string) =>
  h.engine.ingest(
    "PreToolUse",
    ev("PreToolUse", { tool_use_id: id, ...call, ...(agent ? { agent_id: agent } : {}) }),
  )
const post = (h: Harness, id: string, call: Record<string, unknown>, event = "PostToolUse") =>
  h.engine.ingest(event, ev(event, { tool_use_id: id, ...call }))
const wait = (h: Harness, ms: number) => {
  h.clock.advance(ms)
  h.engine.tick()
}
const stuck = (h: Harness) => h.engine.snapshot().items.filter((i) => i.kind === "stuck")
const inFlight = (h: Harness) =>
  h.engine.store
    .all<{ tool_use_id: string }>("SELECT tool_use_id FROM tool_calls ORDER BY tool_use_id")
    .map((r) => r.tool_use_id)

const start = async (settings = {}) => {
  const h = makeHarness({ settings })
  await h.engine.ingest("UserPromptSubmit", ev("UserPromptSubmit", { prompt: "Start the app" }))
  return h
}

describe("stuck calls (D-099)", () => {
  test("a call still running after the limit lands in Review, once, with how long", async () => {
    const h = await start()
    const startedAt = h.clock.now()
    await pre(h, "t1", bash("npm run dev"))
    wait(h, 4 * MIN)
    expect(stuck(h)).toEqual([])
    wait(h, 2 * MIN)

    const [item] = stuck(h)
    expect(item?.state).toBe("open")
    expect(item?.queue).toBe("review")
    expect(item?.summary).toBe("Running npm run dev")
    expect(item?.runningSince).toBe(startedAt)
    expect(h.engine.snapshot().counts).toMatchObject({ needsYou: 0, review: 1, working: 1 })

    const sent = h.engine.store.all<NotificationRow>("SELECT * FROM notifications")
    expect(sent).toHaveLength(1)
    expect(sent[0]?.body).toBe("Running npm run dev for 6 min")
    expect(JSON.parse(sent[0]?.actions_json ?? "[]")).toEqual(["open"])
    expect(sent[0]?.critical).toBe(0)

    const detail = h.engine.itemDetail(item?.id ?? "")
    expect(detail.item.runningSince).toBe(startedAt)
    expect(detail.running?.tool).toBe("Bash")
    expect(detail.running?.since).toBe(startedAt)
    expect(detail.running?.preview).toMatchObject({ _tag: "command", command: "npm run dev" })
    expect(detail.replyUnavailable).toBe(STUCK_NO_REPLY)
    expect(detail.timeline.find((e) => e.isSource)?.text).toBe("Still running npm run dev")

    // Later ticks neither repeat the item nor the notification.
    wait(h, 10 * MIN)
    expect(stuck(h)).toHaveLength(1)
    expect(h.engine.store.all("SELECT 1 FROM notifications")).toHaveLength(1)
  })

  test("the call ending resolves the item and takes its notification back", async () => {
    const h = await start()
    await pre(h, "t1", bash("npm run dev"))
    wait(h, 6 * MIN)
    const id = stuck(h)[0]?.id ?? ""
    await post(h, "t1", bash("npm run dev"))
    expect(h.engine.itemDetail(id).item.state).toBe("resolved")
    expect(h.engine.itemDetail(id).item.runningSince).toBeUndefined()
    // History still shows which call it was.
    expect(h.engine.itemDetail(id).running?.tool).toBe("Bash")
    expect(h.engine.history({ kind: "stuck" }).entries.map((e) => e.outcome)).toEqual(["moved-on"])
    expect(inFlight(h)).toEqual([])
    wait(h, 10 * MIN)
    expect(stuck(h).filter((i) => i.state === "open")).toEqual([])
  })

  test("a call that failed or timed out was never stuck", async () => {
    const h = await start()
    await pre(h, "t1", bash("npm test"))
    h.clock.advance(2 * MIN)
    await post(h, "t1", bash("npm test"), "PostToolUseFailure")
    expect(inFlight(h)).toEqual([])
    wait(h, 20 * MIN)
    expect(stuck(h)).toEqual([])
  })

  test("Done is the answer for that call; the end of the turn settles the rest", async () => {
    const h = await start()
    await pre(h, "t1", bash("npm run dev"))
    wait(h, 6 * MIN)
    h.engine.dismiss(stuck(h)[0]?.id ?? "")
    wait(h, 30 * MIN)
    expect(stuck(h).map((i) => i.state)).toEqual(["dismissed"])

    await pre(h, "t2", bash("sleep 9999"))
    wait(h, 6 * MIN)
    const second = stuck(h).find((i) => i.state === "open")
    expect(second?.summary).toBe("Running sleep 9999")
    await h.engine.ingest("Stop", ev("Stop", { last_assistant_message: "Stopped." }))
    expect(h.engine.itemDetail(second?.id ?? "").item.state).toBe("resolved")
    expect(inFlight(h)).toEqual([])
  })

  test("waiting on your answer isn't a hang; the clock starts when you answer", async () => {
    const h = await start()
    const call = bash("make deploy")
    await pre(h, "t1", call)
    const asked = await h.engine.ingest("PermissionRequest", ev("PermissionRequest", call))
    const detach = attachPoll(h.engine, asked.requestId)
    wait(h, 8 * MIN)
    expect(stuck(h)).toEqual([])

    const permission = h.engine.snapshot().items.find((i) => i.kind === "permission")
    const answeredAt = h.clock.now()
    h.engine.decide(permission?.id ?? "", "allow", "k1")
    detach()
    wait(h, 4 * MIN)
    expect(stuck(h)).toEqual([])
    wait(h, 2 * MIN)
    expect(stuck(h)[0]?.runningSince).toBe(answeredAt)
  })

  test("a call the agent left behind (denied in Claude) is over once it starts the next one", async () => {
    const h = await start()
    await pre(h, "denied", bash("rm -rf build"))
    h.clock.advance(2 * MIN)
    await pre(h, "next", bash("ls"))
    expect(inFlight(h)).toEqual(["next"])
    await post(h, "next", bash("ls"))
    wait(h, 30 * MIN)
    expect(stuck(h)).toEqual([])
  })

  test("in a parallel batch, the one that never returns is the stuck one", async () => {
    const h = await start()
    await pre(h, "a", bash("npm run dev"))
    await pre(h, "b", { tool_name: "Read", tool_input: { file_path: "/work/app/package.json" } })
    await post(h, "b", { tool_name: "Read", tool_input: { file_path: "/work/app/package.json" } })
    wait(h, 6 * MIN)
    expect(stuck(h).map((i) => i.summary)).toEqual(["Running npm run dev"])
  })

  test("subagents, questions and background commands are never flagged", async () => {
    const h = await start()
    await pre(h, "task", { tool_name: "Task", tool_input: { prompt: "explore" } })
    await pre(h, "bg", bash("npm run dev", { run_in_background: true }))
    await pre(h, "plan", { tool_name: "ExitPlanMode", tool_input: {} })
    expect(inFlight(h)).toEqual([])
    wait(h, 30 * MIN)
    expect(stuck(h)).toEqual([])
  })

  test("a subagent's stuck call is settled when the subagent stops", async () => {
    const h = await start()
    await pre(
      h,
      "s1",
      { tool_name: "WebFetch", tool_input: { url: "https://example.com/slow" } },
      "agent-1",
    )
    wait(h, 6 * MIN)
    expect(stuck(h).map((i) => i.summary)).toEqual(["Fetching https://example.com/slow"])
    await h.engine.ingest(
      "SubagentStop",
      ev("SubagentStop", { agent_id: "agent-1", agent_type: "Explore" }),
    )
    expect(stuck(h).map((i) => i.state)).toEqual(["resolved"])
  })

  test("the limit and the switch are settings", async () => {
    const off = await start({ "stuck.enabled": false })
    await pre(off, "t1", bash("npm run dev"))
    wait(off, 60 * MIN)
    expect(stuck(off)).toEqual([])

    const quick = await start()
    quick.engine.updateSettings({ "stuck.afterMs": 1000 })
    expect(quick.engine.settings["stuck.afterMs"]).toBe(60_000)
    await pre(quick, "t1", bash("npm run dev"))
    wait(quick, 61_000)
    expect(stuck(quick)).toHaveLength(1)
  })
})
