import { describe, expect, test } from "bun:test"
import type { ApprovalPreview } from "@session-inbox/contracts"
import { displayPathFor } from "../src/domain/preview.ts"
import { lastAssistantText } from "../src/domain/text.ts"
import { envelope, FakeGit, makeHarness } from "./fakes.ts"

const SID = "cccccccc-0000-4000-8000-000000000001"
const CWD = "/work/x/apps/web"
const ROOT = "/work/x"
const base = { session_id: SID, cwd: CWD, transcript_path: "/t/s.jsonl" }

const setup = () =>
  makeHarness({ git: new FakeGit({ [CWD]: { root: ROOT, worktree: null, branch: "main" } }) })

/** Ingest one held PreToolUse; returns the stored approval preview, context and summary. */
const hold = async (
  h: ReturnType<typeof makeHarness>,
  tool: string,
  input: unknown,
  extra: Record<string, unknown> = {},
) => {
  const r = await h.engine.ingest(
    "PreToolUse",
    envelope("PreToolUse", { ...base, tool_name: tool, tool_input: input, ...extra }),
  )
  expect(r.requestId).not.toBeNull()
  const item = h.engine.snapshot().items.find((i) => i.kind === "permission")
  const d = h.engine.itemDetail(item?.id ?? "")
  return { preview: d.approval?.preview, context: d.approval?.context, summary: d.item.summary }
}

const asDiff = (p: ApprovalPreview | undefined) => {
  if (p?._tag !== "diff") throw new Error(`expected a diff, got ${p?._tag}`)
  return p
}
const rendered = (p: ApprovalPreview | undefined) =>
  asDiff(p).hunks.flatMap((hk) =>
    hk.lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`),
  )

const FILE = `${ROOT}/src/a.ts`
const CONTENT = `${Array.from({ length: 20 }, (_, i) => `const v${i + 1} = ${i + 1}`).join("\n")}\n`

describe("approval preview: Edit", () => {
  test("match found: real line numbers, file context, display path from the project root", async () => {
    const h = setup()
    h.files.files[FILE] = CONTENT
    const { preview, summary } = await hold(h, "Edit", {
      file_path: FILE,
      old_string: "const v10 = 10",
      new_string: "const v10 = 100\nconst v10b = 101",
    })
    const d = asDiff(preview)
    expect(d.displayPath).toBe("src/a.ts")
    expect(d.approximate).toBe(false)
    expect(d.isNewFile).toBe(false)
    expect([d.added, d.removed]).toEqual([2, 1])
    expect(d.hunks[0]?.oldStart).toBe(7)
    expect(rendered(preview)).toEqual([
      " const v7 = 7",
      " const v8 = 8",
      " const v9 = 9",
      "-const v10 = 10",
      "+const v10 = 100",
      "+const v10b = 101",
      " const v11 = 11",
      " const v12 = 12",
      " const v13 = 13",
    ])
    expect(summary).toBe("Wants to edit src/a.ts +2 −1")
  })

  test("relative file_path resolves against cwd", async () => {
    const h = setup()
    h.files.files[`${CWD}/b.ts`] = "x\n"
    const { preview } = await hold(h, "Edit", {
      file_path: "b.ts",
      old_string: "x",
      new_string: "y",
    })
    expect(asDiff(preview).displayPath).toBe("apps/web/b.ts")
    expect(asDiff(preview).approximate).toBe(false)
  })

  test("old string not found → approximate old vs new from line 1", async () => {
    const h = setup()
    h.files.files[FILE] = CONTENT
    const { preview } = await hold(h, "Edit", {
      file_path: FILE,
      old_string: "nope",
      new_string: "yes",
    })
    expect(asDiff(preview).approximate).toBe(true)
    expect(asDiff(preview).hunks[0]?.oldStart).toBe(1)
    expect(rendered(preview)).toEqual(["-nope", "+yes"])
  })

  test("replace_all changes every occurrence (one hunk each when far apart)", async () => {
    const h = setup()
    h.files.files[FILE] = `${["foo", ...Array.from({ length: 10 }, () => "-"), "foo"].join("\n")}\n`
    const { preview } = await hold(h, "Edit", {
      file_path: FILE,
      old_string: "foo",
      new_string: "bar",
      replace_all: true,
    })
    const d = asDiff(preview)
    expect([d.added, d.removed]).toEqual([2, 2])
    expect(d.hunks).toHaveLength(2)
  })

  test("CRLF file still matches an LF old_string", async () => {
    const h = setup()
    h.files.files[FILE] = "a\r\nb\r\nc\r\n"
    const { preview } = await hold(h, "Edit", {
      file_path: FILE,
      old_string: "b\nc",
      new_string: "B\nc",
    })
    expect(asDiff(preview).approximate).toBe(false)
    expect(rendered(preview)).toEqual([" a", "-b", "+B", " c"])
  })

  test("MultiEdit applies edits in order into one diff", async () => {
    const h = setup()
    h.files.files[FILE] = CONTENT
    const { preview } = await hold(h, "MultiEdit", {
      file_path: FILE,
      edits: [
        { old_string: "const v2 = 2", new_string: "const two = 2" },
        { old_string: "const two = 2", new_string: "const TWO = 2" },
        { old_string: "const v19 = 19", new_string: "" },
      ],
    })
    const d = asDiff(preview)
    expect(d.hunks).toHaveLength(2)
    expect(rendered(preview)).toContain("+const TWO = 2")
    expect(rendered(preview)).not.toContain("+const two = 2")
    expect([d.added, d.removed]).toEqual([2, 2])
  })

  test("file larger than the cap → approximate", async () => {
    const h = setup()
    h.files.files[FILE] = `${"x".repeat(1024 * 1024)}\nold\n`
    const { preview } = await hold(h, "Edit", {
      file_path: FILE,
      old_string: "old",
      new_string: "new",
    })
    expect(asDiff(preview).approximate).toBe(true)
    expect(rendered(preview)).toEqual(["-old", "+new"])
  })

  test("unreadable file → approximate", async () => {
    const h = setup()
    h.files.files[FILE] = "unreadable"
    const { preview } = await hold(h, "Edit", { file_path: FILE, old_string: "a", new_string: "b" })
    expect(asDiff(preview).approximate).toBe(true)
  })
})

describe("approval preview: Write and NotebookEdit", () => {
  test("Write over an existing file diffs against what's on disk", async () => {
    const h = setup()
    h.files.files[FILE] = "one\ntwo\nthree\n"
    const { preview, summary } = await hold(h, "Write", {
      file_path: FILE,
      content: "one\n2\nthree\nfour\n",
    })
    const d = asDiff(preview)
    expect(d.isNewFile).toBe(false)
    expect(rendered(preview)).toEqual([" one", "-two", "+2", " three", "+four"])
    expect(summary).toBe("Wants to write src/a.ts +2 −1")
  })

  test("Write of a new file is all additions, flagged isNewFile", async () => {
    const h = setup()
    const { preview, summary } = await hold(h, "Write", {
      file_path: `${ROOT}/new.md`,
      content: "# Hi\n\ntext\n",
    })
    const d = asDiff(preview)
    expect(d.isNewFile).toBe(true)
    expect(d.added).toBe(3)
    expect(d.hunks[0]?.newStart).toBe(1)
    expect(summary).toBe("Wants to create new.md +3 −0")
  })

  test("Write of binary-looking content: binary, no hunks", async () => {
    const h = setup()
    h.files.files[FILE] = "\u0000\u0001"
    const { preview, summary } = await hold(h, "Write", { file_path: FILE, content: "x" })
    expect(asDiff(preview).binary).toBe(true)
    expect(asDiff(preview).hunks).toEqual([])
    expect(summary).toBe("Wants to write src/a.ts")
  })

  test("NotebookEdit diffs the cell source", async () => {
    const h = setup()
    const nb = `${ROOT}/n.ipynb`
    h.files.files[nb] = JSON.stringify({
      cells: [{ id: "c1", cell_type: "code", source: ["import os\n", "print(1)"] }],
    })
    const { preview } = await hold(h, "NotebookEdit", {
      notebook_path: nb,
      cell_id: "c1",
      new_source: "import os\nprint(2)",
    })
    const d = asDiff(preview)
    expect(d.displayPath).toBe("n.ipynb · cell c1")
    expect(rendered(preview)).toEqual([" import os", "-print(1)", "+print(2)"])
  })
})

describe("approval preview: other tools", () => {
  test("Bash: full command, description, cwd relative to the project root", async () => {
    const h = setup()
    const cmd = "rm -rf build && bun run build --minify --sourcemap=external --outdir dist"
    const { preview, summary } = await hold(h, "Bash", {
      command: cmd,
      description: "Rebuild from scratch",
      timeout: 60000,
      run_in_background: false,
    })
    expect(preview).toEqual({
      _tag: "command",
      command: cmd,
      description: "Rebuild from scratch",
      cwd: CWD,
      displayCwd: "apps/web",
      background: false,
      timeoutMs: 60000,
    })
    expect(summary?.startsWith("Wants to run rm -rf build")).toBe(true)
  })

  test("WebFetch: url and prompt", async () => {
    const h = setup()
    const { preview } = await hold(h, "WebFetch", {
      url: "https://example.com/docs",
      prompt: "Summarise the API",
    })
    expect(preview).toEqual({
      _tag: "fetch",
      url: "https://example.com/docs",
      prompt: "Summarise the API",
    })
  })

  test("unknown tool: pretty-printed input, truncated", async () => {
    const h = makeHarness({ settings: { "holds.tools": ["mcp__db__query"] } })
    const { preview } = await hold(h, "mcp__db__query", { sql: "x".repeat(5000) })
    expect(preview?._tag).toBe("generic")
    if (preview?._tag !== "generic") return
    expect(preview.truncated).toBe(true)
    expect(preview.text.startsWith('{\n  "sql": "xxx')).toBe(true)
  })

  test("a throwing Files service never fails the hold", async () => {
    const h = setup()
    h.files.read = () => {
      throw new Error("disk on fire")
    }
    h.files.tail = () => {
      throw new Error("disk on fire")
    }
    const r = await h.engine.ingest(
      "PreToolUse",
      envelope("PreToolUse", {
        ...base,
        tool_name: "Edit",
        tool_input: { file_path: FILE, old_string: "a", new_string: "b" },
      }),
    )
    expect(r.requestId).not.toBeNull()
    const item = h.engine.snapshot().items[0]
    expect(item?.summary).toBe("Wants to edit src/a.ts") // project-relative (D-064)
    expect(h.engine.itemDetail(item?.id ?? "").approval?.preview).toBeUndefined()
  })

  test("not held (acceptEdits): no file is read", async () => {
    const h = setup()
    h.files.files[FILE] = CONTENT
    const r = await h.engine.ingest(
      "PreToolUse",
      envelope("PreToolUse", {
        ...base,
        permission_mode: "acceptEdits",
        tool_name: "Edit",
        tool_input: { file_path: FILE, old_string: "a", new_string: "b" },
      }),
    )
    expect(r.requestId).toBeNull()
    expect(h.files.reads).toEqual([])
  })
})

describe("approval context", () => {
  const line = (o: unknown) => JSON.stringify(o)
  const asst = (content: unknown) =>
    line({ type: "assistant", message: { role: "assistant", content } })
  const user = (content: unknown) => line({ type: "user", message: { role: "user", content } })

  test("the assistant text before the tool_use, from the transcript tail", async () => {
    const h = setup()
    h.files.tails["/t/s.jsonl"] = [
      '{"cut": tr', // first line of a tail is usually cut
      user("fix the bug"),
      asst([{ type: "text", text: "Looking at the parser." }]),
      asst([{ type: "tool_use", id: "tu_0", name: "Read" }]),
      user([{ type: "tool_result", tool_use_id: "tu_0", content: "..." }]),
      asst([
        { type: "text", text: "The off-by-one is in   parse().\nI'll fix it." },
        { type: "tool_use", id: "tu_1", name: "Edit" },
      ]),
    ].join("\n")
    h.files.files[FILE] = "a\n"
    const { context } = await hold(
      h,
      "Edit",
      { file_path: FILE, old_string: "a", new_string: "b" },
      { tool_use_id: "tu_1" },
    )
    expect(context).toBe("The off-by-one is in parse(). I'll fix it.")
  })

  test("text written to the transcript after the hold is picked up when the item is opened", async () => {
    // Found live: the hook fires before Claude has flushed its message (D-066).
    const h = setup()
    h.files.tails["/t/s.jsonl"] = [user("make the change")].join("\n")
    h.files.files[FILE] = "a\n"
    const first = await hold(
      h,
      "Edit",
      { file_path: FILE, old_string: "a", new_string: "b" },
      { tool_use_id: "tu_9" },
    )
    expect(first.context).toBeUndefined()
    const item = h.engine.snapshot().items.find((i) => i.kind === "permission")
    // Later text with no sign of this call must not be taken for its context.
    h.files.tails["/t/s.jsonl"] = [
      user("make the change"),
      asst([{ type: "text", text: "Something about another call." }]),
    ].join("\n")
    expect(h.engine.itemDetail(item?.id ?? "").approval?.context).toBeUndefined()
    h.files.tails["/t/s.jsonl"] = [
      user("make the change"),
      asst([{ type: "text", text: "I'll change a to b." }]),
      asst([{ type: "tool_use", id: "tu_9", name: "Edit" }]),
      user([{ type: "tool_result", tool_use_id: "tu_9", content: "ok" }]),
      asst([{ type: "text", text: "Done." }]),
    ].join("\n")
    expect(h.engine.itemDetail(item?.id ?? "").approval?.context).toBe("I'll change a to b.")
    // Stored: a transcript that has since moved on doesn't lose it.
    h.files.tails["/t/s.jsonl"] = ""
    expect(h.engine.itemDetail(item?.id ?? "").approval?.context).toBe("I'll change a to b.")
  })

  test("pure helper: skips tool results, stops at a typed prompt, trims at a word", () => {
    const tail = [
      asst([{ type: "text", text: "old turn" }]),
      user("new prompt"),
      asst([{ type: "tool_use", id: "tu_1" }]),
    ].join("\n")
    expect(lastAssistantText(tail, "tu_1")).toBeNull()
    const long = [asst([{ type: "text", text: "word ".repeat(300) }])].join("\n")
    const t = lastAssistantText(long, null) ?? ""
    expect(t.length).toBeLessThanOrEqual(600)
    expect(t.endsWith("word…")).toBe(true)
    // Text after the tool_use block in the same entry doesn't count; earlier entries do.
    const after = [
      asst([{ type: "text", text: "before" }]),
      asst([
        { type: "tool_use", id: "tu_2" },
        { type: "text", text: "after" },
      ]),
    ].join("\n")
    expect(lastAssistantText(after, "tu_2")).toBe("before")
    expect(lastAssistantText(null, null)).toBeNull()
    expect(lastAssistantText("garbage\n{", null)).toBeNull()
  })
})

describe("displayPathFor", () => {
  test("first base that contains the path wins; outside paths stay absolute", () => {
    expect(displayPathFor("/r/wt/src/a.ts", ["/r/wt", "/r", "/r/wt/src"])).toBe("src/a.ts")
    expect(displayPathFor("/r/src/a.ts", [null, "/r/"])).toBe("src/a.ts")
    expect(displayPathFor("/rx/a.ts", ["/r"])).toBe("/rx/a.ts")
    expect(displayPathFor("/r", ["/r"])).toBe(".")
  })
})
