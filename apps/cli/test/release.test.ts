/**
 * Release → install → update, end to end with real compiled binaries and no network:
 * two payloads (0.2.0 and 0.3.0) built by scripts/release.ts, a local server faking the
 * GitHub releases API and asset downloads, and every install in /tmp/si-* with HOME
 * pointed there too, so nothing can reach the real ~/.claude, launchd or ~/Applications.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { type FakeReleases, startFakeReleases } from "../../../scripts/fake-releases.ts"
import { buildRelease, type ReleaseResult } from "../../../scripts/release.ts"

const repo = join(import.meta.dir, "../../..")
const root = mkdtempSync("/tmp/si-rel-")
const fakeHome = join(root, "user") // HOME for every subprocess
const home = join(root, "h")
const settings = join(root, "settings.json")
const userSettings = {
  model: "opus",
  hooks: { Stop: [{ hooks: [{ type: "command", command: "say done", timeout: 5 }] }] },
}

let r020: ReleaseResult
let r030: ReleaseResult
let fake: FakeReleases
let base = ""
const setCorrupt = (on: boolean) => fake.setCorrupt("*", on)

const run = async (cmd: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawn(cmd, {
    cwd: root,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: fakeHome,
      SESSION_INBOX_RELEASES_URL: `${base}/releases`,
      ...env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, stdout, stderr }
}
const cli = (...args: string[]) => run([join(home, "bin", "session-inbox"), ...args])
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"))

beforeAll(async () => {
  mkdirSync(fakeHome, { recursive: true })
  writeFileSync(settings, `${JSON.stringify(userSettings, null, 2)}\n`)
  r020 = await buildRelease({
    out: join(root, "r020"),
    version: "0.2.0",
    skipApp: true,
    verbose: false,
  })
  r030 = await buildRelease({
    out: join(root, "r030"),
    version: "0.3.0",
    skipApp: true,
    verbose: false,
  })
  fake = startFakeReleases()
  fake.add(r020)
  fake.add(r030, { latest: true })
  base = fake.base
}, 600_000)

afterAll(() => {
  fake?.stop()
  rmSync(root, { recursive: true, force: true })
})

describe("release payload", () => {
  test("has the documented layout, manifest and checksum", async () => {
    const p = r020.payload
    expect(readdirSync(p).sort()).toEqual(["bin", "manifest.json", "ui"])
    expect(readdirSync(join(p, "bin")).sort()).toEqual(["inbox-hook", "inboxd", "session-inbox"])
    expect(json(join(p, "manifest.json"))).toMatchObject({
      name: "session-inbox",
      version: "0.2.0",
      arch: "arm64",
    })
    expect(readFileSync(r020.sidecar, "utf8")).toMatch(/^[0-9a-f]{64}\n$/)
    const list = Bun.spawnSync(["/usr/bin/tar", "-tzf", r020.tarball]).stdout.toString().split("\n")
    expect(list.filter(Boolean).every((l) => l.startsWith("session-inbox-0.2.0/"))).toBe(true)
    expect(list).toContain("session-inbox-0.2.0/bin/session-inbox")
  })
})

describe("install, then update from the fake release server", () => {
  let hooksAfterInstall = ""

  test("install --from the 0.2.0 payload", async () => {
    const dry = await run([
      join(r020.payload, "bin", "session-inbox"),
      "install",
      "--home",
      home,
      "--settings",
      settings,
      "--no-launchd",
    ])
    expect(dry.code).toBe(0)
    expect(dry.stdout).toContain("DRY RUN")
    expect(existsSync(home)).toBe(false)

    const r = await run([
      join(r020.payload, "bin", "session-inbox"),
      "install",
      "--from",
      r020.payload,
      "--yes",
      "--home",
      home,
      "--settings",
      settings,
      "--no-launchd",
      "--no-app",
      "--label",
      "com.sessioninbox.inboxd.test",
      "--asset-url",
      fake.assetUrl,
      "--daemon-env",
      "CLAUDE_CONFIG_DIR=/nowhere",
    ])
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
    expect(json(join(home, "install.json"))).toMatchObject({
      version: "0.2.0",
      channel: "ga",
      source: "release",
      settingsPath: settings,
      launchd: false,
      hooks: true,
      app: false,
      label: "com.sessioninbox.inboxd.test",
      // From the environment the installer ran with: install from a mirror.
      releasesUrl: `${base}/releases`,
      assetUrl: fake.assetUrl,
      repo: null,
      daemonEnv: { CLAUDE_CONFIG_DIR: "/nowhere" },
    })
    // What happens next, in plain words, and pointing at this home's own CLI.
    expect(r.stdout).toContain("Restart any Claude Code sessions")
    expect(r.stdout).toContain(`"${join(home, "bin", "session-inbox")}" doctor`)
    const s = json(settings)
    expect(s.model).toBe("opus")
    expect(JSON.stringify(s.hooks)).toContain(`${home}/bin/inbox-hook`)
    hooksAfterInstall = readFileSync(settings, "utf8")
    expect((await cli("--version")).stdout).toContain("0.2.0")
    // A custom home never gets the ~/.local/bin link.
    expect(existsSync(join(fakeHome, ".local/bin/session-inbox"))).toBe(false)
  }, 60_000)

  test("update --check --json reports 0.3.0 as one JSON line", async () => {
    const r = await cli("update", "--check", "--json")
    expect(r.code).toBe(0)
    const lines = r.stdout.trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toEqual({
      current: "0.2.0",
      latest: "0.3.0",
      available: true,
      notesUrl: `${base}/notes/v0.3.0`,
      publishedAt: "2026-11-09T12:00:00Z",
      source: "release",
      error: null,
    })
  })

  test("without the environment, update --check uses the mirror recorded at install", async () => {
    const r = await run([join(home, "bin", "session-inbox"), "update", "--check", "--json"], {
      SESSION_INBOX_RELEASES_URL: "",
    })
    expect(JSON.parse(r.stdout)).toMatchObject({ latest: "0.3.0", available: true, error: null })
  })

  test("update --check --json exits 0 with an error when the server is unreachable", async () => {
    const r = await run([join(home, "bin", "session-inbox"), "update", "--check", "--json"], {
      SESSION_INBOX_RELEASES_URL: "http://127.0.0.1:9/releases",
    })
    expect(r.code).toBe(0)
    const v = JSON.parse(r.stdout)
    expect(v).toMatchObject({ current: "0.2.0", latest: null, available: false })
    expect(typeof v.error).toBe("string")
  })

  test("beta never updates from releases", async () => {
    const c = JSON.parse((await cli("update", "--channel", "beta", "--check", "--json")).stdout)
    expect(c.available).toBe(false)
    expect(c.error).toContain("never updates from releases")
    expect(c.error).not.toMatch(/\([A-Z]-\d+\)/)
    expect((await cli("update", "--channel", "beta", "--yes")).code).toBe(2)
  })

  test("update without --yes is a dry run", async () => {
    const r = await cli("update")
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("DRY RUN")
    expect(json(join(home, "install.json")).version).toBe("0.2.0")
  })

  test("update --yes moves every binary to 0.3.0 and keeps the hooks", async () => {
    const r = await cli("update", "--yes")
    expect(r.code).toBe(0)
    expect(json(join(home, "update-state.json"))).toMatchObject({
      version: "0.3.0",
      state: "done",
      error: null,
    })
    expect(json(join(home, "install.json"))).toMatchObject({
      version: "0.3.0",
      source: "release",
      label: "com.sessioninbox.inboxd.test",
      releasesUrl: `${base}/releases`,
      assetUrl: fake.assetUrl,
      daemonEnv: { CLAUDE_CONFIG_DIR: "/nowhere" },
    })
    // The mirror's {tag} download base was used, not the release JSON's URLs.
    expect(fake.requests).toContain("/download/v0.3.0/session-inbox-0.3.0-macos-arm64.tar.gz")
    expect((await cli("--version")).stdout).toContain("0.3.0")
    expect((await run([join(home, "bin", "inbox-hook"), "--version"])).stdout.trim()).toBe("0.3.0")
    expect(readFileSync(settings, "utf8")).toBe(hooksAfterInstall)
    expect(readdirSync(join(home, "updates")).filter((d) => d !== ".lock")).toEqual([])
    expect(readFileSync(join(home, "update.log"), "utf8")).toContain("updated to 0.3.0")
    expect((await cli("update", "--yes")).stdout).toContain("up to date")
  }, 120_000)

  test("the updated daemon reports 0.3.0", async () => {
    const claudeDir = join(root, "claude")
    mkdirSync(claudeDir, { recursive: true })
    const d = Bun.spawn([join(home, "bin", "inboxd")], {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: fakeHome,
        SESSION_INBOX_HOME: home,
        SESSION_INBOX_UI_DIR: join(home, "ui"),
        CLAUDE_CONFIG_DIR: claudeDir,
        SESSION_INBOX_CLAUDE: "/usr/bin/false",
      },
      stdout: "ignore",
      stderr: "ignore",
    })
    try {
      let health: { version?: string } | null = null
      for (let i = 0; i < 100 && !health; i++) {
        await Bun.sleep(100)
        try {
          health = (await (
            await fetch("http://localhost/v1/health", { unix: join(home, "inboxd.sock") })
          ).json()) as { version?: string }
        } catch {}
      }
      expect(health?.version).toBe("0.3.0")
    } finally {
      d.kill()
      await d.exited
    }
  }, 30_000)

  test("a corrupted tarball is refused and nothing changes", async () => {
    setCorrupt(true)
    try {
      const r = await cli("update", "--yes", "--to", "0.2.0")
      expect(r.code).toBe(1)
      const s = json(join(home, "update-state.json"))
      expect(s).toMatchObject({ version: "0.2.0", state: "failed" })
      expect(s.error).toContain("checksum mismatch")
      expect((await cli("--version")).stdout).toContain("0.3.0")
      expect(json(join(home, "install.json")).version).toBe("0.3.0")
    } finally {
      setCorrupt(false)
    }
  }, 60_000)

  test("update --to an older version reinstalls it", async () => {
    const r = await cli("update", "--yes", "--to", "0.2.0")
    expect(r.code).toBe(0)
    expect((await cli("--version")).stdout).toContain("0.2.0")
    expect(readFileSync(settings, "utf8")).toBe(hooksAfterInstall)
  }, 120_000)

  test("with stdout pointed at update.log (as the daemon does), each line lands there once", async () => {
    const logFile = join(home, "update.log")
    rmSync(logFile, { force: true })
    writeFileSync(logFile, "")
    const fd = openSync(logFile, "a")
    const p = Bun.spawn([join(home, "bin", "session-inbox"), "update", "--yes", "--to", "0.3.0"], {
      cwd: root,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: fakeHome },
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    })
    const code = await p.exited
    closeSync(fd)
    expect(code).toBe(0)
    const log = readFileSync(logFile, "utf8")
    expect(log.split("\n").filter((l) => l.endsWith("updated to 0.3.0"))).toHaveLength(1)
    expect(log.split("\n").filter((l) => l.endsWith("checksum ok"))).toHaveLength(1)
  }, 120_000)
})

describe("two channels side by side", () => {
  // Both channels at their default homes under a temp HOME; no launchd, no real app.
  const user = join(root, "two")
  const support = join(user, "Library/Application Support")
  const gaHome = join(support, "SessionInbox")
  const betaHome = join(support, "SessionInbox-beta")
  const userSettings = join(user, ".claude/settings.json")
  const gaApp = join(user, "Applications/Session Inbox.app")
  const betaApp = join(user, "Applications/Session Inbox Beta.app")
  const loginItem = (title: string) => join(user, "Library/LaunchAgents", `${title}.plist`)
  const as = (cmd: string[]) => run(cmd, { HOME: user })
  const gaCli = (...args: string[]) => as([join(gaHome, "bin", "session-inbox"), ...args])
  const hookCount = (h: string) =>
    readFileSync(userSettings, "utf8").split(`${h}/bin/inbox-hook`).length - 1
  const fakeApp = (bundle: string, home: string, title: string) => {
    mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true })
    writeFileSync(join(bundle, "Contents/MacOS/session-inbox-shell"), "")
    const rec = json(join(home, "install.json"))
    writeFileSync(
      join(home, "install.json"),
      JSON.stringify({ ...rec, app: true, appPath: bundle }),
    )
    mkdirSync(join(user, "Library/LaunchAgents"), { recursive: true })
    const f = loginItem(title)
    writeFileSync(
      f,
      JSON.stringify({
        Label: title,
        ProgramArguments: [join(bundle, "Contents/MacOS/session-inbox-shell")],
      }),
    )
    Bun.spawnSync(["/usr/bin/plutil", "-convert", "xml1", f])
  }

  test("GA's CLI uninstalling beta leaves every GA hook, record, app and home alone", async () => {
    const payloadCli = join(r020.payload, "bin", "session-inbox")
    const base = ["install", "--from", r020.payload, "--yes", "--no-launchd", "--no-app"]
    expect((await as([payloadCli, ...base])).code).toBe(0)
    expect((await as([payloadCli, ...base, "--channel", "beta"])).code).toBe(0)
    fakeApp(gaApp, gaHome, "Session Inbox")
    fakeApp(betaApp, betaHome, "Session Inbox Beta")
    expect(hookCount(gaHome)).toBe(10)
    expect(hookCount(betaHome)).toBe(10)
    const gaRecord = readFileSync(join(gaHome, "install.json"), "utf8")

    const dry = await gaCli("uninstall", "--channel", "beta", "--no-launchd")
    expect(dry.code).toBe(0)
    expect(dry.stdout).toContain(`would quit and remove ${betaApp}`)
    expect(dry.stdout).not.toContain(gaApp)

    const u = await gaCli("uninstall", "--channel", "beta", "--yes", "--no-launchd")
    expect(u.stderr).toBe("")
    expect(u.code).toBe(0)
    expect(hookCount(gaHome)).toBe(10)
    expect(hookCount(betaHome)).toBe(0)
    expect(readFileSync(join(gaHome, "install.json"), "utf8")).toBe(gaRecord)
    expect(existsSync(gaApp)).toBe(true)
    expect(existsSync(loginItem("Session Inbox"))).toBe(true)
    expect(existsSync(join(gaHome, "bin", "inboxd"))).toBe(true)
    // Beta's own pieces are gone: app, its login item, record, PATH link. Its data stays.
    expect(existsSync(betaApp)).toBe(false)
    expect(existsSync(loginItem("Session Inbox Beta"))).toBe(false)
    expect(existsSync(join(betaHome, "install.json"))).toBe(false)
    expect(existsSync(join(user, ".local/bin/session-inbox-beta"))).toBe(false)
    expect(existsSync(join(user, ".local/bin/session-inbox"))).toBe(true)
    expect(existsSync(join(betaHome, "bin", "inboxd"))).toBe(true)

    // status/doctor --channel beta look at beta, not at the GA binary's own home.
    // (beta is now uninstalled; GA's own home would report a version and hooks.)
    const s = await gaCli("status", "--channel", "beta")
    expect(s.stdout).toContain("Session Inbox Beta (beta)\n  not installed")
  }, 120_000)

  test("--purge refuses a home whose install.json is the other channel's", async () => {
    const before = readFileSync(userSettings, "utf8")
    const u = await gaCli("uninstall", "--channel", "beta", "--home", gaHome, "--purge", "--yes")
    expect(u.code).not.toBe(0)
    expect(u.stderr).toContain("holds the ga install, not beta")
    expect(existsSync(join(gaHome, "install.json"))).toBe(true)
    expect(existsSync(join(gaHome, "bin", "inboxd"))).toBe(true)
    expect(existsSync(gaApp)).toBe(true)
    expect(readFileSync(userSettings, "utf8")).toBe(before)
  }, 60_000)
})

describe("install.sh", () => {
  test("with only the system PATH, installs the latest release into HOME", async () => {
    const shHome = join(root, "shhome")
    mkdirSync(shHome, { recursive: true })
    const env = {
      HOME: shHome,
      SESSION_INBOX_RELEASES_URL: `${base}/releases`,
      SESSION_INBOX_ASSET_URL: `${base}/download/v0.3.0`,
    }
    const r = await run(["/bin/sh", join(repo, "install.sh"), "--no-launchd"], env)
    expect(r.code).toBe(0)
    const ghome = join(shHome, "Library/Application Support/SessionInbox")
    expect(json(join(ghome, "install.json"))).toMatchObject({
      version: "0.3.0",
      source: "release",
      settingsPath: join(shHome, ".claude/settings.json"),
      launchd: false,
      label: null,
      releasesUrl: `${base}/releases`,
      assetUrl: `${base}/download/v0.3.0`,
    })
    // ~/.local/bin isn't on this PATH (nor on a fresh Mac's): print the full path, and how to add it.
    expect(r.stdout).toContain(`"${join(shHome, ".local/bin/session-inbox")}" doctor`)
    expect(r.stdout).not.toMatch(/: session-inbox doctor/)
    expect(r.stdout).toContain(`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`)
    expect(JSON.stringify(json(join(shHome, ".claude/settings.json")))).toContain(
      `${ghome}/bin/inbox-hook`,
    )
    const link = join(shHome, ".local/bin/session-inbox")
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(join(ghome, "bin/session-inbox"))
    expect(r.stdout).toContain("is not on your PATH")
    expect(existsSync(join(shHome, "Applications"))).toBe(false)

    const bad = await run(["/bin/sh", join(repo, "install.sh"), "--no-launchd"], {
      ...env,
      SESSION_INBOX_ASSET_URL: `${base}/download/v0.2.0`, // the wrong release's files
    })
    expect(bad.code).not.toBe(0)

    // ...and the installed CLI uninstalls everything, including the data with --purge.
    const u = await run([link, "uninstall", "--yes", "--no-launchd", "--purge"], { HOME: shHome })
    expect(u.code).toBe(0)
    expect(existsSync(ghome)).toBe(false)
    expect(existsSync(link)).toBe(false)
    expect(JSON.stringify(json(join(shHome, ".claude/settings.json")))).not.toContain("inbox-hook")
  }, 120_000)

  test("tells a GitHub error or rate limit apart from no release at all", async () => {
    let answer: () => Response = () => new Response("", { status: 404 })
    const api = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => answer() })
    const shHome = join(root, "shhome3")
    mkdirSync(shHome, { recursive: true })
    const sh = () =>
      run(["/bin/sh", join(repo, "install.sh"), "--no-launchd"], {
        HOME: shHome,
        SESSION_INBOX_RELEASES_URL: `http://127.0.0.1:${api.port}/releases`,
      })
    try {
      answer = () => Response.json({ message: "API rate limit exceeded" }, { status: 403 })
      const limited = await sh()
      expect(limited.code).toBe(1)
      expect(limited.stderr).toContain("couldn't reach GitHub")
      expect(limited.stderr).toContain("403")
      expect(limited.stderr).toContain("SESSION_INBOX_VERSION=vX.Y.Z")
      expect(limited.stderr).not.toContain("no release")

      // A repo with no releases: GitHub answers 404 for /latest.
      answer = () => Response.json({ message: "Not Found" }, { status: 404 })
      const none = await sh()
      expect(none.code).toBe(1)
      expect(none.stderr).toContain("no release has been published yet")

      answer = () => Response.json({ name: "no tag here" })
      const tagless = await sh()
      expect(tagless.code).toBe(1)
      expect(tagless.stderr).toContain("no release has been published yet")

      api.stop(true)
      const down = await sh()
      expect(down.code).toBe(1)
      expect(down.stderr).toContain("couldn't reach GitHub")
      expect(readdirSync(shHome)).toEqual([])
    } finally {
      api.stop(true)
    }
  }, 60_000)

  test("refuses a checksum mismatch before installing anything", async () => {
    const shHome = join(root, "shhome2")
    mkdirSync(shHome, { recursive: true })
    setCorrupt(true)
    try {
      const r = await run(["/bin/sh", join(repo, "install.sh"), "--no-launchd"], {
        HOME: shHome,
        SESSION_INBOX_VERSION: "v0.3.0",
        SESSION_INBOX_ASSET_URL: `${base}/download/v0.3.0`,
      })
      expect(r.code).toBe(1)
      expect(r.stderr).toContain("checksum mismatch")
      expect(readdirSync(shHome)).toEqual([])
    } finally {
      setCorrupt(false)
    }
  }, 60_000)
})
