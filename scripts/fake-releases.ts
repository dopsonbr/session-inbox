/**
 * A local stand-in for the GitHub releases API and its asset downloads, shared by
 * `apps/cli/test/release.test.ts` and `scripts/e2e-update.ts`. Nothing leaves 127.0.0.1.
 *   GET /releases/latest              the release marked latest (404 when none)
 *   GET /releases/tags/v<version>     any release added so far
 *   GET /download/v<version>/<name>   the tarball or its .sha256 sidecar
 *   GET /notes/v<version>             release notes placeholder
 * `assetUrl` is the same download base in the `{tag}` form a mirror install records.
 */
import { sidecarName, tarballName } from "../apps/cli/src/releases.ts"

export type ServedRelease = { version: string; tarball: string; sidecar: string }

export type FakeReleases = {
  base: string
  /** SESSION_INBOX_RELEASES_URL for this server. */
  releasesUrl: string
  /** SESSION_INBOX_ASSET_URL for this server (`.../download/{tag}`). */
  assetUrl: string
  /** Serve this release (by tag); `latest: true` also makes it /releases/latest. */
  add: (r: ServedRelease, opts?: { latest?: boolean }) => void
  /** A release whose tarball is garbage and whose checksum can never match. */
  addBroken: (version: string, opts?: { latest?: boolean }) => void
  setLatest: (version: string | null) => void
  /** Serve garbage instead of the tarball for one version, or every version with "*". */
  setCorrupt: (version: string, on: boolean) => void
  /** Paths requested so far, in order. */
  requests: string[]
  releaseJson: (version: string) => unknown
  stop: () => void
}

const BROKEN = "broken"

export const startFakeReleases = (): FakeReleases => {
  const releases = new Map<string, ServedRelease>()
  const corrupt = new Set<string>()
  let latest: string | null = null
  const requests: string[] = []
  let base = ""

  const releaseJson = (v: string) => ({
    tag_name: `v${v}`,
    html_url: `${base}/notes/v${v}`,
    published_at: "2026-11-09T12:00:00Z",
    draft: false,
    prerelease: false,
    assets: [tarballName(v), sidecarName(v)].map((name) => ({
      name,
      browser_download_url: `${base}/download/v${v}/${name}`,
    })),
  })

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname
      requests.push(path)
      if (path === "/releases/latest")
        return latest ? Response.json(releaseJson(latest)) : new Response("", { status: 404 })
      const tag = /^\/releases\/tags\/v(.+)$/.exec(path)?.[1]
      if (tag)
        return releases.has(tag)
          ? Response.json(releaseJson(tag))
          : new Response("", { status: 404 })
      const dl = /^\/download\/v([^/]+)\/(.+)$/.exec(path)
      const rel = dl ? releases.get(dl[1] as string) : undefined
      if (dl && rel) {
        const isTarball = dl[2] === tarballName(rel.version)
        if (!isTarball && dl[2] !== sidecarName(rel.version))
          return new Response("", { status: 404 })
        if (rel.tarball === BROKEN)
          return new Response(isTarball ? "not a tarball" : `${"0".repeat(64)}\n`)
        if (isTarball && (corrupt.has(rel.version) || corrupt.has("*")))
          return new Response("not a tarball")
        return new Response(Bun.file(isTarball ? rel.tarball : rel.sidecar))
      }
      if (path.startsWith("/notes/")) return new Response("release notes")
      return new Response("", { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`

  const add = (r: ServedRelease, opts: { latest?: boolean } = {}) => {
    releases.set(r.version, r)
    if (opts.latest) latest = r.version
  }
  return {
    base,
    releasesUrl: `${base}/releases`,
    assetUrl: `${base}/download/{tag}`,
    add,
    addBroken: (version, opts) => add({ version, tarball: BROKEN, sidecar: BROKEN }, opts),
    setLatest: (v) => {
      latest = v
    },
    setCorrupt: (v, on) => {
      if (on) corrupt.add(v)
      else corrupt.delete(v)
    },
    requests,
    releaseJson,
    stop: () => server.stop(true),
  }
}
