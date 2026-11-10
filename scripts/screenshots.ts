/**
 * Take the docs screenshots: a seeded demo daemon (scripts/demo.ts) plus headless Chrome.
 * Deterministic enough to re-run whenever the UI changes; touches nothing outside /tmp and
 * site/assets/screenshots.
 *
 *   bun run --cwd apps/desktop build   # once, so there is a UI to serve
 *   bun scripts/screenshots.ts         # writes site/assets/screenshots/*.png
 *
 * Needs Google Chrome (or Chromium / Edge) in /Applications. No screen-recording permission:
 * headless Chrome renders off screen.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

const repo = resolve(import.meta.dir, "..")
const out = join(repo, "site/assets/screenshots")
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
const stop = () => {
  demo.kill("SIGTERM")
  rmSync(work, { recursive: true, force: true })
}
process.on("SIGINT", () => {
  stop()
  process.exit(130)
})

/** The demo prints its URL once the seed is in; read stdout until it shows up. */
const baseUrl = async (): Promise<string> => {
  const reader = demo.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value)
    // The demo prints the URLs last, after seeding.
    const m = /(http:\/\/127\.0\.0\.1:\d+)\/\?view=compact/.exec(text)
    if (m?.[1]) return m[1]
  }
  throw new Error(`the demo daemon didn't print its URL:\n${text}`)
}

type Shot = {
  name: string
  path: string
  size: [number, number]
  scheme: "light" | "dark"
}

const capture = async (base: string, s: Shot) => {
  const file = join(out, `${s.name}.png`)
  const p = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--user-data-dir=${join(work, "profile")}`,
      `--window-size=${s.size[0]},${s.size[1]}`,
      "--force-device-scale-factor=2",
      // Blink's preferred colour scheme: 0 = dark, 1 = light. Without it Chrome follows macOS.
      `--blink-settings=preferredColorScheme=${s.scheme === "dark" ? 0 : 1}`,
      "--virtual-time-budget=6000",
      `--screenshot=${file}`,
      `${base}${s.path}`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  )
  const code = await p.exited
  if (code !== 0 || !existsSync(file)) throw new Error(`chrome failed for ${s.name} (exit ${code})`)
  console.log(`wrote ${file}`)
}

try {
  const base = await baseUrl()
  // Ask the demo daemon which items it seeded, so the shots open the right ones.
  const page = await (await fetch(`${base}/`)).text()
  const token = /name="session-inbox-token"\s+content="([^"]+)"/.exec(page)?.[1]
  if (!token) throw new Error("no token in the served page")
  const snap = (await (
    await fetch(`${base}/v1/snapshot`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as { items: { id: string; kind: string; summary: string | null }[] }
  const find = (pred: (i: { kind: string; summary: string | null }) => boolean) => {
    const item = snap.items.find(pred)
    if (!item) throw new Error("the demo seed has no item for a screenshot")
    return encodeURIComponent(item.id)
  }
  const question = find((i) => i.kind === "question")
  const edit = find((i) => i.kind === "permission" && (i.summary ?? "").startsWith("Wants to edit"))

  mkdirSync(out, { recursive: true })
  const wide: [number, number] = [1440, 900]
  const shots: Shot[] = [
    { name: "inbox-light", path: `/#/item/${question}`, size: wide, scheme: "light" },
    { name: "inbox-dark", path: `/#/item/${question}`, size: wide, scheme: "dark" },
    { name: "approval-diff", path: `/#/item/${edit}`, size: wide, scheme: "light" },
    { name: "settings", path: "/#/settings", size: wide, scheme: "light" },
    // The fake client has a curated report; a real one would print this Mac's paths.
    { name: "setup", path: "/?client=fake&setup=attention#/setup", size: wide, scheme: "light" },
    { name: "popover", path: "/?view=compact", size: [380, 520], scheme: "light" },
  ]
  for (const s of shots) await capture(base, s)
  // Fail loudly on a blank page: a real shot is never this small.
  for (const s of shots) {
    const bytes = readFileSync(join(out, `${s.name}.png`)).byteLength
    if (bytes < 20_000) throw new Error(`${s.name}.png is only ${bytes} bytes; the page was blank`)
  }
  console.log("screenshots: done")
} finally {
  stop()
}
