import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendAllowRule, ruleMatches } from "../src/domain/permissions.ts"
import { encodeLiveAnswers, parseQuestions } from "../src/domain/questions.ts"
import { lastTurnErrored, provisionalTitle } from "../src/domain/text.ts"
import { openUrlFor } from "../src/engine.ts"
import type { OutboxRow } from "../src/store.ts"
import { envelope, makeHarness } from "./fakes.ts"

const SID = "bbbbbbbb-0000-4000-8000-000000000001"
const base = { session_id: SID, cwd: "/work/x" }

describe("permission rules", () => {
  test("Tool, Tool(exact), Tool(prefix:*)", () => {
    expect(ruleMatches("Bash", "Bash", { command: "ls" })).toBe(true)
    expect(ruleMatches("Bash(npm test)", "Bash", { command: "npm test" })).toBe(true)
    expect(ruleMatches("Bash(npm test)", "Bash", { command: "npm test x" })).toBe(false)
    expect(ruleMatches("Bash(npm run:*)", "Bash", { command: "npm run build" })).toBe(true)
    expect(ruleMatches("Edit(/a/**)", "Edit", { file_path: "/a/b/c.ts" })).toBe(true)
    expect(ruleMatches("WebFetch(domain:x.dev)", "WebFetch", { url: "https://x.dev/p" })).toBe(true)
    expect(ruleMatches("Write", "Bash", { command: "ls" })).toBe(false)
  })
  test("appendAllowRule preserves the rest of the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "inboxd-perm-"))
    mkdirSync(join(dir, ".claude"))
    const file = join(dir, ".claude", "settings.local.json")
    writeFileSync(
      file,
      JSON.stringify({ model: "opus", permissions: { allow: ["Read"], deny: ["Bash(rm:*)"] } }),
    )
    appendAllowRule(dir, "Bash(make)")
    appendAllowRule(dir, "Bash(make)")
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      model: "opus",
      permissions: { allow: ["Read", "Bash(make)"], deny: ["Bash(rm:*)"] },
    })
  })
})

describe("questions encoding", () => {
  const input = {
    questions: [
      { question: "A?", options: [{ label: "x" }, { label: "y" }], multiSelect: true },
      { question: "B?", options: [{ label: "z" }] },
    ],
  }
  const qs = parseQuestions(input)
  const answers = [
    { idx: 0, selected: ["x", "y"] },
    { idx: 1, selected: [], other: "free" },
  ]
  test("updatedInput: original input + answers map", () => {
    expect(encodeLiveAnswers("updatedInput", input, qs, answers)).toEqual({
      decision: "allow",
      updatedInput: { ...input, answers: { "A?": "x, y", "B?": "free" } },
    })
  })
  test("denyWithReason is the one-line swap", () => {
    const d = encodeLiveAnswers("denyWithReason", input, qs, answers)
    expect(d.decision).toBe("deny")
    expect(d.reason).toBe("The user answered via Session Inbox: A? → x, y; B? → free")
  })
})

describe("text helpers", () => {
  test("provisional title trims to ~60 chars", () => {
    expect(provisionalTitle("  fix   the bug  ")).toBe("fix the bug")
    const t = provisionalTitle("word ".repeat(40)) ?? ""
    expect(t.length).toBeLessThanOrEqual(61)
    expect(t.endsWith("…")).toBe(true)
  })
  test("transcript tail: last assistant entry decides", () => {
    const dir = mkdtempSync(join(tmpdir(), "inboxd-tx-"))
    const f = join(dir, "t.jsonl")
    writeFileSync(
      f,
      [
        JSON.stringify({ type: "assistant", message: { role: "assistant" } }),
        JSON.stringify({
          type: "assistant",
          isApiErrorMessage: true,
          message: { role: "assistant" },
        }),
        JSON.stringify({ type: "system" }),
      ].join("\n"),
    )
    expect(lastTurnErrored(f)).toBe(true)
    writeFileSync(f, JSON.stringify({ type: "assistant", message: { role: "assistant" } }))
    expect(lastTurnErrored(f)).toBe(false)
    expect(lastTurnErrored(join(dir, "missing"))).toBe(false)
  })
})

describe("openUrlFor", () => {
  const s = {
    id: SID,
    projectId: "p",
    title: null,
    runtime: "desktop" as const,
    cwd: "/work/x",
    branch: null,
    worktree: null,
    hostSessionId: "local_abc-1",
    state: "idle" as const,
    lastEventAt: 0,
  }
  test("desktop → continue; cli → resume; no ids → new in folder", () => {
    expect(openUrlFor(s)).toBe("claude://code/continue?session=local_abc-1")
    expect(openUrlFor({ ...s, runtime: "cli", hostSessionId: null })).toBe(
      `claude://resume?session=${SID}`,
    )
    expect(openUrlFor({ ...s, id: "not-a-uuid", hostSessionId: null })).toBe(
      "claude://code/new?folder=%2Fwork%2Fx",
    )
  })
})

describe("engine behaviours", () => {
  test("dedupe: repeat Notification refreshes, never re-notifies", async () => {
    const h = makeHarness()
    const n = {
      ...base,
      notification_type: "permission_prompt",
      message: "Claude needs your permission",
    }
    await h.engine.ingest("Notification", envelope("Notification", n))
    h.clock.advance(60_000)
    await h.engine.ingest("Notification", envelope("Notification", n))
    const items = h.engine.snapshot().items
    expect(items).toHaveLength(1)
    expect(items[0]?.live).toBe(false)
    expect(h.notifier.posted).toHaveLength(1)
  })

  test("new activity resolves stale review items", async () => {
    const h = makeHarness()
    await h.engine.ingest("Stop", envelope("Stop", base))
    expect(h.engine.snapshot().items[0]?.state).toBe("open")
    await h.engine.ingest(
      "UserPromptSubmit",
      envelope("UserPromptSubmit", { ...base, prompt: "next" }),
    )
    expect(h.engine.snapshot().items[0]?.state).toBe("resolved")
  })

  test("review notifications coalesce within 30 s", async () => {
    const h = makeHarness()
    for (const i of [1, 2, 3]) {
      await h.engine.ingest("Stop", envelope("Stop", { session_id: `s${i}`, cwd: `/w/${i}` }))
      h.clock.advance(5_000)
    }
    h.engine.tick()
    expect(h.notifier.posted).toHaveLength(0)
    h.clock.advance(20_000)
    h.engine.tick()
    await h.engine.idle()
    expect(h.notifier.posted).toEqual([{ title: "Claude", body: "3 sessions ready to review" }])
  })

  test("muted project: no hold, no notification", async () => {
    const h = makeHarness()
    await h.engine.ingest("SessionStart", envelope("SessionStart", base))
    const pid = h.engine.snapshot().projects[0]?.id ?? ""
    h.engine.mute(pid, true)
    const r = await h.engine.ingest(
      "PreToolUse",
      envelope("PreToolUse", { ...base, tool_name: "Bash", tool_input: { command: "rm x" } }),
    )
    expect(r.requestId).toBeNull()
    await h.engine.ingest("Stop", envelope("Stop", base))
    h.clock.advance(31_000)
    h.engine.tick()
    expect(h.notifier.posted).toHaveLength(0)
  })

  test("answered item without a confirming event becomes unconfirmed after 5 min", async () => {
    const h = makeHarness()
    const r = await h.engine.ingest(
      "PreToolUse",
      envelope("PreToolUse", { ...base, tool_name: "Bash", tool_input: { command: "rm x" } }),
    )
    const item = h.engine.snapshot().items[0]
    h.engine.decide(item?.id ?? "", "deny", "k")
    expect((await h.engine.waitDecision(r.requestId ?? "", 0)).decision).toBe("deny")
    h.clock.advance(5 * 60_000 + 1)
    h.engine.tick()
    const after = h.engine.snapshot().items[0]
    expect(after?.state).toBe("answered")
    expect(after?.unconfirmed).toBe(true)
  })

  test("answers that didn't land switch the runtime to denyWithReason (persisted)", async () => {
    const h = makeHarness()
    const input = { questions: [{ question: "Q?", options: [{ label: "a" }, { label: "b" }] }] }
    await h.engine.ingest(
      "PreToolUse",
      envelope("PreToolUse", {
        ...base,
        tool_name: "AskUserQuestion",
        tool_use_id: "t1",
        tool_input: input,
      }),
    )
    const id = h.engine.snapshot().items[0]?.id ?? ""
    h.engine.answers(id, "k1", [{ idx: 0, selected: ["a"] }])
    await h.engine.ingest(
      "PostToolUse",
      envelope("PostToolUse", {
        ...base,
        tool_name: "AskUserQuestion",
        tool_use_id: "t1",
        tool_input: input,
        tool_response: { answers: {} },
      }),
    )
    expect(h.engine.answerModeFor("cli")).toBe("denyWithReason")
    expect(h.engine.answerModeFor("desktop")).toBe("updatedInput")
    const item = h.engine.snapshot().items[0]
    expect(item?.state).toBe("answered")
    expect(item?.unconfirmed).toBe(true)
    const row = h.engine.store.one<{ value_json: string }>(
      "SELECT value_json FROM settings WHERE key = 'questions.answerModeByRuntime'",
    )
    expect(JSON.parse(row?.value_json ?? "{}")).toEqual({ cli: "denyWithReason" })
  })

  test("outbox: waits while running, retries with backoff, fails after 3", async () => {
    const h = makeHarness()
    await h.engine.ingest("Stop", envelope("Stop", base))
    const id = h.engine.snapshot().items[0]?.id ?? ""
    await h.engine.ingest(
      "UserPromptSubmit",
      envelope("UserPromptSubmit", { ...base, prompt: "go" }),
    )
    h.claude.failResumes = 5
    h.engine.reply(id, "k", "hello")
    await h.engine.idle()
    expect(h.claude.resumes).toHaveLength(0) // session is running
    await h.engine.ingest("Stop", envelope("Stop", base))
    await h.engine.idle()
    expect(h.claude.resumes).toHaveLength(1)
    const row = () => h.engine.store.one<OutboxRow>("SELECT * FROM outbox") as OutboxRow
    expect(row().state).toBe("queued")
    expect(row().last_error).toBe("boom")
    h.engine.tick()
    await h.engine.idle()
    expect(h.claude.resumes).toHaveLength(1) // backoff not elapsed
    h.clock.advance(5_000)
    h.engine.tick()
    await h.engine.idle()
    h.clock.advance(10_000)
    h.engine.tick()
    await h.engine.idle()
    expect(h.claude.resumes).toHaveLength(3)
    expect(row().state).toBe("failed")
    expect(row().attempts).toBe(3)
  })

  test("recovery: state survives a restart; sending rows requeue", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "inboxd-db-")), "inbox.db")
    const a = makeHarness({ dbFile: file })
    const r = await a.engine.ingest(
      "PreToolUse",
      envelope("PreToolUse", {
        ...base,
        tool_name: "Write",
        tool_input: { file_path: "/work/x/a" },
      }),
    )
    await a.engine.ingest("Stop", envelope("Stop", { session_id: "other", cwd: "/w" }))
    const review = a.engine.snapshot().items.find((i) => i.kind === "review")
    a.engine.snooze(review?.id ?? "", a.clock.now() + 60_000)
    a.engine.store.run(
      "INSERT INTO outbox (id, session_id, body, idempotency_key, state, created_at) VALUES ('o1', 'other', 'x', 'k', 'sending', 0)",
    )
    a.engine.deps.db.close()
    const b = makeHarness({ dbFile: file })
    b.clock.t = a.clock.t
    b.engine.recover()
    expect(b.engine.store.one<OutboxRow>("SELECT * FROM outbox")?.state).toBe("queued")
    const snap = b.engine.snapshot()
    expect(snap.items.find((i) => i.kind === "permission")?.live).toBe(true)
    expect(snap.items.find((i) => i.kind === "review")?.state).toBe("snoozed")
    // the hook can re-poll the same request id after the restart
    expect((await b.engine.waitDecision(r.requestId ?? "", 0)).decision).toBe("pending")
    b.clock.advance(121_000)
    b.engine.tick()
    expect((await b.engine.waitDecision(r.requestId ?? "", 0)).decision).toBe("ask")
  })

  test("title: prompt first, then the generated one; failures keep the prompt title", async () => {
    const h = makeHarness()
    h.claude.titleResult = null
    await h.engine.ingest(
      "UserPromptSubmit",
      envelope("UserPromptSubmit", { ...base, prompt: "Refactor delivery windows" }),
    )
    await h.engine.idle()
    expect(h.engine.snapshot().sessions[0]?.title).toBe("Refactor delivery windows")
    const h2 = makeHarness()
    await h2.engine.ingest(
      "SessionStart",
      envelope("SessionStart", { ...base, session_title: "Claude's own title" }),
    )
    await h2.engine.ingest(
      "UserPromptSubmit",
      envelope("UserPromptSubmit", { ...base, prompt: "x" }),
    )
    await h2.engine.idle()
    expect(h2.engine.snapshot().sessions[0]?.title).toBe("Claude's own title")
    expect(h2.claude.titles).toHaveLength(0)
  })
})
