import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Routes, type StreamMessage, type UpdateStatus } from "@session-inbox/contracts"
import { type DaemonHandle, startDaemon } from "../src/daemon.ts"
import { VERSION } from "../src/server.ts"
import { makeLiveUpdater, parseCheckOutput, parseStateFile } from "../src/services.ts"
import type { Settings } from "../src/settings.ts"
import {
  attachUpdates,
  memoryMemo,
  QUIET_MS,
  STALL_MS,
  STARTUP_CHECK_DELAY_MS,
  type UpdateMemo,
} from "../src/updates.ts"
import {
  envelope,
  FakeClaude,
  FakeClock,
  FakeGit,
  FakeNotifier,
  FakeOpener,
  FakeUpdater,
  makeClassicHarness as makeHarness,
  silentLog,
} from "./fakes.ts"

const SID = "cccccccc-0000-4000-8000-000000000001"
const base = { session_id: SID, cwd: "/work/u" }

const setup = (
  opts: {
    settings?: Partial<Settings>
    memo?: Partial<UpdateMemo>
    prepare?: (u: FakeUpdater) => void
  } = {},
) => {
  const h = makeHarness({ settings: { "titles.generate": false, ...opts.settings } })
  const updater = new FakeUpdater()
  opts.prepare?.(updater)
  const memo = memoryMemo(opts.memo)
  const published: UpdateStatus[] = []
  const m = attachUpdates(h.engine, { updater, version: "0.1.0", build: "abc1234", memo })
  const unsub = h.engine.hub.subscribe(
    {
      kind: "ui",
      send: (frame) => {
        const data = frame.split("\n").find((l) => l.startsWith("data: "))
        if (!data) return
        const msg = JSON.parse(data.slice(6)) as StreamMessage
        if (msg._tag === "update") published.push(msg.status)
      },
    },
    null,
    h.engine.store.maxSeq(),
  )
  const events = (prefix = "daemon:update") =>
    h.engine.store
      .all<{ hook: string; payload_json: string }>(
        "SELECT hook, payload_json FROM events WHERE hook LIKE ? ORDER BY seq",
        `${prefix}%`,
      )
      .map((r) => ({ hook: r.hook, payload: JSON.parse(r.payload_json) }))
  /** Advance, tick, and let async checks settle. */
  const step = async (ms: number) => {
    h.clock.advance(ms)
    h.engine.tick()
    await m.idle()
  }
  return { h, updater, memo, m, published, events, step, unsub }
}

describe("update checks", () => {
  test("first check ~60 s after start, then every checkIntervalMs", async () => {
    const t = setup({ settings: { "updates.checkIntervalMs": 3600_000 } })
    expect(t.m.status().state).toBe("idle")
    await t.step(STARTUP_CHECK_DELAY_MS - 1000)
    expect(t.updater.checks).toBe(0)
    await t.step(1000)
    expect(t.updater.checks).toBe(1)
    expect(t.m.status().checkedAt).not.toBeNull()
    await t.step(1800_000)
    expect(t.updater.checks).toBe(1)
    await t.step(1800_000)
    expect(t.updater.checks).toBe(2)
    // Routine "nothing new" checks append no events.
    expect(t.events()).toEqual([])
  })

  test("updates.check=false: no scheduled checks; a manual check still runs", async () => {
    const t = setup({ settings: { "updates.check": false } })
    await t.step(24 * 3600_000)
    expect(t.updater.checks).toBe(0)
    await t.m.checkNow()
    expect(t.updater.checks).toBe(1)
  })

  test("unsupported when the CLI is missing: no checks, 409 on intents, no greeting", async () => {
    const t = setup({ prepare: (u) => (u.isSupported = false) })
    expect(t.m.status().state).toBe("unsupported")
    await t.step(24 * 3600_000)
    expect(t.updater.checks).toBe(0)
    expect(() => t.m.apply()).toThrow("aren't supported")
    expect(t.published).toEqual([])
  })

  test("a failing check is quiet: error in status, ticks go on, no event", async () => {
    const t = setup({ prepare: (u) => (u.failCheck = "network down") })
    await t.step(STARTUP_CHECK_DELAY_MS)
    expect(t.m.status()).toMatchObject({ state: "idle", error: "network down" })
    expect(t.events()).toEqual([])
  })

  test("available: one event per new version, status streamed", async () => {
    const t = setup({ settings: { "updates.auto": false } })
    t.updater.offer("0.3.0")
    await t.step(STARTUP_CHECK_DELAY_MS)
    expect(t.m.status()).toMatchObject({
      state: "available",
      latest: "0.3.0",
      available: true,
      auto: false,
      source: "release",
    })
    await t.m.checkNow()
    expect(t.events().map((e) => e.hook)).toEqual(["daemon:update-available"])
    expect(t.published.at(-1)?.state).toBe("available")
    t.updater.offer("0.4.0")
    await t.m.checkNow()
    expect(t.events().map((e) => e.payload.version)).toEqual(["0.3.0", "0.4.0"])
  })
})

describe("auto-apply only when quiet", () => {
  test("blocked by a live hold, then applied once it's decided and quiet", async () => {
    const t = setup()
    t.updater.offer("0.3.0")
    const r = await t.h.engine.ingest(
      "PreToolUse",
      envelope("PreToolUse", { ...base, tool_name: "Bash", tool_input: { command: "rm x" } }),
    )
    expect(r.requestId).not.toBeNull()
    await t.step(STARTUP_CHECK_DELAY_MS)
    expect(t.m.status()).toMatchObject({ state: "available", auto: true })
    expect(t.updater.applied).toEqual([])
    const item = t.h.engine.snapshot().items[0]
    expect(t.h.engine.busyReason(QUIET_MS)).toBe("a held tool call is waiting")
    t.h.engine.decide(item?.id ?? "", "allow", "k1")
    expect(t.h.engine.busyReason(QUIET_MS)).toBeNull()
    await t.step(1000)
    expect(t.updater.applied).toEqual(["0.3.0"])
    expect(t.m.status().state).toBe("updating")
    await t.step(1000)
    expect(t.updater.applied).toEqual(["0.3.0"]) // once
    expect(t.events().at(-1)).toEqual({
      hook: "daemon:update-started",
      payload: { version: "0.3.0", from: "0.1.0", trigger: "auto" },
    })
  })

  test("blocked by a recent hook event", async () => {
    const t = setup()
    t.updater.offer("0.3.0")
    await t.step(STARTUP_CHECK_DELAY_MS - 10_000)
    await t.h.engine.ingest("Stop", envelope("Stop", base))
    await t.step(10_000)
    expect(t.m.status().state).toBe("available")
    expect(t.updater.applied).toEqual([])
    await t.step(QUIET_MS)
    expect(t.updater.applied).toEqual(["0.3.0"])
  })

  test("blocked by a queued outbox row", async () => {
    const t = setup()
    t.updater.offer("0.3.0")
    await t.h.engine.ingest("Stop", envelope("Stop", base))
    const id = t.h.engine.snapshot().items[0]?.id ?? ""
    await t.h.engine.ingest(
      "UserPromptSubmit",
      envelope("UserPromptSubmit", { ...base, prompt: "go" }),
    )
    t.h.engine.reply(id, "k", "later please") // queued: the session is running
    await t.step(STARTUP_CHECK_DELAY_MS)
    await t.step(QUIET_MS)
    expect(t.h.engine.busyReason(QUIET_MS)).toBe("a reply is being delivered")
    expect(t.updater.applied).toEqual([])
    await t.h.engine.ingest("Stop", envelope("Stop", base)) // idle → reply goes out
    await t.h.engine.idle()
    await t.step(QUIET_MS)
    expect(t.updater.applied).toEqual(["0.3.0"])
  })

  test("a source install never auto-applies, but shows the update", async () => {
    const t = setup()
    t.updater.offer("0.3.0", "source")
    await t.step(STARTUP_CHECK_DELAY_MS)
    await t.step(3600_000)
    expect(t.m.status()).toMatchObject({ state: "available", source: "source", auto: false })
    expect(t.updater.applied).toEqual([])
    t.m.apply() // explicit: allowed
    expect(t.updater.applied).toEqual(["0.3.0"])
  })

  test("updates.auto=false never auto-applies", async () => {
    const t = setup({ settings: { "updates.auto": false } })
    t.updater.offer("0.3.0")
    await t.step(STARTUP_CHECK_DELAY_MS)
    await t.step(3600_000)
    expect(t.updater.applied).toEqual([])
  })
})

describe("manual apply and failures", () => {
  test("manual apply ignores quietness; 409 when nothing is available or already running", async () => {
    const t = setup({ settings: { "updates.auto": false } })
    expect(() => t.m.apply()).toThrow("no update is available")
    t.updater.offer("0.3.0")
    await t.m.checkNow()
    await t.h.engine.ingest(
      "PreToolUse",
      envelope("PreToolUse", { ...base, tool_name: "Bash", tool_input: { command: "rm x" } }),
    )
    expect(() => t.m.apply("0.2.9")).toThrow("no update is available")
    expect(t.m.apply("0.3.0").state).toBe("updating")
    expect(() => t.m.apply()).toThrow("already running")
    expect(t.events().at(-1)?.payload.trigger).toBe("manual")
  })

  test("state file reports failed → failed with its error; not auto-retried; Try again works", async () => {
    const t = setup()
    t.updater.offer("0.3.0")
    t.updater.stateFile = {
      version: "0.2.0",
      state: "failed",
      error: "old",
      at: t.h.clock.now() - 1,
    }
    await t.step(STARTUP_CHECK_DELAY_MS)
    await t.step(1000)
    expect(t.updater.applied).toEqual(["0.3.0"])
    t.updater.stateFile = { version: "0.3.0", state: "downloading", error: null, at: 1 }
    await t.step(1000)
    expect(t.m.status().progress).toBe("downloading")
    t.updater.stateFile = {
      version: "0.3.0",
      state: "failed",
      error: "checksum mismatch",
      at: 2,
    }
    await t.step(1000)
    expect(t.m.status()).toMatchObject({
      state: "failed",
      error: "checksum mismatch",
      target: "0.3.0",
    })
    expect(t.events().at(-1)).toEqual({
      hook: "daemon:update-failed",
      payload: { version: "0.3.0", error: "checksum mismatch" },
    })
    await t.step(7 * 3600_000) // re-check finds the same version: stays failed, no retry
    expect(t.m.status().state).toBe("failed")
    expect(t.updater.applied).toEqual(["0.3.0"])
    expect(t.m.apply().state).toBe("updating")
    expect(t.updater.applied).toEqual(["0.3.0", "0.3.0"])
    // The stale "failed" file from the last attempt doesn't fail the retry.
    await t.step(1000)
    expect(t.m.status().state).toBe("updating")
  })

  test("no state-file progress for 10 minutes → failed", async () => {
    const t = setup({ settings: { "updates.auto": false } })
    t.updater.offer("0.3.0")
    await t.m.checkNow()
    t.m.apply()
    await t.step(STALL_MS)
    expect(t.m.status().state).toBe("updating")
    await t.step(1000)
    expect(t.m.status()).toMatchObject({ state: "failed" })
    expect(t.m.status().error).toContain("stalled")
  })

  test("the CLI exiting non-zero → failed; a spawn error → failed", async () => {
    const t = setup({ settings: { "updates.auto": false } })
    t.updater.offer("0.3.0")
    await t.m.checkNow()
    t.m.apply()
    t.updater.onExit?.(3)
    expect(t.m.status()).toMatchObject({ state: "failed" })
    expect(t.m.status().error).toContain("exited 3")
    t.updater.failApply = "ENOENT"
    t.m.apply()
    await t.m.idle()
    expect(t.m.status()).toMatchObject({ state: "failed", error: "ENOENT" })
  })
})

describe("after an update", () => {
  test("done for this version: daemon:updated exactly once, with the version we came from", () => {
    const prepare = (u: FakeUpdater) => {
      u.stateFile = { version: "0.1.0", state: "done", error: null, at: 1 }
    }
    const t = setup({ prepare, memo: { lastRun: "0.0.9" } })
    expect(t.m.status()).toMatchObject({ justUpdatedFrom: "0.0.9", state: "idle" })
    expect(t.events("daemon:updated")).toEqual([
      { hook: "daemon:updated", payload: { version: "0.1.0", from: "0.0.9" } },
    ])
    expect(t.memo.value).toMatchObject({ announced: "0.1.0", lastRun: "0.1.0" })
    // A second start with the same memo announces nothing.
    const again = setup({ prepare, memo: t.memo.value })
    expect(again.events("daemon:updated")).toEqual([])
    expect(again.m.status().justUpdatedFrom).toBeNull()
  })

  test("hello carries version/build; the update greeting follows it", async () => {
    const t = setup()
    const frames: string[] = []
    t.h.engine.hub.info = { version: "0.1.0", build: "abc1234" }
    t.h.engine.hub.subscribe({ kind: "ui", send: (f) => frames.push(f) }, null, 0)
    const msgs = frames.map((f) => JSON.parse(f.slice(f.indexOf("data: ") + 6)) as StreamMessage)
    expect(msgs[0]).toEqual({ _tag: "hello", seq: 0, version: "0.1.0", build: "abc1234" })
    expect(msgs[1]?._tag).toBe("update")
    expect(frames[1]?.startsWith("data: ")).toBe(true) // no id: live-only
  })
})

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

describe("HTTP /v1/update", () => {
  let home: string
  let d: DaemonHandle
  const updater = new FakeUpdater()
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${d.port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
    })
  beforeAll(async () => {
    home = mkdtempSync("/tmp/si-upd-")
    mkdirSync(join(home, "ui"))
    d = await startDaemon(
      {
        home,
        port: 0,
        uiDir: join(home, "ui"),
        claudeConfigDir: join(home, "claude"),
        settings: { "titles.generate": false, "updates.auto": false },
      },
      {
        clock: new FakeClock(),
        git: new FakeGit(),
        claude: new FakeClaude(),
        notifier: new FakeNotifier(),
        opener: new FakeOpener(),
        log: silentLog,
        updater,
      },
    )
  })
  afterAll(async () => {
    await d.stop()
    rmSync(home, { recursive: true, force: true })
  })

  test("needs the token", async () => {
    expect((await fetch(`http://127.0.0.1:${d.port}${Routes.update}`)).status).toBe(401)
  })
  test("GET status, POST check, POST apply (409 when nothing is available)", async () => {
    const s = (await (await api(Routes.update)).json()) as UpdateStatus
    expect(s).toMatchObject({ state: "idle", current: VERSION, latest: null })
    const noop = await api(Routes.updateApply, { method: "POST", body: "{}" })
    expect(noop.status).toBe(409)
    updater.offer("9.9.9")
    const checked = (await (
      await api(Routes.updateCheck, { method: "POST" })
    ).json()) as UpdateStatus
    expect(checked).toMatchObject({ state: "available", latest: "9.9.9" })
    const bad = await api(Routes.updateApply, { method: "POST", body: '{"version":1}' })
    expect(bad.status).toBe(400)
    const applied = await api(Routes.updateApply, {
      method: "POST",
      body: JSON.stringify({ version: "9.9.9" }),
    })
    expect(applied.status).toBe(200)
    expect(((await applied.json()) as UpdateStatus).state).toBe("updating")
    expect(updater.applied).toEqual(["9.9.9"])
    expect((await api(Routes.updateApply, { method: "POST" })).status).toBe(409)
  })
  test("without an updater: GET says unsupported, check is 409", async () => {
    d.engine.updates = null
    const s = (await (await api(Routes.update)).json()) as UpdateStatus
    expect(s.state).toBe("unsupported")
    expect((await api(Routes.updateCheck, { method: "POST" })).status).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// Live Updater against a stub CLI
// ---------------------------------------------------------------------------

describe("parsing", () => {
  test("check output: last JSON line wins; garbage throws", () => {
    const line = JSON.stringify({
      current: "0.2.0",
      latest: "0.3.0",
      available: true,
      notesUrl: "https://x/notes",
      publishedAt: null,
      source: "release",
      error: null,
    })
    expect(parseCheckOutput(`downloading index…\n${line}\n`)).toMatchObject({
      latest: "0.3.0",
      available: true,
      source: "release",
    })
    expect(() => parseCheckOutput("hello")).toThrow("unrecognised")
    expect(() => parseCheckOutput('{"nope":1}')).toThrow("unrecognised")
    expect(parseCheckOutput('{"current":"1","latest":null,"available":true}').available).toBe(false)
  })
  test("state file: null when corrupt or unknown", () => {
    expect(parseStateFile("{")).toBeNull()
    expect(parseStateFile('{"version":"1","state":"weird","at":1}')).toBeNull()
    expect(parseStateFile('{"version":"1","state":"done","error":null,"at":5}')).toEqual({
      version: "1",
      state: "done",
      error: null,
      at: 5,
    })
  })
})

describe("live Updater (stub CLI)", () => {
  let dir: string
  const stub = (name: string, body: string) => {
    const file = join(dir, name)
    writeFileSync(file, `#!/usr/bin/env bun\n${body}\n`)
    chmodSync(file, 0o755)
    return file
  }
  beforeAll(() => {
    dir = mkdtempSync("/tmp/si-cli-")
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("check parses the CLI's JSON line and gets the args and home", async () => {
    const cliPath = stub(
      "ok",
      `console.log("noise"); console.log(JSON.stringify({ current: "0.2.0", latest: "0.3.0", available: true, notesUrl: null, publishedAt: null, source: "release", error: process.argv.slice(2).join(" ") + "|" + process.env.SESSION_INBOX_HOME }))`,
    )
    const u = makeLiveUpdater({ home: dir, cliPath })
    expect(u.supported()).toBe(true)
    const r = await u.check()
    expect(r).toMatchObject({ latest: "0.3.0", available: true })
    expect(r.error).toBe(`update --check --json|${dir}`)
  })

  test("check survives garbage, non-zero exit and a timeout", async () => {
    const garbage = makeLiveUpdater({
      home: dir,
      cliPath: stub("garbage", `console.log("<html>")`),
    })
    await expect(garbage.check()).rejects.toThrow("unrecognised")
    const failing = makeLiveUpdater({
      home: dir,
      cliPath: stub("fail", `console.error("bad token"); process.exit(4)`),
    })
    await expect(failing.check()).rejects.toThrow("exited 4: bad token")
    const slow = makeLiveUpdater({
      home: dir,
      cliPath: stub("slow", "await Bun.sleep(10_000)"),
      timeoutMs: 300,
    })
    const t0 = Date.now()
    await expect(slow.check()).rejects.toThrow("timed out")
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(makeLiveUpdater({ home: dir, cliPath: join(dir, "missing") }).supported()).toBe(false)
  })

  test("apply returns at once; the child runs on in its own process group", async () => {
    const marker = join(dir, "marker")
    const pidFile = join(dir, "pid")
    const cliPath = stub(
      "apply",
      `import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
console.log("args", process.argv.slice(2).join(" "))
await Bun.sleep(1500)
writeFileSync(${JSON.stringify(marker)}, "done")`,
    )
    const u = makeLiveUpdater({ home: dir, cliPath })
    let exited: number | null | undefined
    const t0 = Date.now()
    await u.apply("0.3.0", (code) => {
      exited = code
    })
    expect(Date.now() - t0).toBeLessThan(500)
    expect(existsSync(marker)).toBe(false)
    for (let i = 0; i < 50 && !existsSync(pidFile); i++) await Bun.sleep(50)
    const pid = (await Bun.file(pidFile).text()).trim()
    const pgid = (await Bun.$`ps -o pgid= -p ${pid}`.text()).trim()
    const ourPgid = (await Bun.$`ps -o pgid= -p ${process.pid}`.text()).trim()
    expect(pgid).toBe(pid) // group leader (setsid)
    expect(pgid).not.toBe(ourPgid)
    for (let i = 0; i < 60 && !existsSync(marker); i++) await Bun.sleep(50)
    expect(existsSync(marker)).toBe(true)
    for (let i = 0; i < 20 && exited === undefined; i++) await Bun.sleep(50)
    expect(exited).toBe(0)
    expect(await Bun.file(join(dir, "update.log")).text()).toContain("args update --yes --to 0.3.0")
  })

  test("the spawned update outlives the process that spawned it", async () => {
    const marker = join(dir, "orphan-marker")
    const cliPath = stub(
      "orphan",
      `await Bun.sleep(1000)\nawait Bun.write(${JSON.stringify(marker)}, "ok")`,
    )
    const services = join(import.meta.dir, "../src/services.ts")
    const parent = join(dir, "parent.ts")
    writeFileSync(
      parent,
      `import { makeLiveUpdater } from ${JSON.stringify(services)}
await makeLiveUpdater({ home: ${JSON.stringify(dir)}, cliPath: ${JSON.stringify(cliPath)} }).apply("0.3.0")
process.exit(0)`,
    )
    const p = Bun.spawn(["bun", parent], { stdout: "ignore", stderr: "inherit" })
    expect(await p.exited).toBe(0)
    expect(existsSync(marker)).toBe(false)
    for (let i = 0; i < 60 && !existsSync(marker); i++) await Bun.sleep(50)
    expect(existsSync(marker)).toBe(true)
  })

  test("readState reads update-state.json, null when absent or corrupt", () => {
    const u = makeLiveUpdater({ home: dir, cliPath: join(dir, "missing") })
    expect(u.readState()).toBeNull()
    writeFileSync(join(dir, "update-state.json"), "{garbage")
    expect(u.readState()).toBeNull()
    writeFileSync(
      join(dir, "update-state.json"),
      JSON.stringify({ version: "0.3.0", state: "installing", error: null, at: 9 }),
    )
    expect(u.readState()?.state).toBe("installing")
  })
})
