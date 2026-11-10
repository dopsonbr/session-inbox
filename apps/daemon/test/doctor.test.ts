import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { DoctorReport, StreamMessage } from "@session-inbox/contracts"
import { buildHooks } from "../../hook/src/settings.ts"
import {
  buildReport,
  Doctor,
  type DoctorFacts,
  HOOK_EVENTS,
  inspectHooks,
  installCommand,
} from "../src/doctor.ts"
import { envelope, makeHarness } from "./fakes.ts"

const HOME = "/tmp/si-doc-home"
const facts = (over: Partial<DoctorFacts> = {}): DoctorFacts => ({
  now: 10_000_000,
  version: "0.1.0",
  build: "dev",
  channel: "ga",
  startedAt: 10_000_000 - 3 * 3600_000,
  home: HOME,
  installSource: "release",
  hooks: {
    settingsPath: "/c/settings.json",
    settings: "ok",
    registered: HOOK_EVENTS,
    otherHomes: [],
    binary: "ok",
    binaryPath: `${HOME}/bin/inbox-hook`,
  },
  firstHookAt: 1,
  lastHookAt: 10_000_000 - 60_000,
  holds: { enabled: true, tools: ["Bash", "Edit"] },
  otherChannel: null,
  auth: { found: true, loggedIn: true, method: "claude.ai", checkedAt: 1 },
  shell: {
    connected: true,
    status: { notifications: "authorized", alertStyle: "alert", version: "0.1.0" },
    connectedAt: 1,
  },
  fallback: true,
  update: null,
  storage: { dbBytes: 2_500_000, events: 1234, retentionDays: 14 },
  ...over,
})

const byId = (r: DoctorReport, id: string) => r.checks.find((c) => c.id === id)

describe("buildReport", () => {
  test("a healthy install: ok, nothing to attend to, ids in order", () => {
    const r = buildReport(facts())
    expect(r.ok).toBe(true)
    expect(r.attention).toBe(0)
    expect(r.firstRun).toBe(false)
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([
      ["daemon", "ok"],
      ["hooks", "ok"],
      ["events", "info"],
      ["holds", "ok"],
      ["claude-cli", "ok"],
      ["app", "ok"],
      ["notifications", "ok"],
      ["updates", "info"],
      ["storage", "info"],
    ])
    expect(byId(r, "daemon")?.detail).toContain("running for 3 h")
    expect(byId(r, "storage")?.detail).toContain("2.4 MB")
  })

  test("hooks: missing, partial, broken binary; fix depends on the install source", () => {
    const hooks = facts().hooks
    const none = buildReport(facts({ hooks: { ...hooks, settings: "missing", registered: [] } }))
    expect(byId(none, "hooks")).toMatchObject({
      status: "fail",
      fix: { kind: "copy", value: "session-inbox install --yes" },
    })
    expect(none.ok).toBe(false)
    const partial = buildReport(
      facts({ hooks: { ...hooks, registered: HOOK_EVENTS.slice(1) }, installSource: null }),
    )
    expect(byId(partial, "hooks")?.status).toBe("warn")
    expect(byId(partial, "hooks")?.detail).toContain("SessionStart is missing")
    expect(byId(partial, "hooks")?.fix?.value).toBe("bun scripts/install.ts --yes")
    const bin = buildReport(facts({ hooks: { ...hooks, binary: "missing" } }))
    expect(byId(bin, "hooks")?.status).toBe("fail")
    expect(installCommand({ installSource: "source", channel: "beta" })).toBe(
      "bun scripts/install.ts --yes --channel beta",
    )
  })

  test("events: none yet is the first run", () => {
    const r = buildReport(facts({ firstHookAt: null, lastHookAt: null }))
    expect(r.firstRun).toBe(true)
    expect(byId(r, "events")).toMatchObject({ status: "warn" })
    expect(byId(r, "events")?.detail).toContain("restart sessions that were already open")
  })

  test("holds: observer, other channel", () => {
    const r = buildReport(facts({ holds: { enabled: false, tools: [] }, otherChannel: "beta" }))
    expect(byId(r, "holds")?.status).toBe("info")
    expect(byId(r, "holds")?.detail).toContain("beta channel is also installed")
  })

  test("claude-cli: missing, logged out, unknown", () => {
    const missing = byId(
      buildReport(facts({ auth: { ...facts().auth, found: false } })),
      "claude-cli",
    )
    expect(missing).toMatchObject({ status: "warn", fix: { kind: "copy", value: "claude" } })
    expect(missing?.detail).toContain("replies to sessions")
    const out = byId(
      buildReport(facts({ auth: { ...facts().auth, loggedIn: false } })),
      "claude-cli",
    )
    expect(out?.status).toBe("warn")
    expect(out?.detail).toContain("not logged in")
    const unknown = byId(
      buildReport(facts({ auth: { found: null, loggedIn: null, method: null, checkedAt: 0 } })),
      "claude-cli",
    )
    expect(unknown?.status).toBe("info")
  })

  test("app and notifications for each shell state", () => {
    const shell = (s: Partial<DoctorFacts["shell"]>) =>
      buildReport(facts({ shell: { ...facts().shell, ...s } }))
    const none = shell({ connected: false, status: null, connectedAt: null })
    expect(byId(none, "app")?.status).toBe("warn")
    expect(byId(none, "notifications")?.status).toBe("warn")
    expect(byId(none, "notifications")?.detail).toContain("fallback")
    expect(
      byId(
        buildReport(
          facts({ fallback: false, shell: { connected: false, status: null, connectedAt: null } }),
        ),
        "notifications",
      )?.status,
    ).toBe("fail")
    const denied = shell({ status: { notifications: "denied" } })
    expect(byId(denied, "notifications")).toMatchObject({
      status: "fail",
      fix: {
        kind: "url",
        value: "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
      },
    })
    expect(byId(denied, "notifications")?.detail).toContain("plain fallback notifications")
    expect(denied.ok).toBe(false)
    const pending = shell({ status: { notifications: "notDetermined" } })
    expect(byId(pending, "notifications")?.status).toBe("warn")
    expect(byId(pending, "notifications")?.detail).toContain("look for the permission prompt")
    const banner = shell({ status: { notifications: "authorized", alertStyle: "banner" } })
    expect(byId(banner, "notifications")?.status).toBe("ok")
    expect(byId(banner, "notifications")?.detail).toContain('"Alerts"')
    expect(byId(shell({ status: { notifications: "provisional" } }), "notifications")?.status).toBe(
      "warn",
    )
    // Connected, never reported: an older app (after the grace period).
    const legacy = shell({ status: null, connectedAt: 1 })
    expect(byId(legacy, "app")?.status).toBe("warn")
    expect(byId(legacy, "notifications")?.status).toBe("warn")
    const justNow = shell({ status: null, connectedAt: facts().now - 1000 })
    expect(byId(justNow, "app")?.status).toBe("info")
    expect(byId(justNow, "notifications")?.status).toBe("info")
    const mismatch = shell({ status: { notifications: "authorized", version: "0.0.9" } })
    expect(byId(mismatch, "app")?.status).toBe("warn")
    expect(byId(mismatch, "app")?.detail).toContain("0.0.9")
  })

  test("updates", () => {
    const status = {
      state: "idle" as const,
      current: "0.1.0",
      build: "dev",
      latest: "0.1.0",
      available: false,
      notesUrl: null,
      publishedAt: null,
      checkedAt: facts().now - 3600_000,
      error: null,
      auto: true,
      source: "release" as const,
      target: null,
      progress: null,
      justUpdatedFrom: null,
      updatedAt: null,
    }
    expect(byId(buildReport(facts({ update: status })), "updates")?.status).toBe("ok")
    expect(
      byId(buildReport(facts({ update: { ...status, error: "offline" } })), "updates")?.status,
    ).toBe("warn")
    expect(
      byId(
        buildReport(facts({ update: { ...status, state: "failed", target: "0.2.0", error: "x" } })),
        "updates",
      )?.status,
    ).toBe("warn")
    expect(
      byId(
        buildReport(
          facts({ update: { ...status, state: "available", available: true, latest: "0.2.0" } }),
        ),
        "updates",
      )?.detail,
    ).toContain("0.2.0 is available")
  })
})

describe("inspectHooks", () => {
  test("reads which events point at this home", () => {
    const dir = mkdtempSync("/tmp/si-doc-")
    const home = join(dir, "home")
    const claude = join(dir, "claude")
    mkdirSync(join(home, "bin"), { recursive: true })
    mkdirSync(claude)
    expect(inspectHooks(claude, home)).toMatchObject({ settings: "missing", binary: "missing" })
    writeFileSync(join(claude, "settings.json"), "{nope")
    expect(inspectHooks(claude, home).settings).toBe("unreadable")
    const hooks = buildHooks(home)
    delete hooks.Stop
    const other = buildHooks(join(dir, "other"))
    writeFileSync(
      join(claude, "settings.json"),
      JSON.stringify({ hooks: { ...hooks, Stop: other.Stop } }),
    )
    writeFileSync(join(home, "bin", "inbox-hook"), "#!/bin/sh\n")
    chmodSync(join(home, "bin", "inbox-hook"), 0o644)
    const r = inspectHooks(claude, home)
    expect(r.registered).toHaveLength(HOOK_EVENTS.length - 1)
    expect(r.registered).not.toContain("Stop")
    expect(r.otherHomes).toEqual([join(dir, "other")])
    expect(r.binary).toBe("not-executable")
    chmodSync(join(home, "bin", "inbox-hook"), 0o755)
    expect(inspectHooks(claude, home).binary).toBe("ok")
  })
})

describe("Doctor over an engine", () => {
  test("tells pages when attention changes; a GET appends no event", async () => {
    const h = makeHarness()
    const doctor = new Doctor(h.engine, {
      home: "/tmp/si-doc-none",
      dbPath: "/tmp/si-doc-none/inbox.db",
      claudeConfigDir: h.claudeDir,
      channel: "ga",
      version: "0.1.0",
      build: "dev",
      otherChannel: () => null,
    })
    const msgs: StreamMessage[] = []
    h.engine.hub.subscribe(
      {
        kind: "ui",
        send: (f) => {
          const d = f.split("\n").find((l) => l.startsWith("data: "))
          if (d) msgs.push(JSON.parse(d.slice(6)) as StreamMessage)
        },
      },
      null,
      0,
    )
    const seq = h.engine.store.maxSeq()
    const first = await doctor.report()
    expect(first.firstRun).toBe(true)
    expect(h.engine.store.maxSeq()).toBe(seq)
    const attention = () => msgs.filter((m) => m._tag === "doctor").at(-1)
    expect(attention()).toMatchObject({ attention: first.attention })
    // The first hook event clears the "no events yet" warning.
    await h.engine.ingest("SessionStart", envelope("SessionStart", { session_id: "s", cwd: "/w" }))
    expect(attention()).toMatchObject({ attention: first.attention - 1 })
    expect((await doctor.report()).firstRun).toBe(false)
  })
})
