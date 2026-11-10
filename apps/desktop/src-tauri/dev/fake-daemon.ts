// Fake daemon for shell smoke tests.
//   bun dev/fake-daemon.ts [home-dir]   (default: a fresh temp dir; prints it)
// Writes connection.json, serves /v1/health, a placeholder page at /, and an SSE
// stream that emits hello, then a badge (+2s) and a notify (+4s) unless
// FAKE_AUTO=0. Logs every request and any POST body. Run the shell with
// SESSION_INBOX_HOME=<home-dir>.
//
// Test controls (no auth, loopback only):
//   GET  /_notify?id=n-2&itemId=item-2&actions=answer,open&critical=1&title=..&body=..
//   GET  /_unnotify?ids=n-1,n-2        -> {"_tag":"unnotify","ids":[...]} to every shell stream
//   POST /_emit  <any StreamMessage JSON; seq is filled in>
//   GET  /_calls                       -> every recorded POST (acted, shell/status, ...)
// FAKE_STATUS_404=1 answers POST /v1/shell/status with 404 (a daemon without the route).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = process.argv[2] ?? mkdtempSync(join(tmpdir(), "sih-"))
mkdirSync(home, { recursive: true })
const token = "dev-token"
const actions = (process.env.FAKE_ACTIONS ?? "allow,deny,open").split(",")
const auto = process.env.FAKE_AUTO !== "0"
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a)

type Call = { at: string; method: string; path: string; authed: boolean; body: unknown }
const calls: Call[] = []
const streams = new Set<(msg: Record<string, unknown>) => void>()
let seq = 1

const broadcast = (msg: Record<string, unknown>) => {
  const full = { ...msg, seq: ++seq }
  for (const send of streams) send(full)
  log("emit", JSON.stringify(full), `to ${streams.size} stream(s)`)
  return full
}

const notification = (p: URLSearchParams) => ({
  id: p.get("id") ?? `n-${seq + 1}`,
  itemId: p.get("itemId") ?? "item-1",
  title: p.get("title") ?? "Allow Bash?",
  body: p.get("body") ?? "bun test in session-inbox",
  actions: (p.get("actions") ?? actions.join(",")).split(",").filter(Boolean),
  critical: p.get("critical") === "1",
})

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const authed = req.headers.get("authorization") === `Bearer ${token}`
    if (!["/_notify", "/_unnotify", "/_emit", "/_calls"].includes(url.pathname))
      log(req.method, url.pathname + url.search, authed ? "(auth ok)" : "(no auth)")
    if (url.pathname === "/_notify")
      return Response.json(
        broadcast({ _tag: "notify", notification: notification(url.searchParams) }),
      )
    if (url.pathname === "/_unnotify")
      return Response.json(
        broadcast({ _tag: "unnotify", ids: (url.searchParams.get("ids") ?? "").split(",") }),
      )
    if (url.pathname === "/_emit" && req.method === "POST")
      return Response.json(broadcast((await req.json()) as Record<string, unknown>))
    if (url.pathname === "/_calls") return Response.json(calls)
    if (url.pathname === "/v1/health")
      return Response.json({
        ok: true,
        version: "0.0.0-fake",
        schemaVersion: 1,
        pid: process.pid,
        startedAt: Date.now(),
        shellConnected: streams.size > 0,
      })
    if (url.pathname === "/v1/stream") {
      if (!authed) return new Response("unauthorized", { status: 401 })
      const enc = new TextEncoder()
      const timers: Timer[] = []
      let send: (msg: Record<string, unknown>) => void = () => {}
      const body = new ReadableStream({
        start(ctl) {
          send = (msg) =>
            ctl.enqueue(enc.encode(`id: ${msg.seq}\ndata: ${JSON.stringify(msg)}\n\n`))
          send({ _tag: "hello", seq })
          streams.add(send)
          timers.push(setInterval(() => ctl.enqueue(enc.encode(": hb\n\n")), 5000))
          if (auto) {
            timers.push(setTimeout(() => broadcast({ _tag: "badge", count: 2 }), 2000))
            timers.push(
              setTimeout(
                () =>
                  broadcast({
                    _tag: "notify",
                    notification: notification(new URLSearchParams({ id: "n-1" })),
                  }),
                4000,
              ),
            )
          }
          log("stream open")
        },
        cancel() {
          timers.forEach(clearTimeout)
          streams.delete(send)
          log("stream closed")
        },
      })
      return new Response(body, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    }
    if (req.method === "POST") {
      const text = await req.text()
      let parsed: unknown = text
      try {
        parsed = JSON.parse(text)
      } catch {}
      calls.push({
        at: new Date().toISOString(),
        method: req.method,
        path: url.pathname,
        authed,
        body: parsed,
      })
      log("  POST body:", text)
      if (url.pathname === "/v1/shell/status" && process.env.FAKE_STATUS_404 === "1")
        return Response.json({ error: "not found" }, { status: 404 })
      return Response.json({ ok: true, item: null })
    }
    return new Response(
      `<!doctype html><title>fake inbox</title><body style="font:16px system-ui"><h2>Fake inbox</h2><p>${url.pathname}${url.search} <code id=h></code></p><script>const r=()=>{h.textContent=location.hash;fetch("/_page?"+new URLSearchParams({path:location.pathname+location.search,hash:location.hash,visible:document.visibilityState}))};r();addEventListener("hashchange",r);addEventListener("visibilitychange",r)</script>`,
      { headers: { "content-type": "text/html" } },
    )
  },
})

writeFileSync(
  join(home, "connection.json"),
  JSON.stringify({
    socketPath: join(home, "inboxd.sock"),
    httpPort: server.port,
    token,
    pid: process.pid,
    version: "0.0.0-fake",
  }),
  { mode: 0o600 },
)
log(`fake daemon on :${server.port}`)
log(`SESSION_INBOX_HOME=${home}`)
