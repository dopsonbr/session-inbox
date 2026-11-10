import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseSidecar, sha256File, verifySha256 } from "../src/fsx.ts"
import { validateManifest } from "../src/manifest.ts"
import {
  checkResult,
  fetchRelease,
  type GhRelease,
  releasesUrl,
  selectAssets,
  tarballName,
} from "../src/releases.ts"
import { compareSemver, isNewer, isSemver } from "../src/semver.ts"
import {
  type InstallRecord,
  readInstallRecord,
  readUpdateState,
  writeInstallRecord,
  writeUpdateState,
} from "../src/state.ts"
import { installArgs } from "../src/update.ts"

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
    }
    expect(readInstallRecord(home)).toBeNull()
    writeInstallRecord(home, rec)
    expect(readInstallRecord(home)).toEqual(rec)
    writeFileSync(join(home, "install.json"), "{nope")
    expect(readInstallRecord(home)).toBeNull()
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
