import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "../../..")
const entry = join(root, "apps/hook/src/main.ts")

// Short dir: macOS caps Unix socket paths at 104 bytes.
const home = mkdtempSync("/tmp/sih-")
const binDir = mkdtempSync("/tmp/sih-bin-")
const compiled = join(binDir, "inbox-hook")

type Handler = (req: Request) => Response | Promise<Response>
let handler: Handler = () => Response.json({ seq: 1, requestId: null })
const requests: { method: string; path: string; body: unknown }[] = []
let server: ReturnType<typeof Bun.serve> | null = null

const startDaemon = () => {
  server = Bun.serve({
    unix: join(home, "inboxd.sock"),
    async fetch(req) {
      const url = new URL(req.url)
      requests.push({
        method: req.method,
        path: url.pathname + url.search,
        body: req.method === "POST" ? await req.json() : null,
      })
      return handler(req)
    },
  })
}

const payload = { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Bash" }

const exec = async (
  cmd: string[],
  args: string[],
  extraEnv: Record<string, string> = {},
  stdin: string = JSON.stringify(payload),
) => {
  const p = Bun.spawn([...cmd, ...args], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH, SESSION_INBOX_HOME: home, ...extraEnv },
  })
  const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  return { stdout, code }
}

const variants: [string, string[]][] = [["source", ["bun", entry]]]

beforeAll(async () => {
  const b = Bun.spawnSync(
    ["bun", "build", "--compile", "--minify", "--bytecode", entry, "--outfile", compiled],
    { cwd: root },
  )
  expect(b.exitCode).toBe(0) // the compiled binary must build
  variants.push(["compiled", [compiled]])
  // First exec of a fresh 90 MB binary pays a one-off macOS scan (~700 ms); warm it.
  await exec([compiled], ["Stop"], { SESSION_INBOX_INTERNAL: "1" })
})

afterAll(() => {
  server?.stop(true)
  rmSync(home, { recursive: true, force: true })
  rmSync(binDir, { recursive: true, force: true })
})

// Fail-open runs before any daemon exists (no socket file).
describe("no daemon", () => {
  for (const [name, cmd] of [["source", ["bun", entry]] as [string, string[]]]) {
    test(`${name}: fails open fast`, async () => {
      const t = performance.now()
      const r = await exec(cmd, ["PreToolUse"])
      expect(r.code).toBe(0)
      expect(r.stdout).toBe("")
      expect(performance.now() - t).toBeLessThan(2000)
    })
  }
  test("compiled: fails open fast", async () => {
    const t = performance.now()
    const r = await exec([compiled], ["PreToolUse"])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe("")
    expect(performance.now() - t).toBeLessThan(500)
  })
  test("PermissionRequest fails open with no daemon", async () => {
    for (const cmd of [["bun", entry], [compiled]]) {
      const r = await exec(
        cmd,
        ["PermissionRequest"],
        {},
        JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }),
      )
      expect(r).toEqual({ stdout: "", code: 0 })
    }
  })
  test("bad stdin JSON fails open", async () => {
    const r = await exec(["bun", entry], ["Stop"], {}, "not json{")
    expect(r.code).toBe(0)
    expect(r.stdout).toBe("")
  })
})

describe("with fake daemon", () => {
  beforeAll(startDaemon)

  const each = (fn: (cmd: string[]) => Promise<void>) => async () => {
    for (const [, cmd] of variants) {
      requests.length = 0
      await fn(cmd)
    }
  }

  test(
    "ingest without hold prints nothing and posts the envelope",
    each(async (cmd) => {
      handler = () => Response.json({ seq: 7, requestId: null })
      const r = await exec(cmd, ["Stop"], {
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CLAUDE_PID: "4242",
      })
      expect(r).toEqual({ stdout: "", code: 0 })
      expect(requests).toHaveLength(1)
      const req = requests[0]
      expect(req?.path).toBe("/v1/hooks/Stop")
      expect(req?.body).toMatchObject({
        event: "Stop",
        payload,
        env: { entrypoint: "cli", hostSessionId: null, claudePid: 4242 },
      })
      expect(typeof (req?.body as { sentAt: number } | null)?.sentAt).toBe("number")
    }),
  )

  test(
    "hold then allow prints PreToolUse decision JSON",
    each(async (cmd) => {
      handler = (req) =>
        new URL(req.url).pathname === "/v1/hooks/PreToolUse"
          ? Response.json({ seq: 1, requestId: "r1" })
          : Response.json({ decision: "allow", reason: "ok from inbox" })
      const r = await exec(cmd, ["PreToolUse"])
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "ok from inbox",
        },
      })
      expect(requests[1]?.path).toMatch(/^\/v1\/hooks\/decision\/r1\?wait=\d+$/)
    }),
  )

  test(
    "updatedInput passes through",
    each(async (cmd) => {
      const updatedInput = { questions: [], answers: { q: "yes" } }
      handler = (req) =>
        new URL(req.url).pathname === "/v1/hooks/PreToolUse"
          ? Response.json({ seq: 1, requestId: "r2" })
          : Response.json({ decision: "allow", updatedInput })
      const r = await exec(cmd, ["PreToolUse"])
      const out = JSON.parse(r.stdout)
      expect(out.hookSpecificOutput.updatedInput).toEqual(updatedInput)
    }),
  )

  test(
    "budget lapse prints ask",
    each(async (cmd) => {
      handler = (req) =>
        new URL(req.url).pathname === "/v1/hooks/PreToolUse"
          ? Response.json({ seq: 1, requestId: "r3" })
          : Response.json({ decision: "pending" })
      const r = await exec(cmd, ["PreToolUse"], { SESSION_INBOX_HOLD_SECONDS: "1" })
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask")
    }),
  )

  test(
    "internal env makes no request",
    each(async (cmd) => {
      const r = await exec(cmd, ["PreToolUse"], { SESSION_INBOX_INTERNAL: "1" })
      expect(r).toEqual({ stdout: "", code: 0 })
      expect(requests).toHaveLength(0)
    }),
  )

  test(
    "record mode writes a line (no secrets) and forwards",
    each(async (cmd) => {
      handler = () => Response.json({ seq: 1, requestId: null })
      const out = join(home, "rec.jsonl")
      rmSync(out, { force: true })
      const r = await exec(cmd, ["record", "Stop", "--out", out], {
        CLAUDE_CODE_HOST_SESSION_ID: "local_x",
        ANTHROPIC_API_KEY: "sk-secret",
      })
      expect(r.code).toBe(0)
      const text = readFileSync(out, "utf8")
      expect(text.trim().split("\n")).toHaveLength(1)
      expect(text).not.toContain("sk-secret")
      expect(JSON.parse(text)).toMatchObject({
        event: "Stop",
        payload,
        env: { hostSessionId: "local_x" },
      })
      expect(requests).toHaveLength(1)
    }),
  )

  // PermissionRequest output must be exactly the documented shape (hooks reference).
  const prPayload = JSON.stringify({
    session_id: "s1",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "rm -rf node_modules" },
  })
  const decided = (body: Record<string, unknown>) => (req: Request) =>
    new URL(req.url).pathname === "/v1/hooks/PermissionRequest"
      ? Response.json({ seq: 1, requestId: "pr1", holdMs: 600_000 })
      : Response.json(body)
  const pr = (cmd: string[], extraEnv: Record<string, string> = {}) =>
    exec(cmd, ["PermissionRequest"], extraEnv, prPayload)

  test(
    "PermissionRequest observed (no requestId): nothing printed, one request",
    each(async (cmd) => {
      handler = () => Response.json({ seq: 3, requestId: null })
      expect(await pr(cmd)).toEqual({ stdout: "", code: 0 })
      expect(requests.map((r) => r.path)).toEqual(["/v1/hooks/PermissionRequest"])
    }),
  )

  test(
    "PermissionRequest allow",
    each(async (cmd) => {
      handler = decided({ decision: "allow", reason: "ignored for PermissionRequest" })
      const r = await pr(cmd)
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual({
        hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
      })
      expect(requests[1]?.path).toMatch(/^\/v1\/hooks\/decision\/pr1\?wait=\d+$/)
    }),
  )

  test(
    "PermissionRequest allow + updatedInput",
    each(async (cmd) => {
      const updatedInput = { questions: [], answers: { "Which?": "A" } }
      handler = decided({ decision: "allow", updatedInput })
      expect(JSON.parse((await pr(cmd)).stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow", updatedInput },
        },
      })
    }),
  )

  test(
    "PermissionRequest allow + updatedPermissions",
    each(async (cmd) => {
      const updatedPermissions = [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "rm -rf node_modules" }],
          behavior: "allow",
          destination: "localSettings",
        },
      ]
      handler = decided({ decision: "allow", updatedPermissions })
      expect(JSON.parse((await pr(cmd)).stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow", updatedPermissions },
        },
      })
    }),
  )

  test(
    "PermissionRequest deny + message",
    each(async (cmd) => {
      handler = decided({ decision: "deny", reason: "The user replied: use rimraf" })
      expect(JSON.parse((await pr(cmd)).stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny", message: "The user replied: use rimraf", interrupt: false },
        },
      })
    }),
  )

  test(
    "PermissionRequest ask prints nothing (Claude's prompt stays)",
    each(async (cmd) => {
      handler = decided({ decision: "ask" })
      expect(await pr(cmd)).toEqual({ stdout: "", code: 0 })
    }),
  )

  test(
    "PermissionRequest budget lapse prints nothing",
    each(async (cmd) => {
      handler = decided({ decision: "pending" })
      expect(await pr(cmd, { SESSION_INBOX_HOLD_SECONDS: "1" })).toEqual({ stdout: "", code: 0 })
    }),
  )

  test(
    "PermissionRequest: a daemon error mid-wait prints nothing",
    each(async (cmd) => {
      handler = (req) =>
        new URL(req.url).pathname === "/v1/hooks/PermissionRequest"
          ? Response.json({ seq: 1, requestId: "pr2", holdMs: 600_000 })
          : new Response("boom", { status: 500 })
      expect(await pr(cmd)).toEqual({ stdout: "", code: 0 })
    }),
  )

  test("record --no-forward does not contact the daemon; default path under home/fixtures", async () => {
    requests.length = 0
    const r = await exec(["bun", entry], ["record", "Stop", "--no-forward"])
    expect(r.code).toBe(0)
    expect(requests).toHaveLength(0)
    expect(existsSync(join(home, "fixtures"))).toBe(true)
  })
})
