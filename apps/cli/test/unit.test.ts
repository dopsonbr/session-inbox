import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseSidecar, sha256File, verifySha256 } from "../src/fsx.ts"
import { nextSteps } from "../src/install.ts"
import { isLabel, renderPlist } from "../src/launchd.ts"
import { validateManifest } from "../src/manifest.ts"
import {
  assetUrl,
  checkResult,
  fetchRelease,
  type GhRelease,
  releasesUrl,
  selectAssets,
  tarballName,
} from "../src/releases.ts"
import { bumpVersion, compareSemver, isNewer, isSemver } from "../src/semver.ts"
import {
  type InstallRecord,
  readInstallRecord,
  readUpdateState,
  writeInstallRecord,
  writeUpdateState,
} from "../src/state.ts"
import { BETA_REFUSAL, installArgs, sourceEnv } from "../src/update.ts"

const NO_EXTRAS = {
  label: null,
  releasesUrl: null,
  assetUrl: null,
  repo: null,
  daemonEnv: {},
} as const

const dir = mkdtempSync("/tmp/si-unit-")
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("semver", () => {
  test("orders releases numerically, not lexically", () => {
    expect(compareSemver("0.10.0", "0.9.9")).toBe(1)
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0)
    expect(compareSemver("v0.2.0", "0.2.0")).toBe(0)
    expect(compareSemver("0.2.0", "0.3.0")).toBe(-1)
    expect(isNewer("0.3.0", "0.2.0")).toBe(true)
    expect(isNewer("0.2.0", "0.2.0")).toBe(false)
  })
  test("a prerelease sorts before its release", () => {
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBe(-1)
    expect(compareSemver("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1)
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1)
    expect(compareSemver("1.0.0-beta", "1.0.0-alpha")).toBe(1)
  })
  test("bumps patch, minor and major", () => {
    expect(bumpVersion("0.2.3", "patch")).toBe("0.2.4")
    expect(bumpVersion("0.2.3", "minor")).toBe("0.3.0")
    expect(bumpVersion("0.2.3", "major")).toBe("1.0.0")
    expect(bumpVersion("1.0.0-rc.1", "patch")).toBe("1.0.1")
  })
  test("rejects non-versions", () => {
    expect(isSemver("1.2")).toBe(false)
    expect(isSemver("01.2.3")).toBe(false)
    expect(() => compareSemver("latest", "1.0.0")).toThrow()
  })
})

describe("manifest", () => {
  const good = {
    name: "session-inbox",
    version: "0.2.0",
    build: "abc123",
    arch: "arm64",
    builtAt: "2026-11-09T00:00:00Z",
  }
  test("accepts a release manifest", () => {
    expect(validateManifest({ ...good, extra: 1 })).toEqual(good as never)
  })
  test("rejects wrong arch, name or version", () => {
    expect(() => validateManifest({ ...good, arch: "x86_64" })).toThrow(/arch/)
    expect(() => validateManifest({ ...good, name: "other" })).toThrow(/name/)
    expect(() => validateManifest({ ...good, version: "next" })).toThrow(/version/)
    expect(() => validateManifest([])).toThrow()
  })
})

describe("sha256", () => {
  test("verifies a file against its sidecar and refuses a mismatch", async () => {
    const f = join(dir, "blob")
    writeFileSync(f, "hello\n")
    const hex = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
    expect(await sha256File(f)).toBe(hex)
    await verifySha256(f, `${hex}\n`)
    await verifySha256(f, `${hex.toUpperCase()}  blob\n`)
    await expect(verifySha256(f, `${"0".repeat(64)}\n`)).rejects.toThrow(/mismatch/)
    expect(() => parseSidecar("not a digest")).toThrow()
  })
})

describe("install.json", () => {
  test("round trips, and a missing or broken file reads as null", () => {
    const home = join(dir, "h1")
    const rec: InstallRecord = {
      version: "0.2.0",
      build: "abc",
      channel: "ga",
      source: "release",
      home: "/h",
      settingsPath: "/tmp/s.json",
      launchd: false,
      hooks: true,
      app: true,
      appPath: "/Users/x/Applications/Session Inbox.app",
      installedAt: "2026-11-09T00:00:00Z",
      label: "com.sessioninbox.inboxd.e2e",
      releasesUrl: "https://mirror.example/releases",
      assetUrl: "https://mirror.example/dl/{tag}",
      repo: "a/b",
      daemonEnv: { CLAUDE_CONFIG_DIR: "/tmp/c" },
    }
    expect(readInstallRecord(home)).toBeNull()
    writeInstallRecord(home, rec)
    expect(readInstallRecord(home)).toEqual(rec)
    writeFileSync(join(home, "install.json"), "{nope")
    expect(readInstallRecord(home)).toBeNull()
  })

  test("an older install.json without label or mirror reads as the defaults", () => {
    const home = join(dir, "h-old")
    mkdirSync(home, { recursive: true })
    writeFileSync(
      join(home, "install.json"),
      JSON.stringify({ version: "0.1.0", channel: "ga", source: "release", home }),
    )
    expect(readInstallRecord(home)).toMatchObject(NO_EXTRAS)
  })

  test("update re-runs the installer with the recorded choices", () => {
    const rec: InstallRecord = {
      version: "0.2.0",
      build: "abc",
      channel: "ga",
      source: "release",
      home: "/h",
      settingsPath: "/tmp/s.json",
      launchd: false,
      hooks: true,
      app: false,
      appPath: null,
      installedAt: "",
      ...NO_EXTRAS,
    }
    const args = installArgs("/p", "/h", "ga", rec, true)
    expect(args[0]).toBe("/p/bin/session-inbox")
    expect(args).toContain("--no-launchd")
    expect(args).toContain("--no-app")
    expect(args).toContain("--holds")
    expect(args).not.toContain("--no-hooks")
    expect(args.slice(args.indexOf("--settings"), args.indexOf("--settings") + 2)).toEqual([
      "--settings",
      "/tmp/s.json",
    ])
    expect(
      installArgs("/p", "/h", "ga", { ...rec, launchd: true, app: true }, false),
    ).not.toContain("--no-launchd")
    expect(args).not.toContain("--label")
    expect(args).not.toContain("--releases-url")
  })

  test("update keeps a custom label, the mirror and the daemon env", () => {
    const rec: InstallRecord = {
      version: "0.2.0",
      build: "abc",
      channel: "ga",
      source: "release",
      home: "/h",
      settingsPath: "/tmp/s.json",
      launchd: true,
      hooks: true,
      app: false,
      appPath: null,
      installedAt: "",
      label: "com.sessioninbox.inboxd.e2e",
      releasesUrl: "http://127.0.0.1:1/releases",
      assetUrl: "http://127.0.0.1:1/download/{tag}",
      repo: "a/b",
      daemonEnv: { CLAUDE_CONFIG_DIR: "/tmp/c", SESSION_INBOX_CLAUDE: "/usr/bin/false" },
    }
    const args = installArgs("/p", "/h", "ga", rec, false).join(" ")
    expect(args).toContain("--label com.sessioninbox.inboxd.e2e")
    expect(args).toContain("--releases-url http://127.0.0.1:1/releases")
    expect(args).toContain("--asset-url http://127.0.0.1:1/download/{tag}")
    expect(args).toContain("--repo a/b")
    expect(args).toContain("--daemon-env CLAUDE_CONFIG_DIR=/tmp/c")
    expect(args).toContain("--daemon-env SESSION_INBOX_CLAUDE=/usr/bin/false")
  })

  test("the release source: environment first, else the recorded mirror", () => {
    const rec = { releasesUrl: "http://m/r", assetUrl: null, repo: null } as InstallRecord
    expect(sourceEnv({}, rec)).toEqual({ SESSION_INBOX_RELEASES_URL: "http://m/r" })
    expect(sourceEnv({ SESSION_INBOX_REPO: "x/y" }, rec)).toEqual({ SESSION_INBOX_REPO: "x/y" })
    expect(sourceEnv({ SESSION_INBOX_RELEASES_URL: "" }, rec).SESSION_INBOX_RELEASES_URL).toBe(
      "http://m/r",
    )
    expect(sourceEnv({ A: "1" }, null)).toEqual({ A: "1" })
  })
})

describe("launchd plist", () => {
  test("renders the label, home and extra environment, escaped", () => {
    const xml = renderPlist({
      label: "com.sessioninbox.inboxd.e2e",
      home: "/tmp/si-e2e-x/h",
      path: "/usr/bin:/bin",
      channel: "ga",
      settingDefaults: {},
      env: { SESSION_INBOX_RELEASES_URL: "http://127.0.0.1:5/releases?a=1&b=2" },
    })
    expect(xml).toContain("<string>com.sessioninbox.inboxd.e2e</string>")
    expect(xml).toContain("<string>/tmp/si-e2e-x/h/bin/inboxd</string>")
    expect(xml).toMatch(
      /<key>SESSION_INBOX_RELEASES_URL<\/key>\s*<string>http:\/\/127\.0\.0\.1:5\/releases\?a=1&amp;b=2<\/string>\s*<\/dict>/,
    )
    expect(xml).not.toContain("{{")
    const plain = renderPlist({
      label: "l",
      home: "/h",
      path: "/p",
      channel: "ga",
      settingDefaults: {},
    })
    expect(plain).not.toContain("RELEASES_URL")
    expect(plain).not.toContain("{{")
    // plutil is the judge of a well-formed plist.
    const f = join(dir, "e2e.plist")
    writeFileSync(f, xml)
    expect(Bun.spawnSync(["/usr/bin/plutil", "-lint", f]).exitCode).toBe(0)
  })

  test("labels must be reverse-DNS-ish", () => {
    expect(isLabel("com.sessioninbox.inboxd.e2e")).toBe(true)
    expect(isLabel("../evil")).toBe(false)
    expect(isLabel("a b")).toBe(false)
  })
})

describe("user-facing text", () => {
  test("never cites internal decision ids", () => {
    const lines = [
      BETA_REFUSAL,
      ...nextSteps({ channel: "ga", app: true, cli: "session-inbox" }),
    ].join("\n")
    expect(lines).not.toMatch(/\([A-Z]-\d+\)/)
  })

  test("after install: menu bar, notifications, restart sessions, doctor, uninstall", () => {
    const withApp = nextSteps({ channel: "ga", app: true, cli: "session-inbox" })
    expect(withApp.join("\n")).toContain("menu bar")
    expect(withApp.join("\n")).toContain("click Allow")
    expect(withApp.join("\n")).toContain("session-inbox doctor")
    expect(withApp.join("\n")).toContain("session-inbox uninstall")
    expect(withApp.filter((l) => l.trim() !== "").length).toBeLessThanOrEqual(6)
    expect(nextSteps({ channel: "ga", app: false, cli: "x" }).join("\n")).not.toContain("menu bar")
  })
})

describe("update-state.json", () => {
  test("each write replaces the whole file atomically", () => {
    const home = join(dir, "h2")
    writeUpdateState(home, "0.3.0", "downloading", null, () => 1)
    expect(readUpdateState(home)).toEqual({
      version: "0.3.0",
      state: "downloading",
      error: null,
      at: 1,
    })
    writeUpdateState(home, "0.3.0", "failed", "checksum mismatch", () => 2)
    expect(readUpdateState(home)).toEqual({
      version: "0.3.0",
      state: "failed",
      error: "checksum mismatch",
      at: 2,
    })
    expect(readdirSync(home)).toEqual(["update-state.json"]) // no temp files left behind
    expect(readFileSync(join(home, "update-state.json"), "utf8").trim().split("\n")).toHaveLength(1)
  })
})

describe("release selection", () => {
  const rel = (tag: string, names: string[]): GhRelease => ({
    tag_name: tag,
    html_url: `https://github.com/dopsonbr/session-inbox/releases/tag/${tag}`,
    published_at: "2026-11-09T00:00:00Z",
    assets: names.map((name) => ({ name, browser_download_url: `https://dl/${name}` })),
  })

  test("picks the arm64 tarball and its checksum", () => {
    const r = selectAssets(
      rel("v0.3.0", ["install.sh", tarballName("0.3.0"), `${tarballName("0.3.0")}.sha256`]),
    )
    expect(r.version).toBe("0.3.0")
    expect(r.tarball.browser_download_url).toBe(`https://dl/${tarballName("0.3.0")}`)
    expect(r.sidecar.name).toBe(`${tarballName("0.3.0")}.sha256`)
  })

  test("refuses a release missing either asset or with a non-version tag", () => {
    expect(() => selectAssets(rel("v0.3.0", [tarballName("0.3.0")]))).toThrow(/sha256/)
    expect(() => selectAssets(rel("nightly", []))).toThrow(/not a version/)
  })

  test("a mirror's asset base replaces the download URLs, with {tag} and {version} filled", () => {
    const r = rel("v0.3.0", [tarballName("0.3.0"), `${tarballName("0.3.0")}.sha256`])
    const env = { SESSION_INBOX_ASSET_URL: "https://m.example/{tag}/{version}/" }
    expect(selectAssets(r, env).tarball.browser_download_url).toBe(
      `https://m.example/v0.3.0/0.3.0/${tarballName("0.3.0")}`,
    )
    expect(assetUrl({}, "v1.0.0", "x", "https://dl/x")).toBe("https://dl/x")
    expect(assetUrl({ SESSION_INBOX_ASSET_URL: "https://flat" }, "v1.0.0", "x", "")).toBe(
      "https://flat/x",
    )
  })

  test("API base and repo are overridable; the request carries only a generic User-Agent", async () => {
    expect(releasesUrl({})).toBe("https://api.github.com/repos/dopsonbr/session-inbox/releases")
    expect(releasesUrl({ SESSION_INBOX_REPO: "a/b" })).toBe(
      "https://api.github.com/repos/a/b/releases",
    )
    expect(releasesUrl({ SESSION_INBOX_RELEASES_URL: "http://127.0.0.1:1/r/" })).toBe(
      "http://127.0.0.1:1/r",
    )
    let seen: { url: string; headers: Record<string, string> } | null = null
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> }
      return Response.json(rel("v0.4.0", [tarballName("0.4.0"), `${tarballName("0.4.0")}.sha256`]))
    }) as unknown as typeof fetch
    const r = await fetchRelease({ SESSION_INBOX_RELEASES_URL: "http://x/r" }, "0.4.0", fake)
    expect(r.version).toBe("0.4.0")
    expect(seen).toEqual({
      url: "http://x/r/tags/v0.4.0",
      headers: { "user-agent": "session-inbox", accept: "application/vnd.github+json" },
    } as never)
  })

  test("check result compares versions and reports errors", () => {
    const r = selectAssets(rel("v0.3.0", [tarballName("0.3.0"), `${tarballName("0.3.0")}.sha256`]))
    expect(checkResult("0.2.0", "release", r, null)).toMatchObject({
      latest: "0.3.0",
      available: true,
      error: null,
    })
    expect(checkResult("0.3.0", "release", r, null).available).toBe(false)
    expect(checkResult("0.10.0", "release", r, null).available).toBe(false)
    expect(checkResult("0.2.0", "source", null, "offline")).toEqual({
      current: "0.2.0",
      latest: null,
      available: false,
      notesUrl: null,
      publishedAt: null,
      source: "source",
      error: "offline",
    })
  })
})
