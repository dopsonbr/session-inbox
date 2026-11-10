/**
 * The TCP side's front door (D-021, D-095): Host check first, the token reaches the page only
 * when the request already knows it, and the cookie never authorises the API.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Engine } from "../src/engine.ts"
import { injectToken, type ServerContext, sameSecret, uiHandler } from "../src/server.ts"

const TOKEN = "a".repeat(64)
const PORT = 4321
let home: string

const ctxFor = (uiDir: string): ServerContext => ({
  // Every request here is answered before the engine is touched.
  engine: {} as Engine,
  token: TOKEN,
  uiDir,
  channel: "ga",
  title: "Session Inbox",
  port: PORT,
})

const get = (ctx: ServerContext, path: string, headers: Record<string, string> = {}) =>
  uiHandler(ctx)(
    new Request(`http://127.0.0.1:${PORT}${path}`, {
      headers: { host: `127.0.0.1:${PORT}`, ...headers },
    }),
  )

let selfClosed: ServerContext
let open: ServerContext

beforeAll(() => {
  home = mkdtempSync("/tmp/si-srv-")
  for (const [dir, meta] of [
    ["self", '<meta name="session-inbox-token" content="" />'],
    ["open", '<meta name="session-inbox-token" content="">'],
  ] as const) {
    mkdirSync(join(home, dir))
    writeFileSync(
      join(home, dir, "index.html"),
      `<html><head>${meta}<title>x</title><script src="/app.js"></script></head></html>`,
    )
    writeFileSync(join(home, dir, "app.js"), "console.log(1)")
  }
  selfClosed = ctxFor(join(home, "self"))
  open = ctxFor(join(home, "open"))
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe("document requests (D-095)", () => {
  test("no k: the notice page, no token, no cookie", async () => {
    const r = await get(selfClosed, "/")
    const text = await r.text()
    expect(r.status).toBe(200)
    expect(text).toContain("opened from the menu-bar app")
    expect(text).toContain("session-inbox open")
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain("app.js")
    expect(r.headers.get("set-cookie")).toBeNull()
  })

  test("wrong k: the notice page", async () => {
    const r = await get(selfClosed, `/?k=${"b".repeat(64)}`)
    expect(await r.text()).not.toContain(TOKEN)
    expect(r.headers.get("set-cookie")).toBeNull()
    const short = await get(selfClosed, "/?k=a")
    expect(await short.text()).not.toContain(TOKEN)
  })

  test("right k: token injected and the cookie set", async () => {
    const r = await get(selfClosed, `/?view=compact&k=${TOKEN}`)
    expect(await r.text()).toContain(`<meta name="session-inbox-token" content="${TOKEN}">`)
    expect(r.headers.get("set-cookie")).toBe(
      `si_k_4321=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`,
    )
    expect(r.headers.get("cache-control")).toBe("no-store")
    expect(r.headers.get("referrer-policy")).toBe("no-referrer")
  })

  test("cookie alone is enough (reloads, SPA paths); not set again", async () => {
    const r = await get(selfClosed, "/", { cookie: `other=1; si_k_4321=${TOKEN}` })
    expect(await r.text()).toContain(`content="${TOKEN}"`)
    expect(r.headers.get("set-cookie")).toBeNull()
    const spa = await get(selfClosed, "/inbox/item/1", { cookie: `si_k_4321=${TOKEN}` })
    expect(await spa.text()).toContain(`content="${TOKEN}"`)
  })

  test("cookie with a wrong value: the notice page", async () => {
    const r = await get(selfClosed, "/", { cookie: `si_k_4321=${"c".repeat(64)}` })
    expect(await r.text()).not.toContain(TOKEN)
  })

  test("the open meta form is handled too", async () => {
    const r = await get(open, `/?k=${TOKEN}`)
    expect(await r.text()).toContain(`<meta name="session-inbox-token" content="${TOKEN}">`)
  })

  test("static assets stay public", async () => {
    const r = await get(selfClosed, "/app.js")
    expect(await r.text()).toBe("console.log(1)")
  })
})

describe("API auth", () => {
  test("the cookie does not authorise /v1/*", async () => {
    const r = await get(selfClosed, "/v1/snapshot", { cookie: `si_k_4321=${TOKEN}` })
    expect(r.status).toBe(401)
  })
  test("k does not authorise /v1/* either", async () => {
    const r = await get(selfClosed, `/v1/snapshot?k=${TOKEN}`)
    expect(r.status).toBe(401)
  })
  test("a wrong bearer is 401", async () => {
    const r = await get(selfClosed, "/v1/snapshot", { authorization: "Bearer nope" })
    expect(r.status).toBe(401)
  })
})

describe("Host check comes first", () => {
  test("a right k with a bad Host is 403, no token", async () => {
    const r = await uiHandler(selfClosed)(
      new Request(`http://127.0.0.1:${PORT}/?k=${TOKEN}`, { headers: { host: "evil:80" } }),
    )
    expect(r.status).toBe(403)
    expect(await r.text()).not.toContain(TOKEN)
  })
})

describe("helpers", () => {
  test("injectToken handles both meta forms and the title", () => {
    for (const meta of [
      '<meta name="session-inbox-token" content="" />',
      '<meta name="session-inbox-token" content="">',
    ])
      expect(injectToken(`${meta}<title>a</title>`, "t", "B")).toBe(
        '<meta name="session-inbox-token" content="t"><title>B</title>',
      )
  })
  test("sameSecret", () => {
    expect(sameSecret("x", "x")).toBe(true)
    expect(sameSecret("x", "y")).toBe(false)
    expect(sameSecret("", "x")).toBe(false)
  })
})
