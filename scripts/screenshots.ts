/**
 * Take the docs screenshots: a seeded demo daemon (scripts/demo.ts) plus headless Chrome,
 * driven over the Chrome DevTools Protocol so a shot can click, type, press keys and open
 * menus first (H-052). Deterministic enough to re-run whenever the UI changes; touches nothing
 * outside /tmp and site/assets/screenshots.
 *
 *   bun run --cwd apps/desktop build   # once, so there is a UI to serve
 *   bun scripts/screenshots.ts         # writes site/assets/screenshots/*.png
 *   bun scripts/screenshots.ts tour-jump history   # only the shots named
 *
 * Needs Google Chrome (or Chromium / Edge) in /Applications. No screen-recording permission:
 * headless Chrome renders off screen. No dependency: the protocol is JSON over Bun's WebSocket.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const repo = resolve(import.meta.dir, "..")
const out = join(repo, "site/assets/screenshots")
const only = new Set(process.argv.slice(2))
const chrome = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].find((p) => existsSync(p))
if (!chrome) {
  console.error("screenshots: no Chrome, Chromium or Edge in /Applications")
  process.exit(1)
}
if (!existsSync(join(repo, "apps/desktop/dist/index.html"))) {
  console.error("screenshots: build the UI first (bun run --cwd apps/desktop build)")
  process.exit(1)
}

const work = mkdtempSync("/tmp/si-shots-")
const demo = Bun.spawn(["bun", join(repo, "scripts/demo.ts")], {
  cwd: repo,
  stdout: "pipe",
  stderr: "pipe",
})
let browser: Bun.Subprocess | null = null
const stop = () => {
  browser?.kill("SIGTERM")
  demo.kill("SIGTERM")
  rmSync(work, { recursive: true, force: true })
}
process.on("SIGINT", () => {
  stop()
  process.exit(130)
})

/**
 * The demo prints its URLs and home once the seed is in; read stdout until the home shows up,
 * then take the port and token from its connection.json (0600), never from a page (D-095).
 */
const demoConnection = async (): Promise<{ base: string; token: string }> => {
  const reader = demo.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value)
    // The demo prints the home last, after seeding.
    const m = /^ {2}home: +(\/\S+)$/m.exec(text)
    if (m?.[1]) {
      const conn = JSON.parse(readFileSync(join(m[1], "connection.json"), "utf8")) as {
        httpPort: number
        token: string
      }
      return { base: `http://127.0.0.1:${conn.httpPort}`, token: conn.token }
    }
  }
  throw new Error(`the demo daemon didn't print its home:\n${text}`)
}

/** `path` with `k=<token>` added to its query, before any hash. */
const withToken = (path: string, token: string): string => {
  const hashAt = path.indexOf("#")
  const [beforeHash, hash] =
    hashAt === -1 ? [path, ""] : [path.slice(0, hashAt), path.slice(hashAt)]
  const sep = beforeHash.includes("?") ? "&" : "?"
  return `${beforeHash}${sep}k=${encodeURIComponent(token)}${hash}`
}

// CHROME DEVTOOLS PROTOCOL

type Json = Record<string, unknown>

/** One WebSocket to the browser; page commands go to a flattened session (`sessionId`). */
class Cdp {
  private nextId = 0
  private readonly pending = new Map<number, { ok: (v: Json) => void; fail: (e: Error) => void }>()
  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data)) as {
        id?: number
        result?: Json
        error?: { message: string }
      }
      if (msg.id === undefined) return
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.fail(new Error(msg.error.message))
      else p.ok(msg.result ?? {})
    })
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url)
    await new Promise<void>((ok, fail) => {
      ws.addEventListener("open", () => ok(), { once: true })
      ws.addEventListener("error", () => fail(new Error(`can't reach ${url}`)), { once: true })
    })
    return new Cdp(ws)
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    const id = ++this.nextId
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close() {
    this.ws.close()
  }
}

/** Start headless Chrome with a debugging port; its profile writes the port it picked. */
const launchChrome = async (): Promise<Cdp> => {
  const profile = join(work, "profile")
  browser = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  )
  const portFile = join(profile, "DevToolsActivePort")
  for (let i = 0; i < 200; i++) {
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, "utf8").trim().split("\n")
      if (port && path) return Cdp.connect(`ws://127.0.0.1:${port}${path}`)
    }
    await Bun.sleep(50)
  }
  throw new Error("headless Chrome didn't open its debugging port")
}

// SHOTS

/** An element: the first visible match of `css` whose text contains `text`. */
type Target = { css: string; text?: string }
type Step =
  | { click: Target }
  | { type: string }
  | { key: string; shift?: boolean; meta?: boolean }
  | { scroll: Target }
  | { wait: Target }
  | { pause: number }

type Shot = {
  name: string
  path: string
  size: [number, number]
  scheme: "light" | "dark"
  /** Shown once the page is ready to act on. */
  ready: Target
  steps?: ReadonlyArray<Step>
  /** Crop to this element, with `pad` CSS pixels around it. */
  clip?: Target & { pad?: number }
  /** Run after the capture, to undo a change the shot made to the demo daemon. */
  after?: ReadonlyArray<Step>
}

/** Page-side: the element a Target names, or null. Visible elements only. */
const FIND = `(css, text) => {
  const norm = (s) => (s ?? "").replace(/\\s+/g, " ").trim()
  for (const el of document.querySelectorAll(css)) {
    if (el.getClientRects().length === 0) continue
    if (text === undefined || norm(el.textContent).includes(text)) return el
  }
  return null
}`

class Page {
  constructor(
    private readonly cdp: Cdp,
    private readonly session: string,
  ) {}

  send(method: string, params: Json = {}) {
    return this.cdp.send(method, params, this.session)
  }

  async eval<T>(expression: string): Promise<T> {
    const r = (await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result: { value: T }; exceptionDetails?: { text: string } }
    if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.text}`)
    return r.result.value
  }

  /** Run `body` with `el` bound to the target, or return null when it isn't there. */
  private onTarget<T>(t: Target, body: string): Promise<T | null> {
    return this.eval<T | null>(
      `(() => { const el = (${FIND})(${JSON.stringify(t.css)}, ${JSON.stringify(t.text)}); return el ? (${body}) : null })()`,
    )
  }

  async waitFor(t: Target, what: string, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await this.onTarget<boolean>(t, "true")) return
      await Bun.sleep(100)
    }
    throw new Error(`${what}: no ${t.css}${t.text ? ` with "${t.text}"` : ""} on the page`)
  }

  /** The target's box in page CSS pixels, scrolled into view first. */
  async box(t: Target, what: string) {
    await this.waitFor(t, what)
    const r = await this.onTarget<{ x: number; y: number; width: number; height: number }>(
      t,
      `(el.scrollIntoView({ block: "nearest" }), (() => { const b = el.getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height } })())`,
    )
    if (!r) throw new Error(`${what}: lost ${t.css}`)
    return r
  }

  async click(t: Target, what: string) {
    const b = await this.box(t, what)
    const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at })
    for (const type of ["mousePressed", "mouseReleased"])
      await this.send("Input.dispatchMouseEvent", { type, ...at, button: "left", clickCount: 1 })
  }

  async key(key: string, mods: { shift?: boolean; meta?: boolean }) {
    const modifiers = (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0)
    const named: Record<string, { code: string; keyCode: number }> = {
      Enter: { code: "Enter", keyCode: 13 },
      Escape: { code: "Escape", keyCode: 27 },
      "?": { code: "Slash", keyCode: 191 },
    }
    const n = named[key] ?? {
      code: `Key${key.toUpperCase()}`,
      keyCode: key.toUpperCase().charCodeAt(0),
    }
    const text = key.length === 1 && !mods.meta ? key : undefined
    const base = { key, code: n.code, windowsVirtualKeyCode: n.keyCode, modifiers }
    await this.send("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown",
      ...base,
      text,
    })
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base })
  }

  async run(steps: ReadonlyArray<Step>, what: string) {
    for (const s of steps) {
      if ("click" in s) await this.click(s.click, what)
      else if ("type" in s) await this.send("Input.insertText", { text: s.type })
      else if ("key" in s) await this.key(s.key, s)
      else if ("scroll" in s)
        await this.onTarget(s.scroll, `el.scrollIntoView({ block: "start" })`).then((r) => {
          if (r === null) throw new Error(`${what}: nothing to scroll to (${s.scroll.css})`)
        })
      else if ("wait" in s) await this.waitFor(s.wait, what)
      else await Bun.sleep(s.pause)
      // Let Foldkit render and any transition finish.
      await Bun.sleep(250)
    }
  }
}

const capture = async (cdp: Cdp, base: string, token: string, s: Shot) => {
  const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as {
    targetId: string
  }
  const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as {
    sessionId: string
  }
  const page = new Page(cdp, sessionId)
  try {
    await page.send("Page.enable")
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: s.size[0],
      height: s.size[1],
      deviceScaleFactor: 2,
      mobile: false,
    })
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: s.scheme }],
    })
    await page.send("Page.navigate", { url: `${base}${withToken(s.path, token)}` })
    await page.waitFor(s.ready, s.name, 15_000)
    // Item details, history and settings load after the first paint.
    await Bun.sleep(700)
    if (s.steps) await page.run(s.steps, s.name)
    await Bun.sleep(400)
    let clip: Json | undefined
    if (s.clip) {
      const pad = s.clip.pad ?? 12
      const b = await page.box(s.clip, s.name)
      // Whole CSS pixels, so the files keep the same size from run to run.
      const x = Math.max(0, Math.floor(b.x - pad))
      const y = Math.max(0, Math.floor(b.y - pad))
      clip = {
        x,
        y,
        width: Math.min(s.size[0] - x, Math.ceil(b.width + 2 * pad)),
        height: Math.ceil(b.height + 2 * pad),
        scale: 1,
      }
    }
    const { data } = (await page.send("Page.captureScreenshot", {
      format: "png",
      ...(clip ? { clip } : {}),
    })) as { data: string }
    const file = join(out, `${s.name}.png`)
    writeFileSync(file, Buffer.from(data, "base64"))
    console.log(`wrote ${file}`)
    if (s.after) await page.run(s.after, s.name)
  } finally {
    await cdp.send("Target.closeTarget", { targetId })
  }
}

try {
  const { base, token } = await demoConnection()
  const get = async <T>(path: string): Promise<T> =>
    (await (
      await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as T
  type SnapItem = {
    id: string
    kind: string
    state: string
    queue: string
    live: boolean
    summary: string | null
  }
  const snapshot = () => get<{ items: SnapItem[] }>("/v1/snapshot")
  // The demo also seeds finished items for History; the inbox shots want ones still open.
  const find = (items: SnapItem[], what: string, pred: (i: SnapItem) => boolean) => {
    const item = items.find((i) => i.state === "open" && pred(i))
    if (!item) throw new Error(`the demo seed has no item for ${what}`)
    return encodeURIComponent(item.id)
  }
  const pastItem = async (q: string) => {
    const past = await get<{ entries: { item: { id: string } }[] }>(
      `/v1/history?q=${encodeURIComponent(q)}`,
    )
    const id = past.entries[0]?.item.id
    if (!id) throw new Error(`the demo seed has no finished item matching "${q}"`)
    return encodeURIComponent(id)
  }
  const summary = (start: string) => (i: SnapItem) => (i.summary ?? "").startsWith(start)

  // The demo's unpolled request lapses into Claude's own prompt after 20 seconds (D-080).
  let items = (await snapshot()).items
  const lapsedDeadline = Date.now() + 60_000
  while (items.some((i) => summary("Wants to run git branch -D")(i) && i.live)) {
    if (Date.now() > lapsedDeadline) throw new Error("the unpolled request never lapsed")
    await Bun.sleep(1000)
    items = (await snapshot()).items
  }

  const question = find(items, "a question", (i) => i.kind === "question")
  const edit = find(items, "an edit", summary("Wants to edit"))
  const bash = find(items, "a Bash call", summary("Wants to run bun run migrate"))
  const fetchItem = find(
    items,
    "a WebFetch",
    (i) => i.kind === "permission" && /fetch/i.test(i.summary ?? ""),
  )
  const write = find(items, "a new file", summary("Wants to create"))
  const review = find(items, "a review", summary("Added a Reprint button"))
  const failed = find(items, "a failure", (i) => i.kind === "failed")
  const stuck = find(items, "a call that runs long", (i) => i.kind === "stuck")
  const denied = await pastItem("push")
  const allowed = await pastItem("KeyRotationTest")

  mkdirSync(out, { recursive: true })
  const wide: [number, number] = [1440, 900]
  const pop: [number, number] = [480, 600]
  const appReady: Target = { css: "[role=tab]", text: "Needs you" }
  const detailReady = (text: string): Target => ({ css: "[aria-label='Session detail']", text })
  const tab = (label: string): Step => ({ click: { css: "[role=tab]", text: label } })
  const settingsReady: Target = { css: "#settings-group-approvals" }
  const shots: Shot[] = [
    // The seven shots other pages use.
    {
      name: "inbox-light",
      path: `/#/item/${question}`,
      size: wide,
      scheme: "light",
      ready: detailReady("Which integration tests"),
    },
    {
      name: "inbox-dark",
      path: `/#/item/${question}`,
      size: wide,
      scheme: "dark",
      ready: detailReady("Which integration tests"),
    },
    {
      name: "approval-diff",
      path: `/#/item/${edit}`,
      size: wide,
      scheme: "light",
      ready: detailReady("Always allow adds"),
    },
    {
      name: "history",
      path: `/#/history/${denied}`,
      size: wide,
      scheme: "light",
      ready: { css: "main, body", text: "Decided here: Denied" },
    },
    { name: "settings", path: "/#/settings", size: wide, scheme: "light", ready: settingsReady },
    // The fake client has a curated report; a real one would print this Mac's paths.
    {
      name: "setup",
      path: "/?client=fake&setup=attention#/setup",
      size: wide,
      scheme: "light",
      ready: { css: "[aria-label='Setup checks']" },
    },
    {
      name: "popover",
      path: "/?view=compact",
      size: [380, 520],
      scheme: "light",
      ready: { css: "[aria-label='Needs you']" },
    },

    // The tour (site/content/tour.md).
    {
      name: "tour-approval-bash",
      path: `/#/item/${bash}`,
      size: wide,
      scheme: "light",
      ready: detailReady("bun run migrate"),
      steps: [
        { click: { css: "input[placeholder='Tell Claude why (optional)']" } },
        { type: "Run it after the nightly backup" },
      ],
    },
    {
      name: "tour-approval-fetch",
      path: `/#/item/${fetchItem}`,
      size: wide,
      scheme: "light",
      ready: detailReady("keepachangelog.com"),
    },
    {
      name: "tour-always-allow",
      path: `/#/item/${write}`,
      size: wide,
      scheme: "light",
      ready: detailReady("Always allow adds"),
      clip: { css: "[aria-label='Permission request']" },
    },
    {
      name: "tour-decided",
      path: `/#/history/${allowed}`,
      size: wide,
      scheme: "light",
      ready: { css: "[aria-label='Permission request']", text: "Decided here" },
      clip: { css: "[aria-label='Permission request']" },
    },
    // The queue row only: in 0.3.0, selecting a request that lapsed into Claude's prompt leaves
    // the detail on "Loading…" and stops the page updating, so the shot doesn't open it.
    {
      name: "tour-waiting-in-claude",
      path: `/#/item/${question}`,
      size: wide,
      scheme: "light",
      ready: { css: "button[data-row]", text: "Waiting in Claude" },
      clip: { css: "button[data-row]", text: "Waiting in Claude", pad: 6 },
    },
    {
      name: "tour-failed",
      path: `/#/item/${failed}`,
      size: wide,
      scheme: "light",
      ready: detailReady("Claude's last message"),
    },
    {
      name: "tour-stuck",
      path: `/#/item/${stuck}`,
      size: wide,
      scheme: "light",
      ready: detailReady("No result yet"),
    },
    {
      name: "tour-review",
      path: `/#/item/${review}`,
      size: wide,
      scheme: "light",
      ready: appReady,
      steps: [tab("Review"), { wait: detailReady("Claude's last message") }],
    },
    {
      name: "tour-reply",
      path: `/#/item/${review}`,
      size: wide,
      scheme: "light",
      ready: detailReady("Short reply"),
      steps: [
        { click: { css: "[aria-label='Reply to Claude'] textarea" } },
        { type: "Looks good. Open the PR and ask Sam to review." },
      ],
      clip: { css: "[aria-label='Reply to Claude']" },
    },
    {
      name: "tour-working",
      path: "/",
      size: wide,
      scheme: "light",
      ready: appReady,
      steps: [
        tab("Working"),
        { click: { css: "#queue-panel button", text: "Session tree parser" } },
      ],
    },
    {
      name: "tour-snoozed",
      path: "/",
      size: wide,
      scheme: "light",
      ready: appReady,
      steps: [
        tab("Snoozed"),
        { click: { css: "button[data-row]", text: "Tidy" } },
        { wait: detailReady("Claude's last message") },
      ],
    },
    {
      name: "tour-snooze-menu",
      path: `/#/item/${bash}`,
      size: wide,
      scheme: "light",
      ready: detailReady("bun run migrate"),
      steps: [
        { click: { css: "[aria-label='Session detail'] button", text: "Snooze" } },
        { wait: { css: "[role=menuitem]", text: "Snooze 1 hour" } },
      ],
    },
    {
      name: "tour-jump",
      path: `/#/item/${question}`,
      size: wide,
      scheme: "light",
      ready: detailReady("Which integration tests"),
      steps: [
        { click: { css: "button", text: "Jump to session" } },
        { wait: { css: "dialog input" } },
        { type: "order" },
      ],
    },
    {
      name: "tour-shortcuts",
      path: `/#/item/${question}`,
      size: wide,
      scheme: "light",
      ready: detailReady("Which integration tests"),
      steps: [{ key: "?", shift: true }, { wait: { css: "dialog", text: "Keyboard shortcuts" } }],
    },
    {
      name: "tour-history",
      path: "/#/history",
      size: wide,
      scheme: "light",
      ready: { css: "[role=group][aria-label=Kind]" },
    },
    {
      name: "tour-history-search",
      path: "/#/history",
      size: wide,
      scheme: "light",
      ready: { css: "[role=group][aria-label=Kind]" },
      steps: [
        { click: { css: "input[placeholder='Search history']" } },
        { type: "vitest" },
        { wait: { css: "main, body", text: "Matched in question" } },
      ],
    },
    {
      name: "tour-history-kind",
      path: "/#/history",
      size: wide,
      scheme: "light",
      ready: { css: "[role=group][aria-label=Kind]" },
      steps: [{ click: { css: "[role=group][aria-label=Kind] button", text: "Permissions" } }],
    },
    {
      name: "tour-settings-more",
      path: "/#/settings",
      size: wide,
      scheme: "light",
      ready: settingsReady,
      steps: [{ scroll: { css: "#settings-group-notifications" } }],
    },
    {
      name: "tour-settings-shortcuts",
      path: "/#/settings",
      size: wide,
      scheme: "light",
      ready: settingsReady,
      steps: [
        { scroll: { css: "#settings-group-shortcuts" } },
        { click: { css: "button[aria-label='Change the Next item in the list shortcut']" } },
        { wait: { css: "[aria-live=polite]", text: "Press the new shortcut…" } },
      ],
    },
    {
      name: "tour-update",
      path: "/?client=fake&update=available",
      size: wide,
      scheme: "light",
      ready: { css: "button", text: "Update now" },
      // The banner only: the rest is the fake client's sample inbox.
      clip: { css: "[role=status]", text: "Update now", pad: 0 },
    },
    {
      name: "tour-setup-welcome",
      path: "/?client=fake&setup=firstrun#/setup",
      size: wide,
      scheme: "light",
      ready: { css: "#setup-welcome" },
      clip: { css: "[aria-labelledby=setup-welcome]", pad: 16 },
    },
    {
      name: "tour-popover",
      path: "/?view=compact",
      size: pop,
      scheme: "light",
      ready: { css: "[aria-label='Needs you']" },
    },
    {
      name: "tour-popover-empty",
      path: "/?client=fake&needs=none&view=compact",
      size: pop,
      scheme: "light",
      ready: { css: "#compact-review-label" },
    },
    // Last of the real-daemon shots: it switches the demo to the classic mode, then back.
    {
      name: "tour-settings-classic",
      path: "/#/settings",
      size: wide,
      scheme: "light",
      ready: settingsReady,
      steps: [
        { click: { css: "label", text: "Hold the tool call before Claude asks (classic)" } },
        { wait: { css: "body", text: "Bash commands never held" } },
      ],
      after: [{ click: { css: "label", text: "Answer Claude's own prompt (recommended)" } }],
    },
  ]
  const chosen = only.size === 0 ? shots : shots.filter((s) => only.has(s.name))
  if (chosen.length !== only.size && only.size > 0)
    throw new Error(`no shot named ${[...only].filter((n) => !shots.some((s) => s.name === n))}`)
  // Each page must be the app, not the "opened from the menu-bar app" notice (D-095).
  for (const s of chosen) {
    const html = await (await fetch(`${base}${withToken(s.path, token)}`)).text()
    if (!html.includes(`content="${token}"`))
      throw new Error(`${s.name}: the daemon withheld the UI`)
  }
  const cdp = await launchChrome()
  try {
    for (const s of chosen) await capture(cdp, base, token, s)
  } finally {
    cdp.close()
  }
  // Fail loudly on a blank page: a real shot is never this small.
  for (const s of chosen) {
    const bytes = readFileSync(join(out, `${s.name}.png`)).byteLength
    if (bytes < 20_000) throw new Error(`${s.name}.png is only ${bytes} bytes; the page was blank`)
  }
  console.log("screenshots: done")
} finally {
  stop()
}
