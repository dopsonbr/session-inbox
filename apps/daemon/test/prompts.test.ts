import { describe, expect, test } from "bun:test"
import { matchPrompt, type PromptCandidate, promptTool, sameTool } from "../src/domain/prompts.ts"
import { envelope, makeHarness } from "./fakes.ts"

const base = { session_id: "bbbbbbbb-0000-4000-8000-0000000000p1", cwd: "/work/x" }

describe("promptTool", () => {
  test("reads the tool out of Claude's message", () => {
    expect(promptTool("Claude needs your permission to use Read")).toBe("Read")
    expect(promptTool("Claude needs your permission to use Bash.")).toBe("Bash")
    expect(promptTool("Claude needs your permission to use mcp__github__create_issue")).toBe(
      "mcp__github__create_issue",
    )
    expect(promptTool('Claude needs your permission to use "Web Search"')).toBe("Web Search")
    expect(promptTool("Title\nClaude needs your permission to use Edit")).toBe("Edit")
  })
  test("null when no tool is named", () => {
    expect(promptTool("Claude needs your permission")).toBeNull()
    expect(promptTool("")).toBeNull()
    expect(promptTool(undefined)).toBeNull()
  })
  test("sameTool: exact, case/punctuation-insensitive, MCP display names", () => {
    expect(sameTool("Read", "Read")).toBe(true)
    expect(sameTool("read", "Read")).toBe(true)
    expect(sameTool("Read", "Bash")).toBe(false)
    expect(sameTool("github - create_issue (MCP)", "mcp__github__create_issue")).toBe(true)
    expect(sameTool("github - list_issues (MCP)", "mcp__github__create_issue")).toBe(false)
  })
})

describe("matchPrompt", () => {
  const now = 1_000_000
  const c = (o: Partial<PromptCandidate>): PromptCandidate => ({
    itemId: "i",
    open: false,
    tool: "Read",
    decision: null,
    decidedAt: null,
    activitySince: false,
    ...o,
  })
  test("open item for the same tool matches", () => {
    expect(matchPrompt([c({ open: true })], "Read", now)?.itemId).toBe("i")
  })
  test("open item for another tool doesn't", () => {
    expect(matchPrompt([c({ open: true, tool: "Write" })], "Read", now)).toBeNull()
  })
  test("allow / deny / allow-always never match, however recent", () => {
    for (const decision of ["allow", "deny", "allow-always"])
      expect(matchPrompt([c({ decision, decidedAt: now - 1000 })], "Read", now)).toBeNull()
  })
  test("ask within 30 s matches even after activity", () => {
    const x = c({ decision: "ask", decidedAt: now - 29_000, activitySince: true })
    expect(matchPrompt([x], "Read", now)).not.toBeNull()
  })
  test("older ask matches only with no activity since", () => {
    expect(
      matchPrompt([c({ decision: "ask", decidedAt: now - 60_000 })], "Read", now),
    ).not.toBeNull()
    const moved = c({ decision: "ask", decidedAt: now - 60_000, activitySince: true })
    expect(matchPrompt([moved], "Read", now)).toBeNull()
  })
  test("no tool named: only an open item matches", () => {
    expect(matchPrompt([c({ open: true, tool: "Write" })], null, now)).not.toBeNull()
    expect(matchPrompt([c({ decision: "ask", decidedAt: now })], null, now)).toBeNull()
    expect(matchPrompt([], null, now)).toBeNull()
  })
})

describe("permission-prompt Notification against held items (D-067)", () => {
  const bash = (id: string) =>
    envelope("PreToolUse", {
      ...base,
      tool_name: "Bash",
      tool_use_id: id,
      tool_input: { command: "rm -rf build" },
    })
  const prompt = (tool: string | null) =>
    envelope("Notification", {
      ...base,
      notification_type: "permission_prompt",
      message: tool
        ? `Claude needs your permission to use ${tool}`
        : "Claude needs your permission",
    })
  const shape = (h: ReturnType<typeof makeHarness>) =>
    h.engine.snapshot().items.map((i) => [i.kind, i.state])

  test("same tool, hold still live: refreshed, no second item", async () => {
    const h = makeHarness()
    await h.engine.ingest("PreToolUse", bash("t1"))
    h.clock.advance(6_000)
    await h.engine.ingest("Notification", prompt("Bash"))
    expect(shape(h)).toEqual([["permission", "open"]])
    expect(h.notifier.posted).toHaveLength(1)
  })

  test("same tool, hold lapsed 6 s ago: no new item", async () => {
    const h = makeHarness()
    await h.engine.ingest("PreToolUse", bash("t1"))
    h.clock.advance(120_001)
    h.engine.tick()
    h.clock.advance(6_000)
    await h.engine.ingest("Notification", prompt("Bash"))
    expect(shape(h)).toEqual([["permission", "expired"]])
  })

  test("same tool, lapsed long ago with nothing since: still Claude's prompt for it", async () => {
    const h = makeHarness()
    await h.engine.ingest("PreToolUse", bash("t1"))
    h.clock.advance(120_001)
    h.engine.tick()
    h.clock.advance(10 * 60_000)
    await h.engine.ingest("Notification", prompt("Bash"))
    expect(shape(h)).toEqual([["permission", "expired"]])
  })

  test("same tool, lapsed and the session moved on: a new prompt", async () => {
    const h = makeHarness()
    await h.engine.ingest("PreToolUse", bash("t1"))
    h.clock.advance(120_001)
    h.engine.tick()
    h.clock.advance(1_000)
    await h.engine.ingest(
      "PostToolUse",
      envelope("PostToolUse", { ...base, tool_name: "Bash", tool_use_id: "t1", tool_input: {} }),
    )
    h.clock.advance(60_000)
    await h.engine.ingest("Notification", prompt("Bash"))
    expect(shape(h)).toEqual([
      ["permission", "expired"],
      ["permission", "open"],
    ])
  })

  test("same tool, decided allow 8 s ago: a new prompt is a new call", async () => {
    const h = makeHarness()
    await h.engine.ingest("PreToolUse", bash("t1"))
    const item = h.engine.snapshot().items[0]
    h.engine.decide(item?.id ?? "", "allow", null)
    h.clock.advance(8_000)
    await h.engine.ingest("Notification", prompt("Bash"))
    expect(shape(h)).toEqual([
      ["permission", "answered"],
      ["permission", "open"],
    ])
  })

  test("no tool in the message: suppressed only by an open item", async () => {
    const h = makeHarness()
    await h.engine.ingest("PreToolUse", bash("t1"))
    await h.engine.ingest("Notification", prompt(null))
    expect(shape(h)).toEqual([["permission", "open"]])
    const item = h.engine.snapshot().items[0]
    h.engine.decide(item?.id ?? "", "ask", null)
    h.clock.advance(1_000)
    await h.engine.ingest("Notification", prompt(null))
    expect(shape(h)).toEqual([
      ["permission", "answered"],
      ["permission", "open"],
    ])
  })
})
