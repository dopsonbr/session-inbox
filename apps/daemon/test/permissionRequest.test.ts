/**
 * Claude's PermissionRequest hook (D-068..D-071): observe mode (classic holds, or holds off) and the
 * decide mode (`holds.via: "permissionRequest"`, the default since D-074).
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { allowAlwaysPermissions, canonicalJson } from "../src/domain/permissionRequest.ts"
import type { ApprovalRow, ItemRow, NotificationRow } from "../src/store.ts"
import { envelope, type Harness, makeClassicHarness, makeHarness } from "./fakes.ts"
import { type Fixture, loadFixtures, replay } from "./replay.ts"

const synthetic = new Map(loadFixtures("synthetic").map((f) => [f.name, f]))
const fx = (name: string, steps?: number): Fixture => {
  const f = synthetic.get(name)
  if (!f) throw new Error(`missing fixtures/synthetic/${name}.jsonl`)
  return steps === undefined ? f : { ...f, steps: f.steps.slice(0, steps) }
}

const rows = (h: Harness) => ({
  items: h.engine.store.all<ItemRow>("SELECT * FROM attention_items ORDER BY created_at, rowid"),
  approvals: h.engine.store.all<ApprovalRow>("SELECT * FROM approvals"),
  notifications: h.engine.store.all<NotificationRow>(
    "SELECT * FROM notifications ORDER BY created_at, rowid",
  ),
  events: h.engine.store.all<{ hook: string; payload_json: string }>(
    "SELECT hook, payload_json FROM events ORDER BY seq",
  ),
})
const shape = (h: Harness) => rows(h).items.map((i) => [i.kind, i.state])
const actions = (n: NotificationRow | undefined) => JSON.parse(n?.actions_json ?? "[]")

const DECIDE = { "holds.via": "permissionRequest" as const }
const SID = "dddddddd-0000-4000-8000-0000000000d1"
const base = { session_id: SID, cwd: "/work/x", permission_mode: "default" }
const ev = (event: string, payload: Record<string, unknown>) =>
  envelope(event, { ...base, ...payload })
const bashInput = (command: string) => ({ command, description: `Run ${command}` })
const preBash = (id: string, command: string) =>
  ev("PreToolUse", { tool_name: "Bash", tool_use_id: id, tool_input: bashInput(command) })
const postBash = (id: string, command: string) =>
  ev("PostToolUse", { tool_name: "Bash", tool_use_id: id, tool_input: bashInput(command) })
const request = (tool: string, input: unknown, extra: Record<string, unknown> = {}) =>
  ev("PermissionRequest", { tool_name: tool, tool_input: input, ...extra })
const ADD_RULE = {
  type: "addRules",
  rules: [{ toolName: "Bash", ruleContent: "make deploy" }],
  behavior: "allow",
  destination: "localSettings",
}

describe("pure helpers", () => {
  test("canonicalJson ignores key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    )
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }))
  })
  test("allow-always echoes only allow addRules, never setMode or bypassPermissions", () => {
    const setMode = { type: "setMode", mode: "acceptEdits", destination: "session" }
    const bypass = { ...ADD_RULE, rules: [{ toolName: "Bash", ruleContent: "bypassPermissions" }] }
    const deny = { ...ADD_RULE, behavior: "deny" }
    const replace = { ...ADD_RULE, type: "replaceRules" }
    const dirs = { type: "addDirectories", directories: ["/etc"], destination: "session" }
    expect(allowAlwaysPermissions([setMode, ADD_RULE, bypass, deny, replace, dirs])).toEqual([
      ADD_RULE,
    ])
    expect(allowAlwaysPermissions("nope")).toEqual([])
    expect(allowAlwaysPermissions(undefined)).toEqual([])
  })
})

describe("observe mode (classic holds, or holds off): Claude's prompt shows up at once, never held", () => {
  test("item at once with the preview; the Notification 6 s later refreshes; PostToolUse resolves", async () => {
    const h = makeClassicHarness()
    const r = await replay(h, fx("permission-request-observe", 3))
    expect(r.requestIds).toHaveLength(0)
    let { items, approvals, notifications } = rows(h)
    expect(items.map((i) => [i.kind, i.state, i.summary])).toEqual([
      ["permission", "open", "Wants to use Read"],
    ])
    expect(approvals[0]?.via).toBe("permissionRequest")
    expect(approvals[0]?.live).toBe(0)
    expect(approvals[0]?.decision).toBeNull()
    expect(JSON.parse(approvals[0]?.suggestions_json ?? "null")).toEqual([
      { type: "addDirectories", directories: ["/etc"], destination: "session" },
    ])
    const detail = h.engine.itemDetail(items[0]?.id ?? "")
    expect(detail.approval?.via).toBe("permissionRequest")
    expect(detail.approval?.preview?._tag).toBe("generic")
    expect(detail.item.live).toBe(false)
    expect(notifications).toHaveLength(1)
    expect(actions(notifications[0])).toEqual(["open"])

    await replay(h, {
      ...fx("permission-request-observe"),
      steps: fx("permission-request-observe").steps.slice(3, 5),
    })
    ;({ items, notifications } = rows(h))
    expect(items.map((i) => [i.kind, i.state])).toEqual([["permission", "open"]])
    expect(notifications).toHaveLength(1)

    await replay(h, {
      ...fx("permission-request-observe"),
      steps: fx("permission-request-observe").steps.slice(5),
    })
    ;({ items, notifications } = rows(h))
    expect(items.map((i) => [i.kind, i.state])).toEqual([["permission", "resolved"]])
    expect(notifications[0]?.state).toBe("cleared")
    expect(h.engine.snapshot().counts.needsYou).toBe(0)
    expect(rows(h).events.some((e) => e.hook === "daemon:answered-in-claude")).toBe(true)
  })

  test("classic mode is unchanged: PreToolUse still holds, PermissionRequest never returns a request", async () => {
    const h = makeClassicHarness()
    const held = await h.engine.ingest("PreToolUse", preBash("t1", "rm -rf build"))
    expect(held.requestId).not.toBeNull()
    const pr = await h.engine.ingest("PermissionRequest", request("Read", { file_path: "/etc/x" }))
    expect(pr.requestId).toBeNull()
    expect(pr.holdMs).toBeUndefined()
  })

  test("after our own hold lapsed into Claude's prompt: no second item", async () => {
    const h = makeClassicHarness()
    await h.engine.ingest("PreToolUse", preBash("t1", "rm -rf build"))
    h.clock.advance(120_001)
    h.engine.tick()
    await h.engine.ingest("PermissionRequest", request("Bash", bashInput("rm -rf build")))
    expect(shape(h)).toEqual([["permission", "open"]])
  })

  test("observer channel: the PreToolUse item for the same call is refreshed, with the preview", async () => {
    const h = makeHarness({ settings: { "holds.enabled": false } })
    await h.engine.ingest("PreToolUse", preBash("t1", "rm -rf build"))
    await h.engine.ingest("PermissionRequest", request("Bash", bashInput("rm -rf build")))
    const { items, approvals, notifications } = rows(h)
    expect(items.map((i) => [i.kind, i.state])).toEqual([["permission", "open"]])
    expect(approvals.map((a) => [a.via, a.tool_use_id, a.live])).toEqual([
      ["permissionRequest", "t1", 0],
    ])
    expect(h.engine.itemDetail(items[0]?.id ?? "").approval?.preview?._tag).toBe("command")
    expect(notifications).toHaveLength(1)
    // Its own PostToolUse resolves it.
    await h.engine.ingest("PostToolUse", postBash("t1", "rm -rf build"))
    expect(shape(h)).toEqual([["permission", "resolved"]])
  })

  test("AskUserQuestion with the question item open: nothing new", async () => {
    const h = makeClassicHarness()
    const input = { questions: [{ question: "A?", options: [{ label: "x" }, { label: "y" }] }] }
    await h.engine.ingest(
      "PreToolUse",
      ev("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q1", tool_input: input }),
    )
    await h.engine.ingest("PermissionRequest", request("AskUserQuestion", input))
    expect(shape(h)).toEqual([["question", "open"]])
    expect(rows(h).approvals).toHaveLength(1)
    expect(rows(h).approvals[0]?.via).toBeNull()
  })

  test("muted project: stored, nothing opened", async () => {
    const h = makeClassicHarness()
    await h.engine.ingest("SessionStart", ev("SessionStart", { source: "startup" }))
    const project = h.engine.snapshot().projects[0]
    h.engine.mute(project?.id ?? "", true)
    const r = await h.engine.ingest("PermissionRequest", request("Read", { file_path: "/a" }))
    expect(r.requestId).toBeNull()
    expect(shape(h)).toEqual([])
    expect(rows(h).events.filter((e) => e.hook === "PermissionRequest")).toHaveLength(1)
  })

  test("other calls' activity doesn't resolve it; Stop does", async () => {
    const h = makeClassicHarness()
    await h.engine.ingest("PermissionRequest", request("Read", { file_path: "/etc/a" }))
    await h.engine.ingest("PreToolUse", preBash("t2", "ls"))
    await h.engine.ingest("PostToolUse", postBash("t2", "ls"))
    expect(shape(h)).toEqual([["permission", "open"]])
    await h.engine.ingest("Stop", ev("Stop", {}))
    expect(shape(h)[0]).toEqual(["permission", "resolved"])
  })
})

describe("decide mode (holds.via = permissionRequest, the default since D-074)", () => {
  const live = (h: Harness) => h.engine.snapshot().items.find((i) => i.live)
  const decideReq = async (h: Harness, id: string, command: string, extra = {}) => {
    await h.engine.ingest("PreToolUse", preBash(id, command))
    return h.engine.ingest("PermissionRequest", request("Bash", bashInput(command), extra))
  }

  test("fixture: allow through the hook, tool_use_id recovered, PostToolUse confirms", async () => {
    const h = makeHarness({ settings: DECIDE })
    const r = await replay(h, fx("permission-request-decide"))
    const { items, approvals, notifications } = rows(h)
    expect(r.requestIds).toHaveLength(1)
    expect(items.map((i) => [i.kind, i.state, i.summary])).toEqual([
      ["permission", "resolved", "Wants to run rm -rf node_modules"],
    ])
    expect(approvals[0]?.tool_use_id).toBe("tu_b9")
    expect(approvals[0]?.decision).toBe("allow")
    expect(actions(notifications[0])).toEqual(["allow", "deny", "open"])
    expect(await h.engine.waitDecision(r.requestIds[0] ?? "", 0)).toEqual({ decision: "allow" })
  })

  test("PreToolUse never holds, AskUserQuestion included; PermissionRequest holds with the budget", async () => {
    const h = makeHarness({ settings: DECIDE })
    const pre = await h.engine.ingest("PreToolUse", preBash("t1", "rm -rf build"))
    const q = await h.engine.ingest(
      "PreToolUse",
      ev("PreToolUse", {
        tool_name: "AskUserQuestion",
        tool_use_id: "q1",
        tool_input: { questions: [{ question: "A?", options: [{ label: "x" }] }] },
      }),
    )
    expect([pre.requestId, q.requestId]).toEqual([null, null])
    expect(shape(h)).toEqual([])
    const r = await h.engine.ingest("PermissionRequest", request("Bash", bashInput("rm -rf build")))
    expect(r.requestId).not.toBeNull()
    expect(r.holdMs).toBe(600_000)
    expect(live(h)?.kind).toBe("permission")
  })

  test("deny", async () => {
    const h = makeHarness({ settings: DECIDE })
    const r = await decideReq(h, "t1", "rm -rf build")
    h.engine.decide(live(h)?.id ?? "", "deny", null)
    expect(await h.engine.waitDecision(r.requestId ?? "", 0)).toEqual({
      decision: "deny",
      reason: "Denied by the user in Session Inbox.",
    })
  })

  test("allow-always with suggestions echoes them and writes nothing itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "si-pr-"))
    const h = makeHarness({ settings: DECIDE })
    await h.engine.ingest("PreToolUse", {
      ...preBash("t1", "make deploy"),
      payload: { ...preBash("t1", "make deploy").payload, cwd: dir },
    })
    const r = await h.engine.ingest("PermissionRequest", {
      ...request("Bash", bashInput("make deploy")),
      payload: {
        ...request("Bash", bashInput("make deploy")).payload,
        cwd: dir,
        permission_suggestions: [
          { type: "setMode", mode: "bypassPermissions", destination: "session" },
          ADD_RULE,
        ],
      },
    })
    h.engine.decide(live(h)?.id ?? "", "allow-always", null)
    expect(await h.engine.waitDecision(r.requestId ?? "", 0)).toEqual({
      decision: "allow",
      updatedPermissions: [ADD_RULE],
    })
    expect(existsSync(join(dir, ".claude", "settings.local.json"))).toBe(false)
  })

  test("allow-always without usable suggestions falls back to settings.local.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "si-pr-"))
    const h = makeHarness({ settings: DECIDE })
    const at = (e: ReturnType<typeof ev>) => ({ ...e, payload: { ...e.payload, cwd: dir } })
    await h.engine.ingest("PreToolUse", at(preBash("t1", "make deploy")))
    const r = await h.engine.ingest(
      "PermissionRequest",
      at(
        request("Bash", bashInput("make deploy"), {
          permission_suggestions: [
            { type: "setMode", mode: "acceptEdits", destination: "session" },
          ],
        }),
      ),
    )
    h.engine.decide(live(h)?.id ?? "", "allow-always", null)
    expect(await h.engine.waitDecision(r.requestId ?? "", 0)).toEqual({ decision: "allow" })
    const local = JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8"))
    expect(local.permissions.allow).toContain("Bash(make deploy)")
  })

  test("AskUserQuestion answers go back as allow + updatedInput", async () => {
    const h = makeHarness({ settings: DECIDE })
    const input = {
      questions: [{ question: "Which tests?", options: [{ label: "Unit" }, { label: "All" }] }],
    }
    await h.engine.ingest(
      "PreToolUse",
      ev("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "q1", tool_input: input }),
    )
    const r = await h.engine.ingest("PermissionRequest", request("AskUserQuestion", input))
    const item = live(h)
    expect([item?.kind, item?.questionCount]).toEqual(["question", 1])
    expect(actions(rows(h).notifications[0])).toEqual(["answer", "open"])
    h.engine.answers(item?.id ?? "", "k1", [{ idx: 0, selected: ["All"] }])
    const d = await h.engine.waitDecision(r.requestId ?? "", 0)
    expect(d.decision).toBe("allow")
    expect((d.updatedInput as { answers: unknown }).answers).toEqual({ "Which tests?": "All" })
    expect((d.updatedInput as { questions: unknown }).questions).toEqual(input.questions)
  })

  test("a reply to a live request is deny + the text as its message", async () => {
    const h = makeHarness({ settings: DECIDE })
    const r = await decideReq(h, "t1", "rm -rf build")
    h.engine.reply(live(h)?.id ?? "", "k1", "use git clean instead")
    expect(await h.engine.waitDecision(r.requestId ?? "", 0)).toEqual({
      decision: "deny",
      reason: "The user replied: use git clean instead",
    })
  })

  test("Open in Claude releases it: the hook prints nothing", async () => {
    const h = makeHarness({ settings: DECIDE })
    const r = await decideReq(h, "t1", "rm -rf build")
    await h.engine.open(live(h)?.id ?? "")
    expect(await h.engine.waitDecision(r.requestId ?? "", 0)).toEqual({ decision: "ask" })
  })

  test("budget lapse: the hook steps aside, the item stays open and non-live", async () => {
    const h = makeHarness({ settings: { ...DECIDE, "holds.requestBudgetMs": 60_000 } })
    const r = await decideReq(h, "t1", "rm -rf build")
    expect(r.holdMs).toBe(60_000)
    h.clock.advance(60_001)
    h.engine.tick()
    expect(await h.engine.waitDecision(r.requestId ?? "", 0)).toEqual({ decision: "ask" })
    const item = h.engine.snapshot().items[0]
    expect([item?.state, item?.live, item?.queue]).toEqual(["open", false, "needs-you"])
    expect(rows(h).notifications[0]?.state).toBe("cleared")
    expect(rows(h).approvals[0]?.decision).toBeNull()
    // Deciding now can't reach Claude.
    expect(() => h.engine.decide(item?.id ?? "", "allow", null)).toThrow()
    // Claude's prompt, answered there, ends it.
    await h.engine.ingest("PostToolUse", postBash("t1", "rm -rf build"))
    expect(shape(h)).toEqual([["permission", "resolved"]])
  })

  test("the hook's long-poll closing mid-wait = answered in Claude", async () => {
    const h = makeHarness({ settings: DECIDE })
    const r = await decideReq(h, "t1", "rm -rf build")
    const published: string[] = []
    const publish = h.engine.hub.publish.bind(h.engine.hub)
    h.engine.hub.publish = (m) => {
      published.push(m._tag)
      publish(m)
    }
    const ctrl = new AbortController()
    const waiting = h.engine.waitDecision(r.requestId ?? "", 30, ctrl.signal)
    await Bun.sleep(10)
    ctrl.abort()
    await waiting
    // Not at once: the hook gets 5 s to re-poll after a stall (D-080).
    expect(shape(h)).toEqual([["permission", "open"]])
    h.clock.advance(4_000)
    h.engine.tick()
    expect(shape(h)).toEqual([["permission", "open"]])
    h.clock.advance(1_000)
    h.engine.tick()
    expect(shape(h)).toEqual([["permission", "resolved"]])
    expect(rows(h).approvals[0]?.live).toBe(0)
    expect(rows(h).notifications[0]?.state).toBe("cleared")
    expect(h.engine.snapshot().counts.needsYou).toBe(0)
    expect(
      rows(h).events.some(
        (e) => e.hook === "daemon:answered-in-claude" && e.payload_json.includes("hook-closed"),
      ),
    ).toBe(true)
    expect(published).toContain("delta")
  })

  test("a poll that closes and is re-polled within 5 s stays live; a decision still lands", async () => {
    const h = makeHarness({ settings: DECIDE })
    const r = await decideReq(h, "t1", "rm -rf build")
    const ctrl = new AbortController()
    const first = h.engine.waitDecision(r.requestId ?? "", 30, ctrl.signal)
    await Bun.sleep(5)
    ctrl.abort()
    await first
    h.clock.advance(1_000)
    const again = h.engine.waitDecision(r.requestId ?? "", 30)
    h.clock.advance(10_000)
    h.engine.tick()
    expect(shape(h)).toEqual([["permission", "open"]])
    h.engine.decide(rows(h).items[0]?.id ?? "", "allow", null)
    expect((await again).decision).toBe("allow")
  })

  test("a graceful stop's closed polls change nothing", async () => {
    const h = makeHarness({ settings: DECIDE })
    const r = await decideReq(h, "t1", "rm -rf build")
    const ctrl = new AbortController()
    const waiting = h.engine.waitDecision(r.requestId ?? "", 30, ctrl.signal)
    await Bun.sleep(5)
    h.engine.stopping = true
    ctrl.abort()
    await waiting
    h.clock.advance(6_000)
    h.engine.tick()
    expect(h.engine.snapshot().items.map((i) => [i.state, i.live])).toEqual([["open", true]])
  })

  test("a PreToolUse hook's poll closing changes nothing (it may re-poll)", async () => {
    const h = makeClassicHarness()
    const r = await h.engine.ingest("PreToolUse", preBash("t1", "rm -rf build"))
    const ctrl = new AbortController()
    const waiting = h.engine.waitDecision(r.requestId ?? "", 30, ctrl.signal)
    await Bun.sleep(10)
    ctrl.abort()
    await waiting
    expect(h.engine.snapshot().items.map((i) => [i.state, i.live])).toEqual([["open", true]])
  })

  test("parallel calls: another call's PreToolUse, PermissionRequest and PostToolUse leave it alone", async () => {
    const h = makeHarness({ settings: DECIDE })
    const a = await decideReq(h, "ta", "make a")
    const b = await decideReq(h, "tb", "make b")
    expect(a.requestId).not.toBe(b.requestId)
    let items = h.engine.snapshot().items
    expect(items.map((i) => [i.summary, i.live])).toEqual([
      ["Wants to run make a", true],
      ["Wants to run make b", true],
    ])
    await h.engine.ingest("PreToolUse", preBash("tc", "ls"))
    await h.engine.ingest("PostToolUse", postBash("tc", "ls"))
    // A answered in Claude: only A goes.
    await h.engine.ingest("PostToolUse", postBash("ta", "make a"))
    items = h.engine.snapshot().items
    expect(items.map((i) => [i.summary, i.state, i.live])).toEqual([
      ["Wants to run make a", "resolved", false],
      ["Wants to run make b", "open", true],
    ])
    expect(await h.engine.waitDecision(a.requestId ?? "", 0)).toEqual({ decision: "ask" })
  })

  test("identical parallel calls get one item each", async () => {
    const h = makeHarness({ settings: DECIDE })
    await h.engine.ingest("PreToolUse", preBash("t1", "make"))
    await h.engine.ingest("PreToolUse", preBash("t2", "make"))
    await h.engine.ingest("PermissionRequest", request("Bash", bashInput("make")))
    await h.engine.ingest("PermissionRequest", request("Bash", bashInput("make")))
    expect(
      rows(h)
        .approvals.map((a) => a.tool_use_id)
        .sort(),
    ).toEqual(["t1", "t2"])
  })

  test("no PreToolUse to match (a tool outside the matcher): keyed by input, PostToolUse still resolves", async () => {
    const h = makeHarness({ settings: DECIDE })
    const r = await h.engine.ingest("PermissionRequest", request("Read", { file_path: "/etc/a" }))
    expect(r.requestId).not.toBeNull()
    expect(rows(h).approvals[0]?.tool_use_id).toBeNull()
    await h.engine.ingest(
      "PostToolUse",
      ev("PostToolUse", {
        tool_name: "Read",
        tool_use_id: "zz",
        tool_input: { file_path: "/etc/a" },
      }),
    )
    expect(shape(h)).toEqual([["permission", "resolved"]])
  })

  test("Stop, a typed prompt and SessionEnd end a live request", async () => {
    for (const [event, payload] of [
      ["Stop", {}],
      ["UserPromptSubmit", { prompt: "never mind" }],
      ["SessionEnd", { reason: "other" }],
    ] as const) {
      const h = makeHarness({ settings: DECIDE })
      const r = await decideReq(h, "t1", "rm -rf build")
      await h.engine.ingest(event, ev(event, payload))
      expect(shape(h).find(([k]) => k === "permission")).toEqual(["permission", "resolved"])
      expect(await h.engine.waitDecision(r.requestId ?? "", 0)).toEqual({ decision: "ask" })
    }
  })

  test("the Notification 6 s later doesn't add a second item", async () => {
    const h = makeHarness({ settings: DECIDE })
    await decideReq(h, "t1", "rm -rf build")
    h.clock.advance(6_000)
    await h.engine.ingest(
      "Notification",
      ev("Notification", {
        notification_type: "permission_prompt",
        message: "Claude needs your permission to use Bash",
      }),
    )
    expect(h.engine.snapshot().items.map((i) => [i.state, i.live])).toEqual([["open", true]])
    expect(rows(h).notifications).toHaveLength(1)
  })

  test("muted project: no request, no item", async () => {
    const h = makeHarness({ settings: DECIDE })
    await h.engine.ingest("SessionStart", ev("SessionStart", { source: "startup" }))
    h.engine.mute(h.engine.snapshot().projects[0]?.id ?? "", true)
    const r = await decideReq(h, "t1", "rm -rf build")
    expect(r.requestId).toBeNull()
    expect(shape(h)).toEqual([])
  })

  test("holds off (observer channel): observe behaviour, no request", async () => {
    const h = makeHarness({ settings: { ...DECIDE, "holds.enabled": false } })
    const r = await decideReq(h, "t1", "rm -rf build")
    expect(r.requestId).toBeNull()
    expect(h.engine.snapshot().items.map((i) => [i.state, i.live])).toEqual([["open", false]])
  })
})

describe("subagents and concurrent prompts (D-083, D-084)", () => {
  const as = (agent: string, e: ReturnType<typeof ev>) => ({
    ...e,
    payload: { ...e.payload, agent_id: agent, agent_type: "general-purpose" },
  })
  const prompt = (tool = "Bash") =>
    ev("Notification", {
      notification_type: "permission_prompt",
      message: `Claude needs your permission to use ${tool}`,
    })

  test("two agents, identical commands: each request gets its own agent's tool_use_id", async () => {
    const h = makeHarness({ settings: DECIDE })
    await h.engine.ingest("PreToolUse", as("a2", preBash("t2", "make")))
    await h.engine.ingest("PreToolUse", as("a1", preBash("t1", "make")))
    // a2's request: the newest identical PreToolUse is a1's, which isn't its call.
    const r2 = await h.engine.ingest(
      "PermissionRequest",
      as("a2", request("Bash", bashInput("make"))),
    )
    expect(rows(h).approvals.map((a) => a.tool_use_id)).toEqual(["t2"])
    // a1 runs its own (no prompt for it): a2's item and waiting hook are untouched.
    await h.engine.ingest("PostToolUse", as("a1", postBash("t1", "make")))
    expect(shape(h)).toEqual([["permission", "open"]])
    expect(rows(h).approvals[0]?.live).toBe(1)
    const waiting = h.engine.waitDecision(r2.requestId ?? "", 30)
    h.engine.decide(rows(h).items[0]?.id ?? "", "allow", null)
    expect((await waiting).decision).toBe("allow")
  })

  test("no tool_use_id: another agent's identical PostToolUse doesn't resolve it", async () => {
    const h = makeHarness({ settings: DECIDE })
    await h.engine.ingest("PermissionRequest", as("a2", request("Read", { file_path: "/etc/a" })))
    await h.engine.ingest(
      "PostToolUse",
      as(
        "a1",
        ev("PostToolUse", {
          tool_name: "Read",
          tool_use_id: "z1",
          tool_input: { file_path: "/etc/a" },
        }),
      ),
    )
    expect(shape(h)).toEqual([["permission", "open"]])
  })

  test("observe mode: a second agent's concurrent prompt is its own item", async () => {
    const h = makeClassicHarness({ settings: { "holds.enabled": false } })
    await h.engine.ingest("PermissionRequest", as("a1", request("Bash", bashInput("make a"))))
    await h.engine.ingest("PermissionRequest", as("a2", request("Bash", bashInput("make b"))))
    expect(rows(h).items.map((i) => [i.summary, i.state])).toEqual([
      ["Wants to run make a", "open"],
      ["Wants to run make b", "open"],
    ])
    // The same agent's second, different prompt is new too; a repeat of the same call isn't.
    await h.engine.ingest("PermissionRequest", as("a1", request("Bash", bashInput("make c"))))
    await h.engine.ingest("PermissionRequest", as("a1", request("Bash", bashInput("make a"))))
    expect(rows(h).items).toHaveLength(3)
  })

  test("the permission_prompt Notification with two prompts for the tool open: nothing", async () => {
    const h = makeClassicHarness({ settings: { "holds.enabled": false } })
    await h.engine.ingest("PermissionRequest", as("a1", request("Bash", bashInput("make a"))))
    await h.engine.ingest("PermissionRequest", as("a2", request("Bash", bashInput("make b"))))
    const before = rows(h).items.map((i) => i.updated_at)
    const notified = rows(h).notifications.length
    h.clock.advance(6_000)
    await h.engine.ingest("Notification", prompt("Bash"))
    expect(rows(h).items).toHaveLength(2)
    expect(rows(h).items.map((i) => i.updated_at)).toEqual(before)
    expect(rows(h).notifications).toHaveLength(notified)
    // One open for the tool: it is refreshed, as before (D-067).
    const h1 = makeClassicHarness({ settings: { "holds.enabled": false } })
    await h1.engine.ingest("PermissionRequest", as("a1", request("Bash", bashInput("make a"))))
    h1.clock.advance(6_000)
    await h1.engine.ingest("Notification", prompt("Bash"))
    expect(rows(h1).items).toHaveLength(1)
    expect(rows(h1).items[0]?.updated_at).toBe(h1.clock.now())
  })
})

describe("dismissed in observe mode (D-085)", () => {
  test("the Notification 6 s later doesn't bring it back; a minute later a prompt is new", async () => {
    const h = makeClassicHarness({ settings: { "holds.enabled": false } })
    await h.engine.ingest("PermissionRequest", request("Bash", bashInput("make a")))
    h.engine.dismiss(rows(h).items[0]?.id ?? "")
    h.clock.advance(6_000)
    await h.engine.ingest(
      "Notification",
      ev("Notification", {
        notification_type: "permission_prompt",
        message: "Claude needs your permission to use Bash",
      }),
    )
    expect(shape(h)).toEqual([["permission", "dismissed"]])
    expect(h.engine.snapshot().counts.needsYou).toBe(0)
    h.clock.advance(60_000)
    await h.engine.ingest("UserPromptSubmit", ev("UserPromptSubmit", { prompt: "go" }))
    await h.engine.ingest(
      "Notification",
      ev("Notification", {
        notification_type: "permission_prompt",
        message: "Claude needs your permission to use Bash",
      }),
    )
    expect(shape(h)).toEqual([
      ["permission", "dismissed"],
      ["permission", "open"],
    ])
  })
})

describe("the default since D-074 (no settings at all)", () => {
  test("decide fixture replays with the default settings", async () => {
    const h = makeHarness()
    const r = await replay(h, fx("permission-request-decide"))
    expect(r.requestIds).toHaveLength(1)
    expect(rows(h).items.map((i) => [i.kind, i.state])).toEqual([["permission", "resolved"]])
    expect(rows(h).approvals[0]?.decision).toBe("allow")
  })

  test("PreToolUse holds nothing; Claude's prompts are answered; defaults say so", async () => {
    const h = makeHarness()
    const pre = await h.engine.ingest("PreToolUse", preBash("t1", "rm -rf build"))
    expect(pre.requestId).toBeNull()
    const pr = await h.engine.ingest(
      "PermissionRequest",
      request("Bash", bashInput("rm -rf build")),
    )
    expect(pr.requestId).not.toBeNull()
    expect(pr.holdMs).toBe(600_000)
    expect(h.engine.userSettings().settings["holds.via"]).toBe("permissionRequest")
    expect(h.engine.userSettings().defaults["holds.via"]).toBe("permissionRequest")
  })
})
