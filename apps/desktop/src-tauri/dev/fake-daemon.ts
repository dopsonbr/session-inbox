// Fake daemon for shell smoke tests.
//   bun dev/fake-daemon.ts [home-dir]   (default: a fresh temp dir; prints it)
// Writes connection.json, serves /v1/health, a placeholder page at /, and an SSE
// stream that emits hello, then a badge (+2s) and a notify (+4s). Logs every
// request and any POST body. Run the shell with SESSION_INBOX_HOME=<home-dir>.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = process.argv[2] ?? mkdtempSync(join(tmpdir(), "sih-"))
mkdirSync(home, { recursive: true })
const token = "dev-token"
const actions = (process.env.FAKE_ACTIONS ?? "allow,deny,open").split(",")
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a)

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch(req) {
    const url = new URL(req.url)
    const authed = req.headers.get("authorization") === `Bearer ${token}`
    log(req.method, url.pathname + url.search, authed ? "(auth ok)" : "(no auth)")
    if (url.pathname === "/v1/health")
      return Response.json({
        ok: true,
        version: "0.0.0-fake",
        schemaVersion: 1,
        pid: process.pid,
        startedAt: Date.now(),
        shellConnected: true,
      })
    if (url.pathname === "/v1/stream") {
      if (!authed) return new Response("unauthorized", { status: 401 })
      const enc = new TextEncoder()
      const timers: Timer[] = []
      const body = new ReadableStream({
        start(ctl) {
          const send = (seq: number, msg: object) =>
            ctl.enqueue(enc.encode(`id: ${seq}\ndata: ${JSON.stringify(msg)}\n\n`))
          send(1, { _tag: "hello", seq: 1 })
          timers.push(setInterval(() => ctl.enqueue(enc.encode(": hb\n\n")), 5000))
          timers.push(setTimeout(() => send(2, { _tag: "badge", seq: 2, count: 2 }), 2000))
          timers.push(
            setTimeout(
              () =>
                send(3, {
                  _tag: "notify",
                  seq: 3,
                  notification: {
                    id: "n-1",
                    itemId: "item-1",
                    title: "Allow Bash?",
                    body: "bun test in session-inbox",
                    actions,
                    critical: false,
                  },
                }),
              4000,
            ),
          )
          log("stream open")
        },
        cancel() {
          timers.forEach(clearTimeout)
          log("stream closed")
        },
      })
      return new Response(body, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    }
    if (req.method === "POST")
      return req
        .text()
        .then((t) => (log("  POST body:", t), Response.json({ ok: true, item: null })))
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
