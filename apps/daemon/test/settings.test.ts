/** Settings pane (C-016, D-045): GET/PUT /v1/settings, and settings applied live. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Routes, type SettingsResponse } from "@session-inbox/contracts"
import { Result } from "effect"
import { type DaemonHandle, type DaemonOptions, startDaemon } from "../src/daemon.ts"
import { decodeSettingsPatch } from "../src/userSettings.ts"
import {
  attachPoll,
  envelope,
  FakeClaude,
  FakeClock,
  FakeGit,
  FakeNotifier,
  FakeOpener,
  makeClassicHarness as makeHarness,
  silentLog,
} from "./fakes.ts"

const SID = "cccccccc-0000-4000-8000-000000000001"
const base = { session_id: SID, cwd: "/work/x" }
const bash = (command: string, id = "tu1") =>
  envelope("PreToolUse", {
    ...base,
    permission_mode: "default",
    tool_name: "Bash",
    tool_use_id: id,
    tool_input: { command },
  })

// ---------------------------------------------------------------------------
// Engine: live apply
// ---------------------------------------------------------------------------

describe("settings apply live", () => {
  test("holds.enabled off: the next call isn't held, a held one is released as ask", async () => {
    const h = makeHarness()
    const held = await h.engine.ingest("PreToolUse", bash("rm a", "tu1"))
    expect(held.requestId).not.toBeNull()
    expect((await h.engine.waitDecision(held.requestId ?? "", 0)).decision).toBe("pending")

    const waiting = h.engine.waitDecision(held.requestId ?? "", 5)
    h.engine.updateSettings({ "holds.enabled": false })
    expect((await waiting).decision).toBe("ask")
    expect(h.engine.snapshot().items.every((i) => !i.live)).toBe(true)

    const next = await h.engine.ingest("PreToolUse", bash("rm b", "tu2"))
    expect(next.requestId).toBeNull()

    h.engine.updateSettings({ "holds.enabled": true })
    const again = await h.engine.ingest("PreToolUse", bash("rm c", "tu3"))
    expect(again.requestId).not.toBeNull()
  })

  test("holds.tools without Write stops holding Write; Bash still held", async () => {
    const h = makeHarness()
    const write = (id: string) =>
      envelope("PreToolUse", {
        ...base,
        permission_mode: "default",
        tool_name: "Write",
        tool_use_id: id,
        tool_input: { file_path: "/work/x/a.txt", content: "x" },
      })
    expect((await h.engine.ingest("PreToolUse", write("w1"))).requestId).not.toBeNull()
    const out = h.engine.updateSettings({ "holds.tools": ["Bash", "Edit"] })
    expect(out.settings["holds.tools"]).toEqual(["Bash", "Edit"])
    expect((await h.engine.ingest("PreToolUse", write("w2"))).requestId).toBeNull()
    expect((await h.engine.ingest("PreToolUse", bash("rm z", "b1"))).requestId).not.toBeNull()
  })

  test("a changed budget applies to the next hold; existing holds keep their expiry", async () => {
    const h = makeHarness()
    const first = await h.engine.ingest("PreToolUse", bash("rm a", "tu1"))
    const detach = attachPoll(h.engine, first.requestId)
    h.engine.updateSettings({ "holds.budgetMs": 20_000 })
    const second = await h.engine.ingest("PreToolUse", bash("rm b", "tu2"))
    h.clock.advance(20_001)
    h.engine.tick()
    expect((await h.engine.waitDecision(second.requestId ?? "", 0)).decision).toBe("ask")
    expect((await h.engine.waitDecision(first.requestId ?? "", 0)).decision).toBe("pending")
    h.clock.advance(100_000)
    h.engine.tick()
    expect((await h.engine.waitDecision(first.requestId ?? "", 0)).decision).toBe("ask")
    detach()
  })

  test("safe Bash prefixes and title generation change live", async () => {
    const h = makeHarness()
    h.engine.updateSettings({ "holds.safeBashPrefixes": ["  make   test ", "make test", ""] })
    expect(h.engine.settings["holds.safeBashPrefixes"]).toEqual(["make test"])
    expect((await h.engine.ingest("PreToolUse", bash("make test", "m1"))).requestId).toBeNull()
    expect((await h.engine.ingest("PreToolUse", bash("ls", "l1"))).requestId).not.toBeNull()

    h.engine.updateSettings({ "titles.generate": false })
    await h.engine.ingest(
      "UserPromptSubmit",
      envelope("UserPromptSubmit", { session_id: "s2", cwd: "/w/2", prompt: "Do a thing" }),
    )
    await h.engine.idle()
    expect(h.claude.titles).toHaveLength(0)
  })

  test("values are clamped; null resets to the default; every change is an event", () => {
    const h = makeHarness()
    const out = h.engine.updateSettings({
      "holds.budgetMs": 999_999,
      "notifications.reviewGroupMs": -5,
    })
    expect(out.settings["holds.budgetMs"]).toBe(120_000)
    expect(out.settings["notifications.reviewGroupMs"]).toBe(0)
    h.engine.updateSettings({ "holds.budgetMs": 1 })
    expect(h.engine.settings["holds.budgetMs"]).toBe(15_000)
    const reset = h.engine.updateSettings({ "holds.budgetMs": null })
    expect(reset.settings["holds.budgetMs"]).toBe(120_000)
    const rows = h.engine.deps.db
      .query("SELECT payload_json FROM events WHERE hook = 'daemon:settings' ORDER BY seq")
      .all() as { payload_json: string }[]
    expect(rows.map((r) => JSON.parse(r.payload_json))).toEqual([
      { changed: { "holds.budgetMs": 120_000, "notifications.reviewGroupMs": 0 }, reset: [] },
      { changed: { "holds.budgetMs": 15_000 }, reset: [] },
      { changed: { "holds.budgetMs": 120_000 }, reset: ["holds.budgetMs"] },
    ])
    expect(h.engine.deps.db.query("SELECT key FROM settings").all()).toEqual([
      { key: "notifications.reviewGroupMs" },
    ])
  })
})

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

describe("GET/PUT /v1/settings", () => {
  let home: string
  let other: string
  let d: DaemonHandle
  const svc = () => ({
    clock: new FakeClock(),
    git: new FakeGit(),
    claude: new FakeClaude(),
    notifier: new FakeNotifier(),
    opener: new FakeOpener(),
    log: silentLog,
  })
  const opts = (): DaemonOptions => ({
    home,
    port: 0,
    uiDir: join(home, "ui"),
    claudeConfigDir: join(home, "claude"),
    // An observer install: the plist default is holds off (H-016).
    settingDefaults: { "holds.enabled": false },
    otherChannelHome: other,
  })
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${d.port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
    })
  const put = (body: unknown) =>
    api(Routes.settings, {
      method: "PUT",
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  const get = async () => (await (await api(Routes.settings)).json()) as SettingsResponse

  beforeAll(async () => {
    home = mkdtempSync("/tmp/si-set-")
    other = join(home, "other")
    mkdirSync(join(home, "claude"))
    d = await startDaemon(opts(), svc())
  })
  afterAll(async () => {
    await d.stop()
    rmSync(home, { recursive: true, force: true })
  })

  test("GET: settings, defaults (install defaults included), channel", async () => {
    const r = await get()
    expect(r.channel).toBe("ga")
    expect(r.otherChannel).toBeNull()
    expect(r.settings["holds.enabled"]).toBe(false)
    expect(r.defaults["holds.enabled"]).toBe(false)
    expect(r.defaults["holds.budgetMs"]).toBe(120_000)
    expect(Object.keys(r.settings)).not.toContain("questions.answerMode")
  })

  test("otherChannel names a second installed channel", async () => {
    mkdirSync(other)
    await Bun.write(join(other, "inbox.db"), "")
    expect((await get()).otherChannel).toBe("beta")
  })

  test("PUT validates: unknown key, wrong type, bad tool, not JSON → 400", async () => {
    for (const body of [
      { "questions.answerMode": "denyWithReason" },
      { "holds.enabled": "yes" },
      { "holds.tools": ["Bash", "Read"] },
      "{nope",
    ]) {
      const r = await put(body)
      expect(r.status).toBe(400)
      expect(((await r.json()) as { error: string }).error).toBe("bad_request")
    }
  })

  test("PUT applies, clamps and persists across a restart; rows beat install defaults", async () => {
    const r = await put({ "holds.enabled": true, "holds.budgetMs": 5_000 })
    expect(r.status).toBe(200)
    const body = (await r.json()) as SettingsResponse
    expect(body.settings["holds.enabled"]).toBe(true)
    expect(body.settings["holds.budgetMs"]).toBe(15_000)
    expect(d.engine.settings["holds.enabled"]).toBe(true)

    await d.stop()
    d = await startDaemon(opts(), svc())
    const after = await get()
    expect(after.settings["holds.enabled"]).toBe(true)
    expect(after.settings["holds.budgetMs"]).toBe(15_000)

    const reset = (await (await put({ "holds.enabled": null })).json()) as SettingsResponse
    expect(reset.settings["holds.enabled"]).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Shortcuts (C-029, D-098)
// ---------------------------------------------------------------------------

describe("shortcut settings", () => {
  const frames = (h: ReturnType<typeof makeHarness>, kind: "ui" | "shell") => {
    const seen: Array<Record<string, unknown>> = []
    h.engine.hub.subscribe(
      {
        kind,
        send: (f) => {
          const data = /^data: (.*)$/m.exec(f)?.[1]
          if (data) seen.push(JSON.parse(data) as Record<string, unknown>)
        },
      },
      null,
      0,
    )
    return seen
  }
  const shortcutFrames = (seen: Array<Record<string, unknown>>) =>
    seen.filter((m) => m._tag === "shortcuts").map((m) => m.bindings as Record<string, string>)

  test("every new client is told the bindings, and again when one changes", () => {
    const h = makeHarness()
    const ui = frames(h, "ui")
    const shell = frames(h, "shell")
    expect(shortcutFrames(ui)).toHaveLength(1)
    expect(shortcutFrames(shell)[0]?.openInbox).toBe("Mod+Shift+I")
    expect(shortcutFrames(ui)[0]?.next).toBe("J")

    const after = h.engine.updateSettings({
      "shortcuts.next": "n",
      "shortcuts.openInbox": "mod+alt+o",
    })
    expect(after.settings["shortcuts.next"]).toBe("N")
    expect(after.settings["shortcuts.openInbox"]).toBe("Mod+Alt+O")
    expect(shortcutFrames(ui)).toHaveLength(2)
    expect(shortcutFrames(ui)[1]?.next).toBe("N")
    expect(shortcutFrames(shell)[1]?.openInbox).toBe("Mod+Alt+O")

    // A change to something else doesn't resend them.
    h.engine.updateSettings({ "titles.generate": false })
    expect(shortcutFrames(ui)).toHaveLength(2)
  })

  test("only the menu-bar app is told what its clicks open, and again when it changes", () => {
    const h = makeHarness()
    const ui = frames(h, "ui")
    const shell = frames(h, "shell")
    const opens = (seen: Array<Record<string, unknown>>) =>
      seen.filter((m) => m._tag === "app").map((m) => m.opens)
    expect(opens(shell)).toEqual(["window"])
    // The same greeting carries the current count, so a restarted app isn't blank (D-102).
    expect(shell.filter((m) => m._tag === "badge").map((m) => m.count)).toEqual([0])
    expect(ui.some((m) => m._tag === "badge")).toBe(false)

    expect(h.engine.updateSettings({ "app.opens": "windowFirst" }).settings["app.opens"]).toBe(
      "windowFirst",
    )
    h.engine.updateSettings({ "titles.generate": false })
    expect(opens(shell)).toEqual(["window", "windowFirst"])
    expect(opens(ui)).toEqual([])

    expect(Result.isFailure(decodeSettingsPatch({ "app.opens": "dock" }))).toBe(true)
    expect(h.engine.updateSettings({ "app.opens": null }).settings["app.opens"]).toBe("window")
    expect(opens(shell)).toEqual(["window", "windowFirst", "window"])
  })

  test('"" turns a shortcut off; null puts the default back', () => {
    const h = makeHarness()
    expect(h.engine.updateSettings({ "shortcuts.done": "" }).settings["shortcuts.done"]).toBe("")
    expect(h.engine.updateSettings({ "shortcuts.done": null }).settings["shortcuts.done"]).toBe("E")
  })

  test("a key press that can't be bound is refused with the reason", () => {
    const bad = decodeSettingsPatch({ "shortcuts.openInbox": "I" })
    expect(Result.isFailure(bad) && bad.failure).toContain("shortcuts.openInbox")
    expect(Result.isFailure(decodeSettingsPatch({ "shortcuts.next": "Alt+J" }))).toBe(true)
    expect(Result.isFailure(decodeSettingsPatch({ "shortcuts.submit": "Enter" }))).toBe(true)
    expect(
      Result.isSuccess(decodeSettingsPatch({ "shortcuts.next": "", "shortcuts.jump": "Mod+P" })),
    ).toBe(true)
  })
})
