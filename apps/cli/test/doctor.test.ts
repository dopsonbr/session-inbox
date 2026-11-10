import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { DoctorReport } from "@session-inbox/contracts"
import {
  type DoctorTarget,
  doctor,
  fetchDoctor,
  localChecks,
  renderReport,
  summaryLine,
  wrap,
} from "../src/doctor.ts"

const dir = mkdtempSync("/tmp/si-doc-")
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const report: DoctorReport = {
  generatedAt: 1,
  ok: false,
  attention: 2,
  firstRun: false,
  checks: [
    { id: "daemon", title: "Daemon", status: "ok", detail: "running 0.4.0" },
    {
      id: "notifications",
      title: "Notifications",
      status: "warn",
      detail:
        "macOS hasn't been asked yet whether Session Inbox may show notifications, so nothing will pop up when a session needs you. Open the app once.",
      fix: { label: "Open settings", kind: "url", value: "x-apple.systempreferences:notif" },
    },
    {
      id: "hooks",
      title: "Hooks",
      status: "fail",
      detail: "not installed",
      fix: { label: "Reinstall", kind: "copy", value: "session-inbox install --yes" },
    },
    { id: "storage", title: "Storage", status: "info", detail: "12 MB" },
  ],
}

describe("renderer", () => {
  test("markers, aligned titles, details wrapped at 80 columns, fixes underneath", () => {
    const lines = renderReport(report)
    expect(lines[0]).toBe("✓ Daemon         running 0.4.0")
    expect(lines[1]?.startsWith("! Notifications  macOS hasn't been asked")).toBe(true)
    expect(lines.every((l) => l.length <= 80)).toBe(true)
    // Continuation lines line up under the detail column.
    const cont = lines[2] as string
    expect(cont.startsWith(" ".repeat(17))).toBe(true)
    expect(cont[17]).not.toBe(" ")
    expect(lines).toContain(`${" ".repeat(17)}→ open: x-apple.systempreferences:notif`)
    expect(lines).toContain("✗ Hooks          not installed")
    expect(lines).toContain(`${" ".repeat(17)}→ run: session-inbox install --yes`)
    expect(lines.at(-1)).toBe("· Storage        12 MB")
    expect(summaryLine(report)).toBe("1 failed, 1 needs attention")
    expect(summaryLine({ checks: [report.checks[0] as never] })).toBe("Everything looks good.")
  })

  test("wrap keeps newlines and never splits a word", () => {
    expect(wrap("a b c", 3)).toEqual(["a b", "c"])
    expect(wrap("one\ntwo", 80)).toEqual(["one", "two"])
    expect(wrap("averyveryverylongword x", 5)).toEqual(["averyveryverylongword", "x"])
  })
})

const target = (home: string, settingsPath: string): DoctorTarget => ({
  home,
  label: "com.sessioninbox.inboxd.doctor-test",
  settingsPath,
})

describe("offline checks", () => {
  test("an empty home: missing home, binaries, job and hooks", () => {
    const t = target(join(dir, "nothing"), join(dir, "nothing.json"))
    const checks = localChecks(t, "no connection.json", () => ({ loaded: false, pid: null }))
    const by = Object.fromEntries(checks.map((c) => [c.id, c]))
    expect(by.home?.status).toBe("fail")
    expect(by.binaries?.status).toBe("fail")
    expect(by.launchd?.status).toBe("fail")
    expect(by.launchd?.detail).toContain("not installed")
    expect(by.daemon?.detail).toContain("no connection.json")
    expect(by.hooks?.status).toBe("fail")
    expect(by.log?.status).toBe("info")
  })

  test("a healthy-looking home: binaries, hooks pointing here, log tail", () => {
    const home = join(dir, "h")
    mkdirSync(join(home, "bin"), { recursive: true })
    for (const b of ["inbox-hook", "inboxd", "session-inbox"]) {
      writeFileSync(join(home, "bin", b), "#!/bin/sh\n")
      chmodSync(join(home, "bin", b), 0o755)
    }
    writeFileSync(
      join(home, "inboxd.log"),
      `${Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n")}\n`,
    )
    const settings = join(dir, "s.json")
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: `"${home}/bin/inbox-hook" Stop` }] }],
        },
      }),
    )
    const checks = localChecks(target(home, settings), "no answer within 3 s", () => ({
      loaded: true,
      pid: null,
    }))
    const by = Object.fromEntries(checks.map((c) => [c.id, c]))
    expect(by.home?.status).toBe("ok")
    expect(by.binaries?.status).toBe("ok")
    expect(by.launchd).toMatchObject({ status: "fail", detail: expect.stringContaining("loaded") })
    expect(by.launchd?.fix?.value).toMatch(
      /^launchctl kickstart -k gui\/\d+\/com\.sessioninbox\.inboxd\.doctor-test$/,
    )
    expect(by.hooks?.status).toBe("ok")
    const log = by.log?.detail.split("\n") ?? []
    expect(log.slice(1)).toEqual(Array.from({ length: 10 }, (_, i) => `line ${i + 6}`))
  })

  test("hooks pointing at another home are called out", () => {
    const settings = join(dir, "other.json")
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: '"/elsewhere/bin/inbox-hook" Stop' }] }],
        },
      }),
    )
    const checks = localChecks(target(join(dir, "h"), settings), "x", () => ({
      loaded: true,
      pid: 42,
    }))
    const hooks = checks.find((c) => c.id === "hooks")
    expect(hooks?.status).toBe("fail")
    expect(hooks?.detail).toContain("/elsewhere")
    expect(checks.find((c) => c.id === "launchd")?.status).toBe("ok")
  })
})

describe("online", () => {
  const serve = (handler: (req: Request) => Response | Promise<Response>) => {
    const home = mkdtempSync(join(dir, "on-"))
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler })
    writeFileSync(
      join(home, "connection.json"),
      JSON.stringify({ socketPath: "/nope", httpPort: server.port, token: "tok", pid: 1 }),
    )
    return { home, server }
  }

  test("renders the daemon's report and exits 1 when it isn't ok", async () => {
    let auth = ""
    const { home, server } = serve((req) => {
      auth = req.headers.get("authorization") ?? ""
      return Response.json(report)
    })
    try {
      const out: string[] = []
      const code = await doctor(target(home, "/none"), { json: false }, (l) => out.push(l))
      expect(auth).toBe("Bearer tok")
      expect(code).toBe(1)
      expect(out[0]).toBe("✓ Daemon         running 0.4.0")
      expect(out.at(-1)).toBe("1 failed, 1 needs attention")
      const json: string[] = []
      await doctor(target(home, "/none"), { json: true }, (l) => json.push(l))
      expect(JSON.parse(json.join(""))).toEqual(report)
      const okReport = { ...report, ok: true, checks: [report.checks[0]] }
      server.reload({ fetch: () => Response.json(okReport) })
      expect(await doctor(target(home, "/none"), { json: false }, () => {})).toBe(0)
    } finally {
      server.stop(true)
    }
  })

  test("a daemon without /v1/doctor is too old, not offline", async () => {
    const { home, server } = serve(() => new Response("", { status: 404 }))
    try {
      expect(await fetchDoctor(home)).toEqual({ _tag: "too-old" })
      const out: string[] = []
      expect(await doctor(target(home, "/none"), { json: false }, (l) => out.push(l))).toBe(1)
      expect(out[0]).toContain("too old for the setup check")
      expect(out.some((l) => l.startsWith("✗ Daemon"))).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test("no connection.json, or no answer within the timeout, falls back to local checks", async () => {
    expect((await fetchDoctor(join(dir, "missing")))._tag).toBe("offline")
    const { home, server } = serve(async () => {
      await Bun.sleep(1000)
      return Response.json(report)
    })
    try {
      const r = await fetchDoctor(home, 100)
      expect(r).toEqual({ _tag: "offline", reason: "no answer within 0.1 s" })
      const out: string[] = []
      const code = await doctor(target(join(dir, "missing"), "/none"), { json: true }, (l) =>
        out.push(l),
      )
      expect(code).toBe(1)
      const v = JSON.parse(out.join("")) as DoctorReport
      expect(v.ok).toBe(false)
      expect(v.checks.map((c) => c.id)).toEqual([
        "home",
        "binaries",
        "launchd",
        "daemon",
        "hooks",
        "log",
      ])
    } finally {
      server.stop(true)
    }
  })
})
