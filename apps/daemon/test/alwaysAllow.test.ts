/**
 * "Always allow" never writes or echoes a rule wider than the call (D-082), and the card is told
 * exactly what it will add and where (C-026).
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { allowAlwaysPermissions, describeSuggestions } from "../src/domain/permissionRequest.ts"
import { ruleMatches, ruleVerdict, scopedAllowRule } from "../src/domain/permissions.ts"
import type { ApiFailure } from "../src/engine.ts"
import { envelope, type Harness, makeClassicHarness, makeHarness } from "./fakes.ts"

const SID = "acacacac-0000-4000-8000-0000000000c1"
const projectDir = () => realpathSync(mkdtempSync("/tmp/si-aa-"))
const ev = (dir: string, event: string, payload: Record<string, unknown>) =>
  envelope(event, { session_id: SID, cwd: dir, permission_mode: "default", ...payload })
const localRules = (dir: string): string[] => {
  const f = join(dir, ".claude", "settings.local.json")
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).permissions.allow : []
}
const itemId = (h: Harness) => h.engine.snapshot().items[0]?.id ?? ""
const card = (h: Harness) => h.engine.itemDetail(itemId(h)).approval?.alwaysAllow
const LOCAL = "in this project's .claude/settings.local.json"

describe("scopedAllowRule", () => {
  test("file tools: exactly that file, as //abs/path", () => {
    for (const tool of ["Edit", "Write", "MultiEdit", "Read"])
      expect(scopedAllowRule(tool, { file_path: "/Users/me/proj/notes.md" })).toBe(
        `${tool}(//Users/me/proj/notes.md)`,
      )
    expect(scopedAllowRule("NotebookEdit", { notebook_path: "/p/a.ipynb" })).toBe(
      "NotebookEdit(//p/a.ipynb)",
    )
    // Relative, missing, or a path a glob would widen: not offered.
    expect(scopedAllowRule("Edit", { file_path: "notes.md" })).toBeNull()
    expect(scopedAllowRule("Edit", {})).toBeNull()
    expect(scopedAllowRule("Edit", { file_path: "/p/*.md" })).toBeNull()
    expect(scopedAllowRule("Write", { file_path: "/p/[a].md" })).toBeNull()
  })
  test("WebFetch by domain, Bash exact, MCP by name, anything else not offered", () => {
    expect(scopedAllowRule("WebFetch", { url: "https://docs.example.com/a?b" })).toBe(
      "WebFetch(domain:docs.example.com)",
    )
    expect(scopedAllowRule("WebFetch", { url: "not a url" })).toBeNull()
    expect(scopedAllowRule("Bash", { command: "make deploy" })).toBe("Bash(make deploy)")
    expect(scopedAllowRule("Bash", { command: "rm *.log" })).toBeNull()
    expect(scopedAllowRule("Bash", { command: "   " })).toBeNull()
    expect(scopedAllowRule("mcp__github__create_issue", {})).toBe("mcp__github__create_issue")
    expect(scopedAllowRule("mcp__github", {})).toBeNull()
    for (const tool of ["Grep", "Glob", "Task", "WebSearch", "AskUserQuestion"])
      expect(scopedAllowRule(tool, { pattern: "x" })).toBeNull()
  })
  test("our own rule matching reads //abs/path", () => {
    expect(ruleMatches("Edit(//p/a.md)", "Edit", { file_path: "/p/a.md" })).toBe(true)
    expect(ruleMatches("Edit(//p/a.md)", "Edit", { file_path: "/p/b.md" })).toBe(false)
    expect(ruleMatches("Read(//p/**)", "Read", { file_path: "/p/x/y" })).toBe(true)
  })
})

describe("echoed suggestions", () => {
  const read = {
    type: "addRules",
    rules: [{ toolName: "Read", ruleContent: "//tmp/si-live/proj/**" }],
    behavior: "allow",
    destination: "session",
  }
  test("a non-MCP rule with no ruleContent, or an unknown destination, is never echoed", () => {
    const bare = { ...read, rules: [{ toolName: "Edit" }] }
    const empty = { ...read, rules: [{ toolName: "Read", ruleContent: " " }] }
    const mcp = { ...read, rules: [{ toolName: "mcp__srv__do" }] }
    const where = { ...read, destination: "cliArg" }
    expect(allowAlwaysPermissions([bare, empty, mcp, where, read])).toEqual([mcp, read])
  })
  test("words name the rule and where it goes", () => {
    expect(describeSuggestions([read])).toBe("Read(//tmp/si-live/proj/**) for this session")
    expect(
      describeSuggestions([
        { ...read, destination: "projectSettings" },
        { ...read, rules: [{ toolName: "mcp__srv__do" }], destination: "userSettings" },
      ]),
    ).toBe(
      "Read(//tmp/si-live/proj/**) in this project's .claude/settings.json; mcp__srv__do in your user settings (all projects)",
    )
  })
})

describe("decide mode (PermissionRequest)", () => {
  const ask = async (dir: string, tool: string, input: unknown, suggestions?: unknown) => {
    const h = makeHarness()
    const r = await h.engine.ingest(
      "PermissionRequest",
      ev(dir, "PermissionRequest", {
        tool_name: tool,
        tool_input: input,
        ...(suggestions === undefined ? {} : { permission_suggestions: suggestions }),
      }),
    )
    return { h, requestId: r.requestId ?? "" }
  }

  test("Edit suggesting setMode acceptEdits: writes that one file's rule, never bare Edit", async () => {
    const dir = projectDir()
    const file = join(dir, "notes.md")
    const { h, requestId } = await ask(
      dir,
      "Edit",
      { file_path: file, old_string: "a", new_string: "b" },
      [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    )
    expect(card(h)).toBe(`Edit(/${file}) ${LOCAL}`)
    h.engine.decide(itemId(h), "allow-always", null)
    expect(await h.engine.waitDecision(requestId, 0)).toEqual({ decision: "allow" })
    expect(localRules(dir)).toEqual([`Edit(/${file})`])
    expect(ruleVerdict(h.claudeDir, [dir], "Edit", { file_path: file })).toBe("allow")
    expect(ruleVerdict(h.claudeDir, [dir], "Edit", { file_path: join(dir, "other.md") })).toBe(
      "none",
    )
  })

  test("Read outside the project with Claude's addRules: echoed, card says for this session", async () => {
    const dir = projectDir()
    const rule = {
      type: "addRules",
      rules: [{ toolName: "Read", ruleContent: "//tmp/si-live/proj/**" }],
      behavior: "allow",
      destination: "session",
    }
    const { h, requestId } = await ask(dir, "Read", { file_path: "/tmp/si-live/proj/a" }, [rule])
    expect(card(h)).toBe("Read(//tmp/si-live/proj/**) for this session")
    h.engine.decide(itemId(h), "allow-always", null)
    expect(await h.engine.waitDecision(requestId, 0)).toEqual({
      decision: "allow",
      updatedPermissions: [rule],
    })
    expect(localRules(dir)).toEqual([])
  })

  test("Read suggesting only addDirectories: scoped file rule instead", async () => {
    const dir = projectDir()
    const { h } = await ask(dir, "Read", { file_path: "/etc/hosts" }, [
      { type: "addDirectories", directories: ["/etc"], destination: "session" },
    ])
    expect(card(h)).toBe(`Read(//etc/hosts) ${LOCAL}`)
    h.engine.decide(itemId(h), "allow-always", null)
    expect(localRules(dir)).toEqual(["Read(//etc/hosts)"])
  })

  test("WebFetch, Bash and MCP tools", async () => {
    const dir = projectDir()
    let t = await ask(dir, "WebFetch", { url: "https://example.com/x", prompt: "p" })
    expect(card(t.h)).toBe(`WebFetch(domain:example.com) ${LOCAL}`)
    t = await ask(dir, "Bash", { command: "make deploy" })
    expect(card(t.h)).toBe(`Bash(make deploy) ${LOCAL}`)
    t = await ask(dir, "mcp__github__create_issue", { title: "x" })
    expect(card(t.h)).toBe(`mcp__github__create_issue ${LOCAL}`)
    t.h.engine.decide(itemId(t.h), "allow-always", null)
    expect(localRules(dir)).toEqual(["mcp__github__create_issue"])
  })

  test("not offered (Grep, an Edit a glob would widen, a bare suggested rule): no words, 409", async () => {
    const dir = projectDir()
    for (const [tool, input, sugg] of [
      ["Grep", { pattern: "TODO" }, undefined],
      ["Edit", { file_path: `${dir}/*.md`, old_string: "a", new_string: "b" }, undefined],
      [
        "Grep",
        { pattern: "x" },
        [
          {
            type: "addRules",
            rules: [{ toolName: "Grep" }],
            behavior: "allow",
            destination: "session",
          },
        ],
      ],
    ] as const) {
      const { h, requestId } = await ask(dir, tool, input, sugg)
      expect(card(h)).toBeUndefined()
      let err: unknown = null
      try {
        h.engine.decide(itemId(h), "allow-always", null)
      } catch (e) {
        err = e
      }
      expect((err as ApiFailure).status).toBe(409)
      // Nothing changed: still live, and a plain Allow still works.
      expect(h.engine.snapshot().items[0]?.live).toBe(true)
      h.engine.decide(itemId(h), "allow", null)
      expect((await h.engine.waitDecision(requestId, 0)).decision).toBe("allow")
    }
    expect(localRules(dir)).toEqual([])
  })
})

describe("classic mode (PreToolUse holds)", () => {
  test("Edit writes that file's rule; the next edit of another file is still held", async () => {
    const dir = projectDir()
    const h = makeClassicHarness()
    const file = join(dir, "a.ts")
    await h.engine.ingest(
      "PreToolUse",
      ev(dir, "PreToolUse", {
        tool_name: "Edit",
        tool_use_id: "e1",
        tool_input: { file_path: file, old_string: "a", new_string: "b" },
      }),
    )
    expect(card(h)).toBe(`Edit(/${file}) ${LOCAL}`)
    h.engine.decide(itemId(h), "allow-always", null)
    expect(localRules(dir)).toEqual([`Edit(/${file})`])
    const same = await h.engine.ingest(
      "PreToolUse",
      ev(dir, "PreToolUse", {
        tool_name: "Edit",
        tool_use_id: "e2",
        tool_input: { file_path: file, old_string: "b", new_string: "c" },
      }),
    )
    expect(same.requestId).toBeNull()
    const other = await h.engine.ingest(
      "PreToolUse",
      ev(dir, "PreToolUse", {
        tool_name: "Edit",
        tool_use_id: "e3",
        tool_input: { file_path: join(dir, "b.ts"), old_string: "b", new_string: "c" },
      }),
    )
    expect(other.requestId).not.toBeNull()
  })

  test("a WebFetch hold offers its domain", async () => {
    const dir = projectDir()
    const h = makeClassicHarness()
    await h.engine.ingest(
      "PreToolUse",
      ev(dir, "PreToolUse", {
        tool_name: "WebFetch",
        tool_use_id: "w1",
        tool_input: { url: "https://api.example.org/v1", prompt: "x" },
      }),
    )
    expect(card(h)).toBe(`WebFetch(domain:api.example.org) ${LOCAL}`)
  })
})
