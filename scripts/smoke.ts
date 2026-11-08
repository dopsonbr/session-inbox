/**
 * End-to-end smoke test: real inboxd process on a temp home, fake Claude payloads
 * over the Unix socket, decisions/answers over HTTP with the token, SSE read as the
 * shell. Needs no Claude account and touches nothing outside /tmp/si-smoke-*.
 *
 *   bun scripts/smoke.ts            # exits non-zero on failure
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Connection, StreamMessage } from "../packages/contracts/src/index.ts"

const repo = resolve(import.meta.dir, "..")
const home = mkdtempSync("/tmp/si-smoke-")
const claudeDir = join(home, "claude")
mkdirSync(claudeDir)
const project = join(home, "proj")
mkdirSync(project)

const report: string[] = []
const fail = (msg: string): never => {
  throw new Error(msg)
}
const check = (cond: unknown, msg: string) => {
  if (!cond) fail(msg)
  report.push(`ok  ${msg}`)
}

const daemon = Bun.spawn(
  ["bun", join(repo, "apps/daemon/src/main.ts"), "--home", home, "--port", "0"],
  {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeDir, // never read the real ~/.claude
      SESSION_INBOX_CLAUDE: "/usr/bin/false", // title generation fails fast → provisional title
      SESSION_INBOX_UI_DIR: join(home, "no-ui"),
    },
    stdout: "ignore",
    stderr: "pipe",
  },
)

const waitFor = async <T>(
  fn: () => T | null | Promise<T | null>,
  what: string,
  ms = 5000,
): Promise<T> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      // not yet
    }
    await Bun.sleep(50)
  }
  return fail(`timed out waiting for ${what}`)
}

let conn: Connection
const sid = "5a0e0000-0000-4000-8000-00000000c0de"
const env = { entrypoint: "cli", hostSessionId: null, claudePid: process.pid }

const hook = async (event: string, payload: Record<string, unknown>) => {
  const r = await fetch(`http://localhost/v1/hooks/${event}`, {
    unix: conn.socketPath,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event,
      payload: {
        session_id: sid,
        cwd: project,
        hook_event_name: event,
        permission_mode: "default",
        ...payload,
      },
      env,
      sentAt: Date.now(),
    }),
  })
  return (await r.json()) as { seq: number; requestId: string | null }
}
const poll = async (requestId: string, wait: number) =>
  (await (
    await fetch(`http://localhost/v1/hooks/decision/${requestId}?wait=${wait}`, {
      unix: conn.socketPath,
    })
  ).json()) as { decision: string; updatedInput?: { answers?: Record<string, string> } }
const api = (path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${conn.httpPort}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${conn.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const main = async () => {
  conn = await waitFor(
    () => JSON.parse(readFileSync(join(home, "connection.json"), "utf8")) as Connection,
    "connection.json",
  )
  const health = await waitFor(
    async () =>
      (
        (await (await fetch(`http://127.0.0.1:${conn.httpPort}/v1/health`)).json()) as {
          ok: boolean
        }
      ).ok,
    "health",
  )
  check(health, `daemon up (port ${conn.httpPort}, socket ${conn.socketPath})`)

  // Shell stream, so notifications go to "the shell" and not osascript.
  const messages: StreamMessage[] = []
  const ctrl = new AbortController()
  const stream = await fetch(`http://127.0.0.1:${conn.httpPort}/v1/stream?client=shell`, {
    headers: { authorization: `Bearer ${conn.token}` },
    signal: ctrl.signal,
  })
  const reading = (async () => {
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader()
    const dec = new TextDecoder()
    let buf = ""
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buf += dec.decode(value)
        let i = buf.indexOf("\n\n")
        while (i >= 0) {
          const data = buf
            .slice(0, i)
            .split("\n")
            .find((l) => l.startsWith("data: "))
          if (data) messages.push(JSON.parse(data.slice(6)) as StreamMessage)
          buf = buf.slice(i + 2)
          i = buf.indexOf("\n\n")
        }
      }
    } catch {
      // aborted
    }
  })()
  await waitFor(() => messages.find((m) => m._tag === "hello") ?? null, "hello")

  await hook("SessionStart", { source: "startup" })
  await hook("UserPromptSubmit", { prompt: "Smoke test the inbox" })

  // Scenario 1: permission hold → Allow from the UI while the hook long-polls.
  const pre = await hook("PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "t1",
    tool_input: { command: "bun run migrate" },
  })
  check(pre.requestId, "PreToolUse(Bash) is held")
  const permNote = await waitFor(
    () => messages.find((m) => m._tag === "notify" && m.notification.critical) ?? null,
    "permission notify",
  )
  const pending = poll(pre.requestId ?? "", 10)
  await Bun.sleep(100)
  const itemId = permNote._tag === "notify" ? permNote.notification.itemId : ""
  const dr = await api(`/v1/items/${itemId}/decision`, {
    idempotencyKey: "smoke-1",
    decision: "allow",
  })
  check(dr.ok, "decision allow accepted over HTTP")
  check((await pending).decision === "allow", "long-poll returned allow")
  await hook("PostToolUse", {
    tool_name: "Bash",
    tool_use_id: "t1",
    tool_input: { command: "bun run migrate" },
    tool_response: {},
  })

  // Scenario 2: AskUserQuestion → answer → updatedInput through the hook.
  const q = await hook("PreToolUse", {
    tool_name: "AskUserQuestion",
    tool_use_id: "t2",
    tool_input: {
      questions: [{ question: "Which tests?", options: [{ label: "Unit" }, { label: "All" }] }],
    },
  })
  check(q.requestId, "AskUserQuestion is held")
  const qNote = await waitFor(
    () =>
      messages.find((m) => m._tag === "notify" && m.notification.actions.includes("answer")) ??
      null,
    "question notify",
  )
  const qItem = qNote._tag === "notify" ? qNote.notification.itemId : ""
  const ar = await api(`/v1/items/${qItem}/answers`, {
    idempotencyKey: "smoke-2",
    answers: [{ idx: 0, selected: ["All"] }],
  })
  check(ar.ok, "answers accepted over HTTP")
  const qd = await poll(q.requestId ?? "", 2)
  check(
    qd.decision === "allow" && qd.updatedInput?.answers?.["Which tests?"] === "All",
    "hook got allow + updatedInput.answers",
  )

  // Scenario 3: the real inbox-hook process holds a Write, and Deny from the UI blocks it.
  const runHook = (event: string, payload: Record<string, unknown>, hookHome = home) => {
    const p = Bun.spawn(["bun", join(repo, "apps/hook/src/main.ts"), event], {
      env: { ...process.env, SESSION_INBOX_HOME: hookHome, SESSION_INBOX_INTERNAL: "" },
      stdin: new Blob([
        JSON.stringify({
          session_id: sid,
          cwd: project,
          hook_event_name: event,
          permission_mode: "default",
          ...payload,
        }),
      ]),
      stdout: "pipe",
      stderr: "pipe",
    })
    return (async () => ({
      code: await p.exited,
      out: (await new Response(p.stdout).text()).trim(),
    }))()
  }
  const before = messages.filter((m) => m._tag === "notify").length
  const held = runHook("PreToolUse", {
    tool_name: "Write",
    tool_use_id: "t3",
    tool_input: { file_path: join(project, "x.txt"), content: "hi" },
  })
  const wNote = await waitFor(
    () => messages.filter((m) => m._tag === "notify")[before] ?? null,
    "write notify",
  )
  const wItem = wNote._tag === "notify" ? wNote.notification.itemId : ""
  check(
    (await api(`/v1/items/${wItem}/decision`, { idempotencyKey: "smoke-3", decision: "deny" })).ok,
    "deny accepted while inbox-hook waits",
  )
  const hr = await held
  const out = JSON.parse(hr.out || "{}") as {
    hookSpecificOutput?: { permissionDecision?: string }
  }
  check(
    hr.code === 0 && out.hookSpecificOutput?.permissionDecision === "deny",
    "inbox-hook printed a deny decision and exited 0",
  )

  // Scenario 4: fail open — no daemon at that home ⇒ exit 0, no output, fast.
  const t0 = performance.now()
  const open = await runHook(
    "PreToolUse",
    { tool_name: "Bash", tool_input: { command: "ls" } },
    join(home, "nowhere"),
  )
  const ms = Math.round(performance.now() - t0)
  check(
    open.code === 0 && open.out === "" && ms < 1500,
    `inbox-hook fails open with no daemon (${ms} ms incl. bun startup)`,
  )

  // Routine activity: nothing.
  await hook("PostToolUse", {
    tool_name: "Read",
    tool_input: { file_path: "README.md" },
    tool_response: {},
  })

  const snap = (await (await api("/v1/snapshot")).json()) as {
    items: { kind: string; state: string }[]
    sessions: { title: string | null }[]
  }
  const notifies = messages.filter((m) => m._tag === "notify").length
  check(notifies === 3, `exactly 3 notifications pushed to the shell (got ${notifies})`)
  check(snap.items.length === 3, `3 items (got ${snap.items.length})`)
  check(
    snap.items.every((i) => i.state === "resolved" || i.state === "answered"),
    "all items answered/resolved",
  )
  check(
    snap.sessions[0]?.title === "Smoke test the inbox",
    "provisional title from the first prompt",
  )
  check(
    messages.some((m) => m._tag === "delta") && messages.some((m) => m._tag === "badge"),
    "deltas and badge streamed",
  )

  ctrl.abort()
  await reading
}

let code = 0
try {
  await main()
} catch (e) {
  code = 1
  report.push(`FAIL ${(e as Error).message}`)
} finally {
  daemon.kill("SIGTERM")
  await daemon.exited
  if (code !== 0) {
    const err = await new Response(daemon.stderr).text()
    report.push("--- daemon stderr ---", err.trim())
  }
  rmSync(home, { recursive: true, force: true })
}
console.log(report.join("\n"))
console.log(code === 0 ? "smoke: PASS" : "smoke: FAIL")
process.exit(code)
