/**
 * History (C-027, D-096): which finished items come back, in what order, how each ended, and
 * what the search matches.
 */
import { describe, expect, test } from "bun:test"
import type { HistoryPage } from "@session-inbox/contracts"
import { Routes } from "@session-inbox/contracts"
import { excerptAround, historyWords, outcomeOf, parseHistoryQuery } from "../src/history.ts"
import { type ServerContext, uiHandler } from "../src/server.ts"
import { envelope, type Harness, makeClassicHarness, makeHarness } from "./fakes.ts"

const A = "aaaaaaaa-0000-4000-8000-00000000000a"
const B = "aaaaaaaa-0000-4000-8000-00000000000b"
const MIN = 60_000

const ev = (sid: string, cwd: string, event: string, payload: Record<string, unknown> = {}) =>
  envelope(event, { session_id: sid, cwd, permission_mode: "default", ...payload })
const a = (event: string, payload?: Record<string, unknown>) => ev(A, "/work/alpha", event, payload)
const b = (event: string, payload?: Record<string, unknown>) => ev(B, "/work/beta", event, payload)

const openId = (h: Harness, kind: string) =>
  h.engine.snapshot().items.find((i) => i.kind === kind && i.state === "open")?.id ?? ""
const summary = (p: HistoryPage) => p.entries.map((e) => [e.item.kind, e.outcome])

/**
 * One classic-mode day in two sessions, a minute between steps, oldest first:
 * denied Bash, allowed Bash, answered question, review moved on, review replied to,
 * review dismissed, a hold released unanswered; the last review item is still open.
 */
const seed = async (): Promise<Harness> => {
  const h = makeClassicHarness()
  const step = () => h.clock.advance(MIN)
  const bash = (id: string, command: string) =>
    a("PreToolUse", { tool_name: "Bash", tool_use_id: id, tool_input: { command } })

  await h.engine.ingest("UserPromptSubmit", a("UserPromptSubmit", { prompt: "Fix the login bug" }))
  await h.engine.ingest("PreToolUse", bash("t1", "rm -rf build"))
  h.engine.decide(openId(h, "permission"), "deny", "k1")
  step()
  await h.engine.ingest("PreToolUse", bash("t2", 'echo "100%_done" > out.txt'))
  h.engine.decide(openId(h, "permission"), "allow", "k2")
  step()
  await h.engine.ingest(
    "PreToolUse",
    a("PreToolUse", {
      tool_name: "AskUserQuestion",
      tool_use_id: "t3",
      tool_input: {
        questions: [
          {
            question: "Which database should the login service use?",
            header: "Database",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
          },
        ],
      },
    }),
  )
  h.engine.answers(openId(h, "question"), "k3", [{ idx: 0, selected: ["Postgres"] }])
  step()
  await h.engine.ingest("Stop", a("Stop", { last_assistant_message: "Login fixed." }))
  step()
  await h.engine.ingest("UserPromptSubmit", a("UserPromptSubmit", { prompt: "now the tests" }))
  step()

  await h.engine.ingest(
    "UserPromptSubmit",
    b("UserPromptSubmit", { prompt: "Write the changelog" }),
  )
  await h.engine.ingest("Stop", b("Stop", { last_assistant_message: "Changelog drafted." }))
  h.engine.reply(openId(h, "review"), "k4", "ship it once CI is green")
  step()
  await h.engine.ingest("UserPromptSubmit", b("UserPromptSubmit", { prompt: "one more pass" }))
  await h.engine.ingest("Stop", b("Stop", { last_assistant_message: "Second pass done." }))
  h.engine.dismiss(openId(h, "review"))
  step()
  await h.engine.ingest(
    "PreToolUse",
    b("PreToolUse", {
      tool_name: "Bash",
      tool_use_id: "t9",
      tool_input: { command: "make deploy" },
    }),
  )
  step()
  // The turn ends while the call is still held: released unanswered. Its review item is open.
  await h.engine.ingest("Stop", b("Stop", { last_assistant_message: "Stopped before deploying." }))
  await h.engine.idle()
  return h
}

describe("pure helpers", () => {
  test("outcomeOf reads the terminal state, the answer and the decision", () => {
    const item = (kind: string, state: string, answered: boolean) => ({
      kind,
      state,
      answered_at: answered ? 1 : null,
    })
    expect(outcomeOf(item("review", "dismissed", false), null)).toBe("dismissed")
    expect(outcomeOf(item("permission", "expired", false), { decision: "ask" })).toBe("expired")
    expect(outcomeOf(item("permission", "resolved", true), { decision: "allow" })).toBe("allowed")
    expect(outcomeOf(item("permission", "answered", true), { decision: "allow-always" })).toBe(
      "always-allowed",
    )
    expect(outcomeOf(item("permission", "resolved", true), { decision: "deny" })).toBe("denied")
    expect(outcomeOf(item("permission", "resolved", true), { decision: "ask" })).toBe("in-claude")
    expect(outcomeOf(item("permission", "resolved", true), null)).toBe("replied")
    expect(outcomeOf(item("permission", "resolved", false), { decision: null })).toBe("in-claude")
    expect(outcomeOf(item("question", "resolved", true), { decision: "allow" })).toBe("answered")
    expect(outcomeOf(item("question", "resolved", false), null)).toBe("in-claude")
    expect(outcomeOf(item("review", "answered", true), null)).toBe("replied")
    expect(outcomeOf(item("review", "resolved", false), null)).toBe("moved-on")
    expect(outcomeOf(item("failed", "resolved", false), null)).toBe("moved-on")
  })

  test("historyWords lower-cases, dedupes and bounds", () => {
    expect(historyWords("  Fix  the FIX\tbug ")).toEqual(["fix", "the", "bug"])
    expect(historyWords(undefined)).toEqual([])
    expect(historyWords("a b c d e f g h i j")).toHaveLength(8)
  })

  test("excerptAround gives one line around the word", () => {
    expect(excerptAround("Run\n  the  tests", "the")).toBe("Run the tests")
    expect(excerptAround("nothing here", "zzz")).toBeNull()
    const long = `${"x".repeat(100)} needle ${"y".repeat(200)}`
    const out = excerptAround(long, "needle") ?? ""
    expect(out.startsWith("…")).toBe(true)
    expect(out.endsWith("…")).toBe(true)
    expect(out).toContain("needle")
    expect(out.length).toBeLessThanOrEqual(122)
  })

  test("parseHistoryQuery rejects a bad kind, cursor or limit", () => {
    const parse = (qs: string) => parseHistoryQuery(new URLSearchParams(qs))
    expect(parse("")).toEqual({ ok: true, query: { q: "", kind: null, before: null, limit: 50 } })
    expect(parse("q=a+b&kind=review&limit=5&before=12:x").ok).toBe(true)
    expect(parse("kind=progress").ok).toBe(false)
    expect(parse("limit=0").ok).toBe(false)
    expect(parse("limit=201").ok).toBe(false)
    expect(parse("limit=abc").ok).toBe(false)
    expect(parse("before=nope").ok).toBe(false)
  })
})

describe("history (C-027)", () => {
  test("lists finished items newest first with how each ended; open ones stay out", async () => {
    const h = await seed()
    const page = h.engine.history({})
    expect(summary(page)).toEqual([
      ["permission", "expired"],
      ["review", "dismissed"],
      ["review", "replied"],
      ["review", "moved-on"],
      ["question", "answered"],
      ["permission", "allowed"],
      ["permission", "denied"],
    ])
    expect(page.nextBefore).toBeNull()
    expect(page.retentionDays).toBe(14)
    expect(page.entries.every((e) => e.item.queue === "done")).toBe(true)
    expect(page.entries.every((e) => e.match === undefined)).toBe(true)
    const ended = page.entries.map((e) => e.endedAt)
    expect(ended).toEqual([...ended].sort((x, y) => y - x))
    expect(page.entries[0]?.project.name).toBe("beta")
    expect(page.entries[6]?.session.id).toBe(A)
    // The review item that is still open is in the inbox, not in history.
    expect(h.engine.snapshot().counts.review).toBe(1)
  })

  test("pages with the cursor without repeating or skipping", async () => {
    const h = await seed()
    const all = h.engine.history({}).entries.map((e) => e.item.id)
    const seen: string[] = []
    let before: string | null = null
    for (let i = 0; i < 10; i++) {
      const page: HistoryPage = h.engine.history({ limit: 3, before })
      seen.push(...page.entries.map((e) => e.item.id))
      before = page.nextBefore
      if (before === null) break
    }
    expect(seen).toEqual(all)
  })

  test("filters by kind", async () => {
    const h = await seed()
    expect(summary(h.engine.history({ kind: "review" }))).toEqual([
      ["review", "dismissed"],
      ["review", "replied"],
      ["review", "moved-on"],
    ])
    expect(h.engine.history({ kind: "failed" }).entries).toEqual([])
  })

  test("search: every word must match, in any field, whatever the case", async () => {
    const h = await seed()
    const find = (q: string) => h.engine.history({ q })
    // Project name and session title.
    expect(find("ALPHA").entries).toHaveLength(4)
    expect(find("beta").entries).toHaveLength(3)
    expect(find("alpha beta").entries).toEqual([])
    h.engine.store.run("UPDATE sessions SET title = 'Quarterly changelog' WHERE id = ?", B)
    expect(find("quarterly").entries).toHaveLength(3)
    // A command, with the place it matched.
    const rm = find("rm build")
    expect(summary(rm)).toEqual([["permission", "denied"]])
    // An answer the row doesn't show.
    const pg = find("postgres")
    expect(summary(pg)).toEqual([["question", "answered"]])
    expect(pg.entries[0]?.match?.text).toContain("Postgres")
    // A reply sent from the inbox.
    const reply = find("green")
    expect(summary(reply)).toEqual([["review", "replied"]])
    expect(reply.entries[0]?.match).toEqual({ where: "reply", text: "ship it once CI is green" })
    // The working directory.
    expect(find("/work/alpha").entries).toHaveLength(4)
    expect(find("nothing-like-this").entries).toEqual([])
  })

  test("search treats %, _ and quotes as plain characters", async () => {
    const h = await seed()
    const find = (q: string) => summary(h.engine.history({ q }))
    expect(find("100%_done")).toEqual([["permission", "allowed"]])
    expect(find('"100%_done"')).toEqual([["permission", "allowed"]])
    expect(find("100_done")).toEqual([])
    expect(find("%")).toEqual([["permission", "allowed"]])
  })

  test("a prompt answered in Claude ends as in-claude", async () => {
    const h = makeHarness()
    const input = { command: "make deploy", description: "Deploy" }
    await h.engine.ingest(
      "PermissionRequest",
      a("PermissionRequest", { tool_name: "Bash", tool_input: input }),
    )
    expect(h.engine.history({}).entries).toEqual([])
    h.clock.advance(MIN)
    await h.engine.ingest("PostToolUse", a("PostToolUse", { tool_name: "Bash", tool_input: input }))
    expect(summary(h.engine.history({}))).toEqual([["permission", "in-claude"]])
    expect(summary(h.engine.history({ q: "deploy" }))).toEqual([["permission", "in-claude"]])
  })

  test("pruned items leave history", async () => {
    const h = await seed()
    h.clock.advance(15 * 24 * 3600_000)
    h.engine.prune(false)
    expect(h.engine.history({}).entries).toEqual([])
  })
})

describe("GET /v1/history", () => {
  const TOKEN = "b".repeat(64)
  const PORT = 4322
  const get = (h: Harness, path: string, auth = true) =>
    uiHandler({
      engine: h.engine,
      token: TOKEN,
      uiDir: "/nonexistent",
      channel: "ga",
      title: "Session Inbox",
      port: PORT,
    } as ServerContext)(
      new Request(`http://127.0.0.1:${PORT}${path}`, {
        headers: {
          host: `127.0.0.1:${PORT}`,
          ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
        },
      }),
    )

  test("answers a HistoryPage for the query in the URL", async () => {
    const h = await seed()
    const r = await get(h, Routes.history({ q: "alpha", kind: "permission", limit: 1 }))
    expect(r.status).toBe(200)
    const page = (await r.json()) as HistoryPage
    expect(summary(page)).toEqual([["permission", "allowed"]])
    expect(page.nextBefore).not.toBeNull()
    const next = await get(
      h,
      Routes.history({ q: "alpha", kind: "permission", before: page.nextBefore }),
    )
    expect(summary((await next.json()) as HistoryPage)).toEqual([["permission", "denied"]])
  })

  test("needs the bearer token and a well-formed query", async () => {
    const h = makeHarness()
    expect((await get(h, "/v1/history", false)).status).toBe(401)
    expect((await get(h, "/v1/history?kind=nope")).status).toBe(400)
    expect((await get(h, "/v1/history?limit=9999")).status).toBe(400)
    expect((await get(h, "/v1/history")).status).toBe(200)
  })
})
