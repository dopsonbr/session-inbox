import { describe, expect, test } from "bun:test"
import { cleanPromptText, transcriptTitle } from "../src/domain/text.ts"
import { REPLY_CLI_LOGGED_OUT, REPLY_CLI_MISSING } from "../src/engine.ts"
import { parseAuthStatus } from "../src/services.ts"
import { envelope, type Harness, makeClassicHarness as makeHarness } from "./fakes.ts"

const SID = "dddddddd-0000-4000-8000-000000000001"
const TRANSCRIPT = "/t/session.jsonl"
const base = { session_id: SID, cwd: "/work/x", transcript_path: TRANSCRIPT }

const session = (h: Harness) =>
  h.engine.deps.db.query("SELECT title, title_source FROM sessions WHERE id = ?").get(SID) as {
    title: string | null
    title_source: string | null
  }
const titleEvents = (h: Harness) =>
  h.engine.deps.db.query("SELECT payload_json FROM events WHERE hook = 'daemon:title'").all()

describe("cleaned prompt titles (D-060)", () => {
  test("a message relayed from another session is titled by what it says (seen live)", () => {
    expect(
      cleanPromptText(
        '<cross-session-message from="local_80d1" from-name="Session inbox app optimization">\nNext test round. Do exactly these steps.\n</cross-session-message>',
      ),
    ).toBe("Next test round. Do exactly these steps.")
    expect(cleanPromptText('<cross-session-message from="x">\nUnclosed but readable')).toBe(
      "Unclosed but readable",
    )
  })

  test("a session started by another session", () => {
    expect(
      cleanPromptText(
        "Background (from the session that started this one): This session reviews the\ninbox daemon.\n\nTask: Fix the notification fallback for denied apps",
      ),
    ).toBe("Fix the notification fallback for denied apps")
    expect(
      cleanPromptText(
        "Background (from the session that started this one): This came from elsewhere.\n\nWrite the release notes",
      ),
    ).toBe("Write the release notes")
    expect(
      cleanPromptText("Background (from the session that started this one): This only."),
    ).toBeNull()
  })
  test("a task notification is markup only", () => {
    expect(
      cleanPromptText(
        "<task-notification> <task-id>bcirnkth7</task-id> <status>completed</status> </task-notification>",
      ),
    ).toBeNull()
    expect(cleanPromptText("<task-notification> <task-id>bcirnkth7</task-id>…")).toBeNull()
  })
  test("a leading system reminder is stripped", () => {
    expect(
      cleanPromptText(
        "<system-reminder> Linked sessions now share context.</system-reminder>\n  Add a   retention setting",
      ),
    ).toBe("Add a retention setting")
    expect(cleanPromptText("<system-reminder> Linked sessions now…")).toBeNull()
    expect(cleanPromptText("<a>x</a><b/>  <c k='v'>y</c> real words")).toBe("real words")
  })
  test("ordinary prompts are untouched apart from whitespace", () => {
    expect(cleanPromptText("  fix   the <b>bold</b> bug ")).toBe("fix the <b>bold</b> bug")
    expect(cleanPromptText("   ")).toBeNull()
    expect(cleanPromptText("…!?")).toBeNull()
  })
})

describe("transcript titles (D-059)", () => {
  const lines = (...xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join("\n")
  test("the latest custom-title wins over other kinds", () => {
    const t = lines(
      { type: "summary", summary: "Old summary" },
      { type: "custom-title", customTitle: "First", sessionId: "s" },
      { type: "user", message: { content: "custom-title is not this" } },
      { type: "ai-title", aiTitle: "Generated one" },
      { type: "custom-title", customTitle: "Inbox live test 2: held Bash timing", sessionId: "s" },
    )
    expect(transcriptTitle(t)).toBe("Inbox live test 2: held Bash timing")
  })
  test("other *title kinds, then summary", () => {
    expect(transcriptTitle(lines({ type: "ai-title", aiTitle: "Fix auth" }))).toBe("Fix auth")
    expect(transcriptTitle(lines({ type: "summary", summary: "Refactor X" }))).toBe("Refactor X")
    expect(transcriptTitle(`{"type":"custom-ti`)).toBeNull()
    expect(transcriptTitle(null)).toBeNull()
  })
})

describe("session titles through the engine", () => {
  test("a transcript title beats the prompt and skips Haiku", async () => {
    const h = makeHarness()
    h.files.tails[TRANSCRIPT] = JSON.stringify({
      type: "custom-title",
      customTitle: "Desktop name",
    })
    await h.engine.ingest(
      "UserPromptSubmit",
      envelope("UserPromptSubmit", { ...base, prompt: "please fix the thing" }),
    )
    await h.engine.idle()
    expect(session(h)).toEqual({ title: "Desktop name", title_source: "claude" })
    expect(h.claude.titles).toHaveLength(0)
    expect(titleEvents(h)).toHaveLength(1)
    // Same title again: no new event. Renamed in the app: picked up on Stop.
    await h.engine.ingest("Stop", envelope("Stop", base))
    expect(titleEvents(h)).toHaveLength(1)
    h.files.tails[TRANSCRIPT] +=
      `\n${JSON.stringify({ type: "custom-title", customTitle: "Renamed" })}`
    await h.engine.ingest("Stop", envelope("Stop", base))
    expect(session(h).title).toBe("Renamed")
    expect(titleEvents(h)).toHaveLength(2)
  })

  test("a title only in the head of the transcript is found", async () => {
    const h = makeHarness()
    h.files.tails[TRANSCRIPT] =
      `${JSON.stringify({ type: "custom-title", customTitle: "From the head" })}\n${"x".repeat(70_000)}`
    await h.engine.ingest("SessionStart", envelope("SessionStart", { ...base, source: "startup" }))
    expect(session(h).title).toBe("From the head")
  })

  test("a generated title never overwrites a transcript one", async () => {
    const h = makeHarness()
    await h.engine.ingest(
      "UserPromptSubmit",
      envelope("UserPromptSubmit", { ...base, prompt: "please fix the thing" }),
    )
    h.files.tails[TRANSCRIPT] = JSON.stringify({ type: "custom-title", customTitle: "Mine" })
    await h.engine.ingest("Stop", envelope("Stop", base))
    await h.engine.idle()
    expect(session(h)).toEqual({ title: "Mine", title_source: "claude" })
  })

  test("markup-only prompt: placeholder, replaced by the next real prompt", async () => {
    const h = makeHarness()
    await h.engine.ingest(
      "UserPromptSubmit",
      envelope("UserPromptSubmit", {
        ...base,
        prompt: "<task-notification><task-id>x</task-id></task-notification>",
      }),
    )
    expect(session(h)).toEqual({ title: "Untitled session", title_source: "placeholder" })
    expect(h.claude.titles).toHaveLength(0)
    await h.engine.ingest(
      "UserPromptSubmit",
      envelope("UserPromptSubmit", {
        ...base,
        prompt: "<system-reminder>r</system-reminder> ship it",
      }),
    )
    await h.engine.idle()
    expect(h.claude.titles).toEqual(["ship it"])
    expect(session(h)).toEqual({ title: "Generated Title", title_source: "generated" })
  })

  test("no CLI login: no title generation, one INFO per run", async () => {
    const h = makeHarness()
    const infos: string[] = []
    ;(h.engine.deps.log as { info: (m: string) => void }).info = (m) => infos.push(m)
    h.claude.auth = { found: true, loggedIn: false, method: "none", checkedAt: 0 }
    for (const i of [1, 2]) {
      await h.engine.ingest(
        "UserPromptSubmit",
        envelope("UserPromptSubmit", { ...base, session_id: `s${i}`, prompt: `task ${i}` }),
      )
    }
    await h.engine.idle()
    expect(h.claude.titles).toHaveLength(0)
    expect(infos.filter((m) => m.includes("skipping generated titles"))).toHaveLength(1)
  })
})

describe("claude auth status", () => {
  test("parses the JSON the CLI prints", () => {
    expect(parseAuthStatus('{"loggedIn": false, "authMethod": "none"}\n')).toEqual({
      loggedIn: false,
      method: "none",
    })
    expect(parseAuthStatus('Logged in\n{"loggedIn":true,"authMethod":"claude.ai"}')).toEqual({
      loggedIn: true,
      method: "claude.ai",
    })
    expect(parseAuthStatus("not json")).toBeNull()
    expect(parseAuthStatus('{"other":1}')).toBeNull()
  })
})

describe("replies without a CLI login (C-023)", () => {
  const review = async (h: Harness) => {
    await h.engine.ingest(
      "Stop",
      envelope("Stop", { ...base, last_assistant_message: "Done.\n\nChanged **three** files." }),
    )
    return h.engine.snapshot().items.find((i) => i.kind === "review")?.id ?? ""
  }

  test("logged out: detail says why and a reply is a 409", async () => {
    const h = makeHarness()
    h.claude.auth = { found: true, loggedIn: false, method: "none", checkedAt: 0 }
    await h.engine.refreshAuth()
    const id = await review(h)
    expect(h.engine.itemDetail(id).replyUnavailable).toBe(REPLY_CLI_LOGGED_OUT)
    expect(() => h.engine.reply(id, "r1", "more please")).toThrow(REPLY_CLI_LOGGED_OUT)
    expect(h.engine.deps.db.query("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 0 })
    expect(h.engine.snapshot().items.find((i) => i.id === id)?.state).toBe("open")
  })

  test("CLI missing has its own reason", async () => {
    const h = makeHarness()
    h.claude.auth = { found: false, loggedIn: null, method: null, checkedAt: 0 }
    await h.engine.refreshAuth()
    const id = await review(h)
    expect(h.engine.itemDetail(id).replyUnavailable).toBe(REPLY_CLI_MISSING)
  })

  test("logged in or unknown: replies queue as before", async () => {
    const h = makeHarness()
    const id = await review(h)
    expect(h.engine.itemDetail(id).replyUnavailable).toBeUndefined()
    await h.engine.refreshAuth()
    expect(h.engine.reply(id, "r1", "more please").ok).toBe(true)
  })

  test("a live held item takes replies through the hook, CLI or not", async () => {
    const h = makeHarness()
    h.claude.auth = { found: true, loggedIn: false, method: "none", checkedAt: 0 }
    await h.engine.refreshAuth()
    const r = await h.engine.ingest(
      "PreToolUse",
      envelope("PreToolUse", {
        ...base,
        tool_name: "Bash",
        tool_use_id: "tu",
        tool_input: { command: "make" },
      }),
    )
    const id = h.engine.snapshot().items.find((i) => i.live)?.id ?? ""
    expect(h.engine.itemDetail(id).replyUnavailable).toBeUndefined()
    expect(h.engine.reply(id, "r2", "use ninja").ok).toBe(true)
    expect(await h.engine.waitDecision(r.requestId ?? "", 0)).toEqual({
      decision: "deny",
      reason: "The user replied: use ninja",
    })
  })

  test("review and failed items carry Claude's last message in full", async () => {
    const h = makeHarness()
    const id = await review(h)
    expect(h.engine.itemDetail(id).lastMessage).toBe("Done.\n\nChanged **three** files.")
    await h.engine.ingest(
      "Stop",
      envelope("Stop", { ...base, session_id: "s2", last_assistant_message: "x".repeat(25_000) }),
    )
    const other = h.engine.snapshot().items.find((i) => i.sessionId === "s2")?.id ?? ""
    expect(h.engine.itemDetail(other).lastMessage?.length).toBe(20_000)
    await h.engine.ingest(
      "Notification",
      envelope("Notification", { ...base, session_id: "s3", notification_type: "idle_prompt" }),
    )
    const q = h.engine.snapshot().items.find((i) => i.sessionId === "s3")?.id ?? ""
    expect(h.engine.itemDetail(q).lastMessage).toBeUndefined()
  })
})

describe("timeline paths (D-064)", () => {
  test("file tools show the project-relative path", async () => {
    const h = makeHarness()
    await h.engine.ingest(
      "PostToolUse",
      envelope("PostToolUse", {
        ...base,
        tool_name: "Edit",
        tool_input: { file_path: "/work/x/src/window.ts" },
      }),
    )
    await h.engine.ingest(
      "PostToolUse",
      envelope("PostToolUse", {
        ...base,
        tool_name: "Read",
        tool_input: { file_path: "/etc/hosts" },
      }),
    )
    const lines = h.engine.timeline(SID).map((e) => e.text)
    expect(lines).toEqual(["Read /etc/hosts", "Edited src/window.ts"])
  })
})
