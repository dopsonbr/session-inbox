/**
 * Transport: two Bun.serve listeners over one engine (DECISIONS.md D-003).
 * - Unix socket (0600, no auth): hook ingest + decision long-poll (+ health).
 * - TCP 127.0.0.1:<port> (bearer token, Host check): UI API, SSE stream, static UI.
 */
import { existsSync, statSync } from "node:fs"
import { join, normalize } from "node:path"
import {
  AnswersRequest,
  type ApiError,
  DecisionRequest,
  DraftRequest,
  type Health,
  MuteRequest,
  NotificationActedRequest,
  ReplyRequest,
  SCHEMA_VERSION,
  type SettingsResponse,
  SnoozeRequest,
  UpdateApplyRequest,
  type UpdateStatus,
} from "@session-inbox/contracts"
import { BUILD, VERSION } from "@session-inbox/contracts/version"
import { Result, Schema } from "effect"
import { ApiFailure, type Engine } from "./engine.ts"
import type { ClientKind } from "./stream.ts"
import { decodeSettingsPatch } from "./userSettings.ts"

/** From the root VERSION file, or `bun build --define` in scripts/build.ts (H-019). */
export { BUILD, VERSION }
export const TOKEN_META = '<meta name="session-inbox-token" content="">'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })

const apiError = (status: number, error: ApiError["error"], message: string) =>
  json({ error, message } satisfies ApiError, status)

const readJson = async (req: Request): Promise<unknown> => {
  const text = await req.text()
  if (!text) return {}
  return JSON.parse(text) as unknown
}

const decodeBody = async <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  req: Request,
): Promise<S["Type"]> => {
  let raw: unknown
  try {
    raw = await readJson(req)
  } catch {
    throw new ApiFailure(400, "bad_request", "body is not JSON")
  }
  const r = Schema.decodeUnknownResult(schema as never)(raw) as Result.Result<S["Type"], Error>
  if (Result.isFailure(r)) throw new ApiFailure(400, "bad_request", r.failure.message)
  return r.success
}

const guard = async (fn: () => Promise<Response> | Response): Promise<Response> => {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ApiFailure) return apiError(e.status, e.code, e.message)
    return apiError(500, "internal", e instanceof Error ? e.message : String(e))
  }
}

export interface ServerContext {
  readonly engine: Engine
  readonly token: string
  readonly uiDir: string
  readonly channel: string
  /** Page title for this channel (e.g. "Session Inbox Beta"). */
  readonly title: string
  /** Set once the TCP listener knows its port. */
  port: number
  /** A second installed channel (H-016), checked per request; absent = none. */
  readonly otherChannel?: () => string | null
}

const settingsResponse = (ctx: ServerContext): SettingsResponse => ({
  ...ctx.engine.userSettings(),
  channel: ctx.channel,
  otherChannel: ctx.otherChannel?.() ?? null,
})

export const health = (ctx: ServerContext): Health => ({
  ok: true,
  version: VERSION,
  schemaVersion: SCHEMA_VERSION,
  pid: process.pid,
  startedAt: ctx.engine.startedAt,
  shellConnected: ctx.engine.hub.shellConnected,
  channel: ctx.channel,
  build: BUILD,
})

const unsupportedStatus = (): UpdateStatus => ({
  state: "unsupported",
  current: VERSION,
  build: BUILD,
  latest: null,
  available: false,
  notesUrl: null,
  publishedAt: null,
  checkedAt: null,
  error: null,
  auto: false,
  source: null,
  target: null,
  progress: null,
  justUpdatedFrom: null,
  updatedAt: null,
})

// ---------------------------------------------------------------------------
// Unix socket: hooks
// ---------------------------------------------------------------------------

/** Minimal view of Bun's Server we use: disable the idle timeout for long-polls/SSE. */
export interface TimeoutControl {
  timeout(req: Request, seconds: number): void
}

export const hookHandler =
  (ctx: ServerContext) =>
  async (req: Request, server?: TimeoutControl): Promise<Response> => {
    const url = new URL(req.url)
    const path = url.pathname
    const decision = /^\/v1\/hooks\/decision\/([^/]+)$/.exec(path)
    if (decision && req.method === "GET") {
      const wait = Math.max(0, Math.min(Number(url.searchParams.get("wait") ?? "0") || 0, 600))
      server?.timeout(req, 0)
      return json(await ctx.engine.waitDecision(decodeURIComponent(decision[1] ?? ""), wait))
    }
    const ingest = /^\/v1\/hooks\/([A-Za-z]+)$/.exec(path)
    if (ingest && req.method === "POST") {
      const text = await req.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        body = { unparsed: text }
      }
      // Never 500 a hook: the engine stores and logs every failure itself.
      return json(await ctx.engine.ingest(ingest[1] ?? "unknown", body))
    }
    if (path === "/v1/health") return json(health(ctx))
    return apiError(404, "not_found", "no such route")
  }

// ---------------------------------------------------------------------------
// TCP: UI
// ---------------------------------------------------------------------------

const hostOk = (req: Request, port: number) => {
  const host = req.headers.get("host")
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

const authOk = (req: Request, token: string, url: URL, allowQuery: boolean) => {
  const h = req.headers.get("authorization")
  if (h === `Bearer ${token}`) return true
  return allowQuery && url.searchParams.get("token") === token
}

const streamResponse = (ctx: ServerContext, req: Request, url: URL): Response => {
  const client: ClientKind = url.searchParams.get("client") === "shell" ? "shell" : "ui"
  const sinceRaw = url.searchParams.get("since") ?? req.headers.get("last-event-id")
  const since =
    sinceRaw !== null && sinceRaw !== "" && Number.isFinite(Number(sinceRaw))
      ? Number(sinceRaw)
      : null
  const enc = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = ctx.engine.hub.subscribe(
        { kind: client, send: (frame) => controller.enqueue(enc.encode(frame)) },
        since,
        ctx.engine.store.maxSeq(),
      )
      req.signal.addEventListener("abort", () => {
        unsubscribe?.()
        try {
          controller.close()
        } catch {
          // already closed
        }
      })
    },
    cancel() {
      unsubscribe?.()
    },
  })
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  })
}

const PLACEHOLDER = `<!doctype html><html><head><meta charset="utf-8">${TOKEN_META}<title>Session Inbox</title></head>
<body style="font:13px -apple-system,system-ui;padding:24px"><h1 style="font-size:16px">Session Inbox daemon is running</h1>
<p>The UI isn't built yet. Build <code>apps/desktop</code> or pass <code>--ui-dir</code>.</p></body></html>`

/** Tolerates the self-closing form Vite emits (`content="" />`). */
const TOKEN_META_RE = /<meta\s+name="session-inbox-token"\s+content=""\s*\/?>/

export const injectToken = (html: string, token: string, title?: string) => {
  const out = html.replace(TOKEN_META_RE, `<meta name="session-inbox-token" content="${token}">`)
  return title ? out.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`) : out
}

const serveStatic = async (ctx: ServerContext, url: URL): Promise<Response> => {
  const index = join(ctx.uiDir, "index.html")
  const html = async () => {
    const text = existsSync(index) ? await Bun.file(index).text() : PLACEHOLDER
    return new Response(injectToken(text, ctx.token, ctx.title), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    })
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|$))+/, "")
  if (rel === "/" || rel === "/index.html") return html()
  const file = join(ctx.uiDir, rel)
  if (!file.startsWith(ctx.uiDir)) return apiError(404, "not_found", "no such file")
  if (existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file))
  // SPA fallback for extension-less paths.
  if (!/\.[a-z0-9]+$/i.test(rel)) return html()
  return apiError(404, "not_found", "no such file")
}

export const uiHandler =
  (ctx: ServerContext) =>
  (req: Request): Promise<Response> =>
    guard(async () => {
      if (!hostOk(req, ctx.port)) return apiError(403, "unauthorized", "bad Host header")
      const url = new URL(req.url)
      const path = url.pathname
      const m = req.method
      if (!path.startsWith("/v1/")) {
        if (m !== "GET" && m !== "HEAD") return apiError(404, "not_found", "no such route")
        return serveStatic(ctx, url)
      }
      if (path === "/v1/health") return json(health(ctx))
      if (!authOk(req, ctx.token, url, path === "/v1/stream"))
        return apiError(401, "unauthorized", "missing or bad bearer token")
      const e = ctx.engine

      if (path === "/v1/snapshot" && m === "GET") return json(e.snapshot())
      if (path === "/v1/stream" && m === "GET") return streamResponse(ctx, req, url)

      // Updates (C-013, D-035): the manager decides; these only report and ask.
      if (path.startsWith("/v1/update")) {
        const u = e.updates
        if (path === "/v1/update" && m === "GET") return json(u ? u.status() : unsupportedStatus())
        if (!u) throw new ApiFailure(409, "conflict", "updates aren't supported by this install")
        if (path === "/v1/update/check" && m === "POST") return json(await u.checkNow())
        if (path === "/v1/update/apply" && m === "POST") {
          const body = await decodeBody(UpdateApplyRequest, req)
          return json(u.apply(body.version))
        }
      }

      const notif = /^\/v1\/notifications\/([^/]+)\/acted$/.exec(path)
      if (notif && m === "POST") {
        const body = await decodeBody(NotificationActedRequest, req)
        return json(await e.notificationActed(notif[1] ?? "", body.action))
      }
      if (path === "/v1/settings" && m === "GET") return json(settingsResponse(ctx))
      if (path === "/v1/settings" && m === "PUT") {
        let raw: unknown
        try {
          raw = await readJson(req)
        } catch {
          throw new ApiFailure(400, "bad_request", "body is not JSON")
        }
        const patch = decodeSettingsPatch(raw)
        if (Result.isFailure(patch)) throw new ApiFailure(400, "bad_request", patch.failure)
        e.updateSettings(patch.success)
        return json(settingsResponse(ctx))
      }
      const mute = /^\/v1\/projects\/([^/]+)\/mute$/.exec(path)
      if (mute && m === "POST") {
        const body = await decodeBody(MuteRequest, req)
        return json(e.mute(mute[1] ?? "", body.muted))
      }
      const item = /^\/v1\/items\/([^/]+)(?:\/([a-z]+))?$/.exec(path)
      if (item) {
        const id = decodeURIComponent(item[1] ?? "")
        const action = item[2]
        if (!action && m === "GET") return json(e.itemDetail(id))
        if (action === "draft" && m === "PUT") {
          const body = await decodeBody(DraftRequest, req)
          return json(e.draft(id, body.body))
        }
        if (m === "POST") {
          switch (action) {
            case "answers": {
              const b = await decodeBody(AnswersRequest, req)
              return json(e.answers(id, b.idempotencyKey, b.answers))
            }
            case "decision": {
              const b = await decodeBody(DecisionRequest, req)
              return json(e.decide(id, b.decision, b.idempotencyKey))
            }
            case "reply": {
              const b = await decodeBody(ReplyRequest, req)
              return json(e.reply(id, b.idempotencyKey, b.body))
            }
            case "snooze": {
              const b = await decodeBody(SnoozeRequest, req)
              return json(e.snooze(id, b.until))
            }
            case "dismiss":
              return json(e.dismiss(id))
            case "read":
              return json(e.read(id))
            case "open":
              return json(await e.open(id))
          }
        }
      }
      return apiError(404, "not_found", "no such route")
    })
