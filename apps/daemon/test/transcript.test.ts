/**
 * Reading the transcript after the fact (D-075, D-076), the inbox's deny message (D-078) and
 * review summaries from Markdown (D-077).
 */
import { describe, expect, test } from "bun:test"
import { summaryLine } from "../src/domain/text.ts"
import { DENIED_IN_INBOX } from "../src/engine.ts"
import { envelope, type Harness, makeClassicHarness, makeHarness } from "./fakes.ts"

const SID = "ffffffff-0000-4000-8000-0000000000f1"
const T = "/t/session.jsonl"
const base = { session_id: SID, cwd: "/work/x", permission_mode: "default", transcript_path: T }
const ev = (event: string, payload: Record<string, unknown>) =>
  envelope(event, { ...base, ...payload })

const use = (id: string, name: string, input: unknown, text?: string) =>
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [...(text ? [{ type: "text", text }] : []), { type: "tool_use", id, name, input }],
    },
  })
const result = (id: string, isError = false) =>
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: isError ? "denied" : "ok",
          is_error: isError,
        },
      ],
    },
  })
const write = (h: Harness, ...lines: string[]) => {
  h.files.tails[T] = `${lines.join("\n")}\n`
}
const after = (h: Harness, ms: number) => {
  h.clock.advance(ms)
  h.engine.tick()
}
const shape = (h: Harness) => h.engine.snapshot().items.map((i) => [i.summary, i.state, i.live])
const hooks = (h: Harness) =>
  h.engine.store.all<{ hook: string }>("SELECT hook FROM events ORDER BY seq").map((e) => e.hook)

const EDIT = { file_path: "/work/x/notes.md", old_string: "draft", new_string: "final" }
const READ = { file_path: "/work/x/notes.md" }

describe("approval context is this call's, or absent (D-075)", () => {
  test("at hold time the call's block isn't written: no context, not the previous step's", async () => {
    const h = makeHarness()
    write(h, use("tu0", "Read", READ, "I'm about to read notes.md."), result("tu0"))
    await h.engine.ingest(
      "PreToolUse",
      ev("PreToolUse", { tool_name: "Edit", tool_use_id: "tu1", tool_input: EDIT }),
    )
    await h.engine.ingest(
      "PermissionRequest",
      ev("PermissionRequest", { tool_name: "Edit", tool_input: EDIT }),
    )
    const id = h.engine.snapshot().items[0]?.id ?? ""
    expect(h.engine.store.approval(id)?.context ?? null).toBeNull()

    // Claude writes its sentence and the call; the tick picks it up and tells open panes.
    write(
      h,
      use("tu0", "Read", READ, "I'm about to read notes.md."),
      result("tu0"),
      use("tu1", "Edit", EDIT, "Now I'll mark notes.md final."),
    )
    const published: string[] = []
    const publish = h.engine.hub.publish.bind(h.engine.hub)
    h.engine.hub.publish = (m) => {
      if (m._tag === "delta") published.push(...m.items.map((i) => i.id))
      publish(m)
    }
    after(h, 1_500)
    expect(h.engine.store.approval(id)?.context).toBe("Now I'll mark notes.md final.")
    expect(hooks(h)).toContain("daemon:context")
    expect(published).toContain(id)
    expect(shape(h)[0]?.[1]).toBe("open") // a block without a result doesn't end it
  })

  test("a call with no PreToolUse (Read): its tool_use_id comes from the transcript", async () => {
    const h = makeHarness()
    await h.engine.ingest(
      "PermissionRequest",
      ev("PermissionRequest", { tool_name: "Read", tool_input: READ }),
    )
    const id = h.engine.snapshot().items[0]?.id ?? ""
    expect(h.engine.store.approval(id)?.tool_use_id).toBeNull()
    write(h, use("tr1", "Read", READ, "Let me look at the notes first."))
    after(h, 1_500)
    expect(h.engine.store.approval(id)?.tool_use_id).toBe("tr1")
    expect(h.engine.store.approval(id)?.context).toBe("Let me look at the notes first.")
  })
})

describe("answered in Claude, from the transcript (D-076)", () => {
  const bash = (command: string) => ({ command })
  const ask = async (h: Harness, id: string, command: string) => {
    await h.engine.ingest(
      "PreToolUse",
      ev("PreToolUse", { tool_name: "Bash", tool_use_id: id, tool_input: bash(command) }),
    )
    return h.engine.ingest(
      "PermissionRequest",
      ev("PermissionRequest", { tool_name: "Bash", tool_input: bash(command) }),
    )
  }

  test("denied in Claude (an error tool_result): resolved, the waiting hook exits silently", async () => {
    const h = makeHarness()
    const r = await ask(h, "tb1", "rm -rf build")
    write(h, use("tb1", "Bash", bash("rm -rf build")), result("tb1", true))
    after(h, 1_000)
    expect(shape(h)[0]?.[1]).toBe("open") // not before ~2 s
    after(h, 1_500)
    expect(shape(h)).toEqual([["Wants to run rm -rf build", "resolved", false]])
    expect(await h.engine.waitDecision(r.requestId ?? "", 0)).toEqual({ decision: "ask" })
    expect(hooks(h)).toContain("daemon:answered-in-claude")
    expect(h.engine.snapshot().counts.needsYou).toBe(0)
  })

  test("allowed in Claude and still running (no tool_result yet): stays", async () => {
    const h = makeHarness()
    await ask(h, "tb1", "make test")
    write(h, use("tb1", "Bash", bash("make test")))
    after(h, 5_000)
    expect(shape(h)).toEqual([["Wants to run make test", "open", true]])
  })

  test("parallel calls: only the call with a result resolves", async () => {
    const h = makeHarness()
    await ask(h, "ta", "make a")
    await ask(h, "tb", "make b")
    write(h, use("ta", "Bash", bash("make a")), use("tb", "Bash", bash("make b")), result("ta"))
    after(h, 3_000)
    expect(shape(h)).toEqual([
      ["Wants to run make a", "resolved", false],
      ["Wants to run make b", "open", true],
    ])
  })

  test("a lapsed classic hold resolves the same way", async () => {
    const h = makeClassicHarness()
    await h.engine.ingest(
      "PreToolUse",
      ev("PreToolUse", { tool_name: "Bash", tool_use_id: "tc", tool_input: bash("rm x") }),
    )
    after(h, 120_001)
    expect(shape(h)[0]?.[1]).toBe("open")
    write(h, use("tc", "Bash", bash("rm x")), result("tc", true))
    after(h, 1_000)
    expect(shape(h)[0]?.[1]).toBe("resolved")
  })

  test("an earlier identical call that already ran doesn't count", async () => {
    const h = makeHarness()
    const old = new Date(h.clock.now() - 60_000).toISOString()
    h.files.tails[T] =
      `${JSON.stringify({ ...JSON.parse(use("t-old", "Read", READ)), timestamp: old })}\n${result("t-old")}\n`
    await h.engine.ingest(
      "PermissionRequest",
      ev("PermissionRequest", { tool_name: "Read", tool_input: READ }),
    )
    after(h, 3_000)
    expect(shape(h)[0]?.[1]).toBe("open")
  })

  const at = (line: string, ms: number) =>
    JSON.stringify({ ...JSON.parse(line), timestamp: new Date(ms).toISOString() })

  test("an identical call that already ran, inside the timestamp slack, isn't this one (D-088)", async () => {
    const h = makeHarness()
    const t0 = h.clock.now()
    write(h, at(use("t-prev", "Read", READ), t0 - 2_000), at(result("t-prev"), t0 - 1_000))
    await h.engine.ingest(
      "PermissionRequest",
      ev("PermissionRequest", { tool_name: "Read", tool_input: READ }),
    )
    after(h, 3_000)
    const id = h.engine.snapshot().items[0]?.id ?? ""
    expect(shape(h)[0]?.[1]).toBe("open")
    expect(h.engine.store.approval(id)?.tool_use_id).toBeNull()
    // The real call shows up without a result: that one is taken.
    write(
      h,
      at(use("t-prev", "Read", READ), t0 - 2_000),
      at(result("t-prev"), t0 - 1_000),
      at(use("t-now", "Read", READ), t0 + 500),
    )
    after(h, 1_000)
    expect(h.engine.store.approval(id)?.tool_use_id).toBe("t-now")
    expect(shape(h)[0]?.[1]).toBe("open")
  })

  test("a tool_result older than the item never resolves it (D-088)", async () => {
    const h = makeHarness()
    const t0 = h.clock.now()
    await ask(h, "tb1", "make")
    write(h, at(use("tb1", "Bash", bash("make")), t0 - 1_000), at(result("tb1"), t0 - 500))
    after(h, 3_000)
    expect(shape(h)[0]?.[1]).toBe("open")
    write(h, at(use("tb1", "Bash", bash("make")), t0 - 1_000), at(result("tb1"), t0 + 2_500))
    after(h, 1_000)
    expect(shape(h)[0]?.[1]).toBe("resolved")
  })

  test("once the call's block can't be in the tail any more, the transcript isn't read for it (D-089)", async () => {
    const h = makeHarness()
    const t0 = h.clock.now()
    await ask(h, "tb1", "make")
    let reads = 0
    const tail = h.files.tail
    h.files.tail = (p, n) => {
      reads++
      return tail(p, n)
    }
    after(h, 2_000)
    expect(reads).toBe(1)
    // Much later: the tail holds only newer entries, none of them this call.
    h.clock.advance(70_000)
    write(h, at(use("other", "Bash", bash("ls")), t0 + 65_000), at(result("other"), t0 + 66_000))
    after(h, 1_000)
    expect(reads).toBe(2)
    after(h, 1_000)
    after(h, 1_000)
    expect(reads).toBe(2)
    expect(shape(h)[0]?.[1]).toBe("open") // other signals still end it
    await h.engine.ingest("Stop", ev("Stop", {}))
    expect(shape(h)[0]?.[1]).toBe("resolved")
  })

  test("no transcript, or an unreadable one: nothing happens, nothing throws", async () => {
    const h = makeHarness()
    await ask(h, "tb1", "ls -la /")
    after(h, 3_000)
    h.files.tail = () => {
      throw new Error("boom")
    }
    after(h, 3_000)
    expect(shape(h)[0]?.[1]).toBe("open")
  })
})

describe("deny message (D-078)", () => {
  test("PermissionRequest deny tells Claude who said no", async () => {
    const h = makeHarness()
    const r = await h.engine.ingest(
      "PermissionRequest",
      ev("PermissionRequest", { tool_name: "Bash", tool_input: { command: "x" } }),
    )
    h.engine.decide(h.engine.snapshot().items[0]?.id ?? "", "deny", null)
    expect(await h.engine.waitDecision(r.requestId ?? "", 0)).toEqual({
      decision: "deny",
      reason: DENIED_IN_INBOX,
    })
  })
  test("classic PreToolUse deny carries the same sentence as its reason", async () => {
    const h = makeClassicHarness()
    const r = await h.engine.ingest(
      "PreToolUse",
      ev("PreToolUse", { tool_name: "Bash", tool_use_id: "t", tool_input: { command: "rm x" } }),
    )
    h.engine.decide(h.engine.snapshot().items[0]?.id ?? "", "deny", null)
    expect((await h.engine.waitDecision(r.requestId ?? "", 0)).reason).toBe(DENIED_IN_INBOX)
  })
  test("a reply keeps its own text", async () => {
    const h = makeHarness()
    const r = await h.engine.ingest(
      "PermissionRequest",
      ev("PermissionRequest", { tool_name: "Bash", tool_input: { command: "x" } }),
    )
    h.engine.reply(h.engine.snapshot().items[0]?.id ?? "", "k", "not now")
    expect((await h.engine.waitDecision(r.requestId ?? "", 0)).reason).toBe(
      "The user replied: not now",
    )
  })
})

describe("review summaries from Markdown (D-077)", () => {
  test("summaryLine strips headings, list and emphasis markers", () => {
    expect(summaryLine("## Results\n\nAll 42 tests pass.")).toBe("Results")
    expect(summaryLine("#\n\n---\n**Done.** Fixed rounding")).toBe("Done. Fixed rounding")
    expect(summaryLine("- *first* item\n- second")).toBe("first item")
    expect(summaryLine("1. Ran the migration")).toBe("Ran the migration")
    expect(summaryLine("> quoted")).toBe("quoted")
    expect(summaryLine("   \n\n")).toBeNull()
    expect(summaryLine(`# ${"x".repeat(200)}`)?.length).toBe(100)
  })
  test("a Stop whose message starts with a heading reads well on the card", async () => {
    const h = makeHarness()
    await h.engine.ingest(
      "Stop",
      ev("Stop", { last_assistant_message: "## Results\n\nAll 42 tests pass." }),
    )
    expect(h.engine.snapshot().items.map((i) => [i.kind, i.summary])).toEqual([
      ["review", "Results"],
    ])
  })
})
