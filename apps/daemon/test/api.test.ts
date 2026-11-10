import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Connection, Routes, type StreamMessage } from "@session-inbox/contracts"
import { type DaemonHandle, startDaemon } from "../src/daemon.ts"
import { FakeClaude, FakeClock, FakeGit, FakeNotifier, FakeOpener, silentLog } from "./fakes.ts"

let home: string
let uiDir: string
let d: DaemonHandle
const clock = new FakeClock()
const notifier = new FakeNotifier()
const opener = new FakeOpener()
const claude = new FakeClaude()

const base = () => `http://127.0.0.1:${d.port}`
const auth = () => ({ authorization: `Bearer ${d.token}`, "content-type": "application/json" })
const api = (path: string, init: RequestInit = {}) =>
  fetch(base() + path, { ...init, headers: { ...auth(), ...(init.headers ?? {}) } })
const post = (path: string, body: unknown) =>
  api(path, { method: "POST", body: JSON.stringify(body) })
const hook = (event: string, payload: Record<string, unknown>, env: Record<string, unknown> = {}) =>
  fetch(`http://localhost${Routes.hookIngest(event)}`, {
    unix: d.socketPath,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event,
      payload: { hook_event_name: event, ...payload },
      env: { entrypoint: "cli", hostSessionId: null, claudePid: 1, ...env },
      sentAt: Date.now(),
    }),
  }).then((r) => r.json() as Promise<{ seq: number; requestId: string | null }>)
const poll = (requestId: string, wait: number) =>
  fetch(`http://localhost${Routes.hookDecision(requestId, wait)}`, { unix: d.socketPath }).then(
    (r) => r.json() as Promise<{ decision: string; updatedInput?: unknown; reason?: string }>,
  )

/** Read SSE frames from a stream until `n` messages are collected or the timeout hits. */
const readStream = async (path: string, n: number, timeoutMs = 1500) => {
  const ctrl = new AbortController()
  const res = await fetch(base() + path, { headers: auth(), signal: ctrl.signal })
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  const msgs: StreamMessage[] = []
  let buf = ""
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    while (msgs.length < n) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value)
      let i = buf.indexOf("\n\n")
      while (i >= 0) {
        const frame = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const data = frame.split("\n").find((l) => l.startsWith("data: "))
        if (data) msgs.push(JSON.parse(data.slice(6)) as StreamMessage)
        i = buf.indexOf("\n\n")
      }
    }
  } catch {
    // aborted
  } finally {
    clearTimeout(timer)
    ctrl.abort()
  }
  return msgs
}

const projectDir = () => join(home, "proj")

beforeAll(async () => {
  home = mkdtempSync("/tmp/si-api-")
  uiDir = join(home, "ui")
  mkdirSync(uiDir)
  mkdirSync(projectDir())
  writeFileSync(
    join(uiDir, "index.html"),
    '<html><head><meta name="session-inbox-token" content=""></head><body>ui</body></html>',
  )
  writeFileSync(join(uiDir, "app.js"), "console.log(1)")
  const claudeDir = join(home, "claude")
  mkdirSync(claudeDir)
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash(npm test:*)"] } }),
  )
  d = await startDaemon(
    {
      home,
      port: 0,
      uiDir,
      claudeConfigDir: claudeDir,
      // Classic PreToolUse holds: these round trips hold and decide them (D-074).
      settings: { "titles.generate": false, "holds.via": "preToolUse" },
    },
    { clock, git: new FakeGit(), claude, notifier, opener, log: silentLog },
  )
})
afterAll(async () => {
  await d.stop()
  rmSync(home, { recursive: true, force: true })
})

describe("startup files", () => {
  test("token and connection.json are 0600; socket is 0600", () => {
    const conn = JSON.parse(readFileSync(join(home, "connection.json"), "utf8")) as Connection
    expect(conn.httpPort).toBe(d.port)
    expect(conn.token).toBe(d.token)
    expect(conn.socketPath).toBe(d.socketPath)
    for (const f of ["connection.json", "token", "inboxd.sock"])
      expect(statSync(join(home, f)).mode & 0o777).toBe(0o600)
  })
})

describe("security", () => {
  test("health needs no token", async () => {
    const r = await fetch(`${base()}/v1/health`)
    expect(r.status).toBe(200)
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true)
  })
  test("API needs the bearer token", async () => {
    expect((await fetch(`${base()}/v1/snapshot`)).status).toBe(401)
    expect((await api("/v1/snapshot")).status).toBe(200)
  })
  test("bad Host header is rejected (DNS rebinding)", async () => {
    const r = await fetch(`${base()}/v1/snapshot`, {
      headers: { ...auth(), host: "evil.example:80" },
    })
    expect(r.status).toBe(403)
  })
  test("hooks are not served on TCP", async () => {
    const r = await post("/v1/hooks/Stop", {})
    expect(r.status).toBe(404)
  })
})

describe("static UI", () => {
  test("the token is injected only for ?k= or the cookie; assets are public (D-095)", async () => {
    const locked = await (await fetch(`${base()}/`)).text()
    expect(locked).not.toContain(d.token)
    expect(locked).toContain("opened from the menu-bar app")
    const first = await fetch(`${base()}/?k=${d.token}`)
    expect(await first.text()).toContain(`content="${d.token}"`)
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
    expect(cookie).toBe(`si_k_${d.port}=${d.token}`)
    const again = await fetch(`${base()}/inbox/item/1`, { headers: { cookie } })
    expect(await again.text()).toContain(d.token)
    expect(await (await fetch(`${base()}/app.js`)).text()).toBe("console.log(1)")
    // The cookie is never API auth.
    expect((await fetch(`${base()}/v1/snapshot`, { headers: { cookie } })).status).toBe(401)
  })
})

describe("hooks + UI round trips", () => {
  const sid = "aaaaaaaa-0000-4000-8000-000000000001"
  test("permission hold: long-poll gets allow the moment the UI decides", async () => {
    await hook("SessionStart", { session_id: sid, cwd: projectDir(), source: "startup" })
    const ing = await hook("PreToolUse", {
      session_id: sid,
      cwd: projectDir(),
      permission_mode: "default",
      tool_name: "Bash",
      tool_use_id: "tu1",
      tool_input: { command: "rm -rf build" },
    })
    expect(ing.requestId).not.toBeNull()
    expect((await poll(ing.requestId ?? "", 0)).decision).toBe("pending")
    const snap = (await (await api("/v1/snapshot")).json()) as {
      items: { id: string; live: boolean; queue: string }[]
      seq: number
    }
    const item = snap.items.find((i) => i.live)
    expect(item?.queue).toBe("needs-you")
    const waiting = poll(ing.requestId ?? "", 10)
    const t0 = Date.now()
    const r = await post(Routes.decision(item?.id ?? ""), {
      idempotencyKey: "d1",
      decision: "allow",
    })
    expect(r.status).toBe(200)
    expect((await waiting).decision).toBe("allow")
    expect(Date.now() - t0).toBeLessThan(1000)
    // idempotent repeat
    expect(
      (await post(Routes.decision(item?.id ?? ""), { idempotencyKey: "d1", decision: "allow" }))
        .status,
    ).toBe(200)
    // conflicting decision
    expect(
      (await post(Routes.decision(item?.id ?? ""), { idempotencyKey: "d2", decision: "deny" }))
        .status,
    ).toBe(409)
  })

  test("held Edit: detail serves the preview stored at hold time, after the file changed", async () => {
    const esid = "aaaaaaaa-0000-4000-8000-0000000000e1"
    const file = join(projectDir(), "notes.txt")
    writeFileSync(file, "alpha\nbeta\ngamma\n")
    const ing = await hook("PreToolUse", {
      session_id: esid,
      cwd: projectDir(),
      tool_name: "Edit",
      tool_use_id: "tu_edit",
      tool_input: { file_path: file, old_string: "beta", new_string: "BETA" },
    })
    expect(ing.requestId).not.toBeNull()
    // Claude applies the edit once allowed; the stored preview must not change.
    writeFileSync(file, "alpha\nBETA\ngamma\n")
    const snap = (await (await api("/v1/snapshot")).json()) as {
      items: { id: string; sessionId: string; summary: string }[]
    }
    const item = snap.items.find((i) => i.sessionId === esid)
    expect(item?.summary).toBe("Wants to edit notes.txt +1 −1")
    const detail = (await (await api(Routes.item(item?.id ?? ""))).json()) as {
      approval: { preview?: { _tag: string; hunks: { lines: { kind: string; text: string }[] }[] } }
    }
    expect(detail.approval.preview?._tag).toBe("diff")
    expect(detail.approval.preview?.hunks[0]?.lines).toEqual([
      { kind: "context", text: "alpha" },
      { kind: "del", text: "beta" },
      { kind: "add", text: "BETA" },
      { kind: "context", text: "gamma" },
    ])
    await post(Routes.decision(item?.id ?? ""), { idempotencyKey: "d-edit", decision: "allow" })
    expect((await poll(ing.requestId ?? "", 1)).decision).toBe("allow")
  })

  test("allow rules in Claude settings mean no hold", async () => {
    const ing = await hook("PreToolUse", {
      session_id: sid,
      cwd: projectDir(),
      permission_mode: "default",
      tool_name: "Bash",
      tool_input: { command: "npm test -- --watch" },
    })
    expect(ing.requestId).toBeNull()
  })

  test("allow-always writes settings.local.json and lets the tool run", async () => {
    const ing = await hook("PreToolUse", {
      session_id: sid,
      cwd: projectDir(),
      tool_name: "Bash",
      tool_use_id: "tu2",
      tool_input: { command: "make deploy" },
    })
    const snap = (await (await api("/v1/snapshot")).json()) as {
      items: { id: string; live: boolean }[]
    }
    const item = snap.items.find((i) => i.live)
    await post(Routes.decision(item?.id ?? ""), { idempotencyKey: "d3", decision: "allow-always" })
    expect((await poll(ing.requestId ?? "", 1)).decision).toBe("allow")
    const local = JSON.parse(
      readFileSync(join(projectDir(), ".claude", "settings.local.json"), "utf8"),
    )
    expect(local.permissions.allow).toContain("Bash(make deploy)")
    const again = await hook("PreToolUse", {
      session_id: sid,
      cwd: projectDir(),
      tool_name: "Bash",
      tool_input: { command: "make deploy" },
    })
    expect(again.requestId).toBeNull()
  })

  test("SSE stream: hello, deltas with seq ids, resume, notify to the shell", async () => {
    const before = ((await (await api("/v1/snapshot")).json()) as { seq: number }).seq
    const shell = readStream(Routes.stream(null, "shell"), 4, 1500)
    await Bun.sleep(50)
    // The app says macOS lets it show notifications: the shell only, no fallback (D-062).
    expect((await post(Routes.shellStatus, { notifications: "authorized" })).status).toBe(200)
    const ing = await hook("PreToolUse", {
      session_id: sid,
      cwd: projectDir(),
      tool_name: "AskUserQuestion",
      tool_use_id: "tq",
      tool_input: {
        questions: [{ question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] }],
      },
    })
    expect(ing.requestId).not.toBeNull()
    const msgs = await shell
    expect(msgs[0]?._tag).toBe("hello")
    const notify = msgs.find((m) => m._tag === "notify")
    expect(notify?._tag === "notify" && notify.notification.actions).toEqual(["answer", "open"])
    expect(msgs.some((m) => m._tag === "delta")).toBe(true)
    expect(msgs.some((m) => m._tag === "badge")).toBe(true)
    // notification was posted to the shell, not the osascript fallback
    const fallbackCount = notifier.posted.length
    // resume from `before`: replays the delta(s) since
    const replayed = await readStream(Routes.stream(before, "ui"), 2, 500)
    expect(replayed[0]?._tag).toBe("hello")
    expect(replayed[1]?._tag).toBe("delta")
    // way-old since → reset
    const reset = await readStream(Routes.stream(-5, "ui"), 2, 500)
    expect(reset[1]?._tag).toBe("reset")

    // Answer from the UI: goes back through the held hook as updatedInput.
    const detail = (await (
      await api(Routes.item(notify?._tag === "notify" ? notify.notification.itemId : ""))
    ).json()) as { item: { id: string }; questions: unknown[]; openUrl: string | null }
    expect(detail.questions).toHaveLength(1)
    expect(detail.openUrl).toBe(`claude://resume?session=${sid}`)
    const r = await post(Routes.answers(detail.item.id), {
      idempotencyKey: "a1",
      answers: [{ idx: 0, selected: ["Yes"] }],
    })
    expect(r.status).toBe(200)
    const dec = await poll(ing.requestId ?? "", 1)
    expect(dec.decision).toBe("allow")
    expect((dec.updatedInput as { answers: unknown }).answers).toEqual({ "Ship it?": "Yes" })
    expect(notifier.posted.length).toBe(fallbackCount)
  })

  test("notification acted: allow decides the approval", async () => {
    const shell = readStream(Routes.stream(null, "shell"), 6, 1000)
    await Bun.sleep(50)
    const ing = await hook("PreToolUse", {
      session_id: sid,
      cwd: projectDir(),
      tool_name: "Edit",
      tool_use_id: "te",
      tool_input: { file_path: join(projectDir(), "a.ts") },
    })
    const msgs = await shell
    const n = msgs.find((m) => m._tag === "notify")
    expect(n?._tag === "notify" && n.notification.critical).toBe(true)
    const id = n?._tag === "notify" ? n.notification.id : ""
    const r = await post(Routes.notificationActed(id), { action: "allow" })
    expect(r.status).toBe(200)
    expect((await poll(ing.requestId ?? "", 1)).decision).toBe("allow")
  })

  test("reply → one outbox row (idempotent), sent with --resume when idle", async () => {
    await hook("Stop", { session_id: sid, cwd: projectDir() })
    const snap = (await (await api("/v1/snapshot")).json()) as {
      items: { id: string; kind: string; state: string }[]
    }
    const review = snap.items.find((i) => i.kind === "review" && i.state === "open")
    expect(review).toBeDefined()
    const body = { idempotencyKey: "r1", body: "also update the changelog" }
    expect((await post(Routes.reply(review?.id ?? ""), body)).status).toBe(200)
    expect((await post(Routes.reply(review?.id ?? ""), body)).status).toBe(200)
    await d.engine.idle()
    expect(claude.resumes.filter((x) => x.body === "also update the changelog")).toHaveLength(1)
    const detail = (await (await api(Routes.item(review?.id ?? ""))).json()) as {
      outbox: { state: string }[]
      item: { state: string }
    }
    expect(detail.outbox.map((o) => o.state)).toEqual(["delivered"])
    expect(detail.item.state).toBe("answered")
  })

  test("snooze, dismiss, draft, read, open, mute", async () => {
    await hook("Notification", {
      session_id: sid,
      cwd: projectDir(),
      notification_type: "idle_prompt",
      message: "Claude is waiting for your input",
    })
    const snap = (await (await api("/v1/snapshot")).json()) as {
      items: { id: string; kind: string; state: string }[]
      projects: { id: string }[]
    }
    const q = snap.items.filter((i) => i.state === "open").at(-1)
    expect(q).toBeDefined()
    const id = q?.id ?? ""
    expect(
      (
        await api(Routes.draft(id), {
          method: "PUT",
          body: JSON.stringify({ body: { text: "hi" } }),
        })
      ).status,
    ).toBe(200)
    expect(((await (await api(Routes.item(id))).json()) as { draft: unknown }).draft).toEqual({
      text: "hi",
    })
    expect((await post(Routes.read(id), {})).status).toBe(200)
    expect((await post(Routes.snooze(id), { until: clock.now() + 60_000 })).status).toBe(200)
    expect((await post(Routes.snooze(id), { until: 1 })).status).toBe(400)
    const opened = (await (await post(Routes.openInClaude(id), {})).json()) as {
      url: string | null
    }
    expect(opened.url).toBe(`claude://resume?session=${sid}`)
    expect(opener.opened.at(-1)).toBe(opened.url ?? "")
    expect(opener.copied.at(-1)).toContain(`claude --resume '${sid}'`)
    expect((await post(Routes.dismiss(id), {})).status).toBe(200)
    expect((await post(Routes.dismiss(id), {})).status).toBe(409)
    const pid = snap.projects[0]?.id ?? ""
    expect((await post(Routes.projectMute(pid), { muted: true })).status).toBe(200)
    const muted = await hook("PreToolUse", {
      session_id: sid,
      cwd: projectDir(),
      tool_name: "Bash",
      tool_input: { command: "rm -rf dist" },
    })
    expect(muted.requestId).toBeNull()
    expect((await post(Routes.projectMute(pid), { muted: false })).status).toBe(200)
    expect((await api(Routes.item("nope"))).status).toBe(404)
    expect((await post(Routes.snooze(id), { nope: 1 })).status).toBe(400)
  })

  test("shell status: bad body is 400; doctor report and test notification", async () => {
    expect((await post(Routes.shellStatus, { notifications: "maybe" })).status).toBe(400)
    expect((await post(Routes.shellStatus, {})).status).toBe(400)
    const r = await api(Routes.doctor)
    expect(r.status).toBe(200)
    const report = (await r.json()) as {
      checks: { id: string; status: string }[]
      firstRun: boolean
      attention: number
    }
    expect(report.checks.map((c) => c.id)).toEqual([
      "daemon",
      "hooks",
      "events",
      "holds",
      "claude-cli",
      "app",
      "notifications",
      "updates",
      "storage",
    ])
    expect(report.firstRun).toBe(false)
    expect(report.checks.find((c) => c.id === "hooks")?.status).toBe("fail")
    // No app connected now: the test notification goes to the osascript fallback.
    const before = notifier.posted.length
    const sent = (await (await post(Routes.doctorNotify, {})).json()) as { via: string }
    expect(sent.via).toBe("fallback")
    await d.engine.idle()
    expect(notifier.posted.at(before)?.title).toBe("Session Inbox test notification")
    // Clicking it in the app reports an id with no row: tolerated.
    expect((await post(Routes.notificationActed("setup_abc"), { action: "click" })).status).toBe(
      200,
    )
  })

  test("garbage on the socket is stored, never a 500", async () => {
    const r = await fetch("http://localhost/v1/hooks/Stop", {
      unix: d.socketPath,
      method: "POST",
      body: "{not json",
    })
    expect(r.status).toBe(200)
    const bad = await fetch("http://localhost/v1/hooks/PreToolUse", {
      unix: d.socketPath,
      method: "POST",
      body: JSON.stringify({ event: "PreToolUse", payload: { nope: 1 }, env: {}, sentAt: 1 }),
    })
    expect(bad.status).toBe(200)
    expect(((await bad.json()) as { requestId: unknown }).requestId).toBeNull()
  })
})
