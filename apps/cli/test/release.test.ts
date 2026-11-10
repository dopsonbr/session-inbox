/**
 * Release → install → update, end to end with real compiled binaries and no network:
 * two payloads (0.2.0 and 0.3.0) built by scripts/release.ts, a local server faking the
 * GitHub releases API and asset downloads, and every install in /tmp/si-* with HOME
 * pointed there too, so nothing can reach the real ~/.claude, launchd or ~/Applications.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { buildRelease, type ReleaseResult } from "../../../scripts/release.ts"
import { sidecarName, tarballName } from "../src/releases.ts"

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
let server: ReturnType<typeof Bun.serve>
let base = ""
const latest = "0.3.0"
let corrupt = false

const releaseJson = (v: string) => ({
  tag_name: `v${v}`,
  html_url: `${base}/notes/v${v}`,
  published_at: "2026-11-09T12:00:00Z",
  assets: [tarballName(v), sidecarName(v)].map((name) => ({
    name,
    browser_download_url: `${base}/download/v${v}/${name}`,
  })),
})

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
  const byVersion: Record<string, ReleaseResult> = { "0.2.0": r020, "0.3.0": r030 }
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === "/releases/latest") return Response.json(releaseJson(latest))
      const tag = /^\/releases\/tags\/v(.+)$/.exec(path)?.[1]
      if (tag)
        return byVersion[tag] ? Response.json(releaseJson(tag)) : new Response("", { status: 404 })
      const dl = /^\/download\/v([^/]+)\/(.+)$/.exec(path)
      const rel = dl ? byVersion[dl[1] as string] : undefined
      if (dl && rel) {
        const file = dl[2] === tarballName(rel.version) ? rel.tarball : rel.sidecar
        if (corrupt && file === rel.tarball) return new Response("not a tarball")
        return new Response(Bun.file(file))
      }
      return new Response("", { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
}, 600_000)

afterAll(() => {
  server?.stop(true)
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
    })
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
    expect(c.error).toContain("G-029")
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
    expect(json(join(home, "install.json"))).toMatchObject({ version: "0.3.0", source: "release" })
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
    corrupt = true
    try {
      const r = await cli("update", "--yes", "--to", "0.2.0")
      expect(r.code).toBe(1)
      const s = json(join(home, "update-state.json"))
      expect(s).toMatchObject({ version: "0.2.0", state: "failed" })
      expect(s.error).toContain("checksum mismatch")
      expect((await cli("--version")).stdout).toContain("0.3.0")
      expect(json(join(home, "install.json")).version).toBe("0.3.0")
    } finally {
      corrupt = false
    }
  }, 60_000)

  test("update --to an older version reinstalls it", async () => {
    const r = await cli("update", "--yes", "--to", "0.2.0")
    expect(r.code).toBe(0)
    expect((await cli("--version")).stdout).toContain("0.2.0")
    expect(readFileSync(settings, "utf8")).toBe(hooksAfterInstall)
  }, 120_000)
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
    })
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

  test("refuses a checksum mismatch before installing anything", async () => {
    const shHome = join(root, "shhome2")
    mkdirSync(shHome, { recursive: true })
    corrupt = true
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
      corrupt = false
    }
  }, 60_000)
})
