/**
 * GitHub Releases: which release to install and where its assets are (G-024, G-028).
 * `SESSION_INBOX_RELEASES_URL` replaces `https://api.github.com/repos/<repo>/releases`
 * (tests point it at a local fake); `SESSION_INBOX_REPO` replaces the repo.
 * `SESSION_INBOX_ASSET_URL` replaces the assets' download base: `<base>/<asset name>`, where
 * `{tag}` and `{version}` in the base are filled in (a flat mirror needs neither, since every
 * asset name carries its version). Recorded in install.json, so updates use the same mirror.
 */
import { compareSemver, isSemver } from "./semver.ts"

export const DEFAULT_REPO = "dopsonbr/session-inbox"
type Env = Record<string, string | undefined>

export const repoOf = (env: Env) => env.SESSION_INBOX_REPO || DEFAULT_REPO
export const releasesUrl = (env: Env) =>
  (
    env.SESSION_INBOX_RELEASES_URL || `https://api.github.com/repos/${repoOf(env)}/releases`
  ).replace(/\/+$/, "")

export const tarballName = (version: string) => `session-inbox-${version}-macos-arm64.tar.gz`
export const sidecarName = (version: string) => `${tarballName(version)}.sha256`
/** The top-level directory inside the tarball, i.e. the payload dir name. */
export const payloadDirName = (version: string) => `session-inbox-${version}`

export type GhAsset = { name: string; browser_download_url: string }
export type GhRelease = {
  tag_name: string
  html_url?: string
  published_at?: string | null
  draft?: boolean
  prerelease?: boolean
  assets?: GhAsset[]
}

export type ResolvedRelease = {
  version: string
  tag: string
  notesUrl: string
  publishedAt: string | null
  tarball: GhAsset
  sidecar: GhAsset
}

/** Where to download `name` from: the mirror's base when SESSION_INBOX_ASSET_URL is set. */
export const assetUrl = (env: Env, tag: string, name: string, fallback: string): string => {
  const base = env.SESSION_INBOX_ASSET_URL
  if (!base) return fallback
  const filled = base.replaceAll("{tag}", tag).replaceAll("{version}", tag.replace(/^v/, ""))
  return `${filled.replace(/\/+$/, "")}/${name}`
}

/** Release JSON → the version and its arm64 tarball + checksum assets. Throws if any is missing. */
export const selectAssets = (rel: GhRelease, env: Env = {}): ResolvedRelease => {
  if (typeof rel?.tag_name !== "string") throw new Error("release has no tag_name")
  const version = rel.tag_name.replace(/^v/, "")
  if (!isSemver(version)) throw new Error(`release tag ${rel.tag_name} is not a version`)
  const assets = Array.isArray(rel.assets) ? rel.assets : []
  const find = (name: string) => {
    const a = assets.find((x) => x?.name === name && typeof x.browser_download_url === "string")
    if (!a) throw new Error(`release ${rel.tag_name} has no asset ${name}`)
    return { name, browser_download_url: assetUrl(env, rel.tag_name, name, a.browser_download_url) }
  }
  return {
    version,
    tag: rel.tag_name,
    notesUrl: rel.html_url ?? `https://github.com/${repoOf(env)}/releases/tag/${rel.tag_name}`,
    publishedAt: rel.published_at ?? null,
    tarball: find(tarballName(version)),
    sidecar: find(sidecarName(version)),
  }
}

/** Only a generic User-Agent: nothing that identifies the user or the machine. */
export const HEADERS = { "user-agent": "session-inbox", accept: "application/vnd.github+json" }

export const fetchRelease = async (
  env: Env,
  to: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedRelease> => {
  const url = `${releasesUrl(env)}/${to ? `tags/v${to.replace(/^v/, "")}` : "latest"}`
  const res = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) })
  if (res.status === 404) throw new Error(to ? `no release v${to}` : "no published release yet")
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  return selectAssets((await res.json()) as GhRelease, env)
}

export type CheckResult = {
  current: string
  latest: string | null
  available: boolean
  notesUrl: string | null
  publishedAt: string | null
  source: "release" | "source"
  error: string | null
}

export const checkResult = (
  current: string,
  source: "release" | "source",
  rel: ResolvedRelease | null,
  error: string | null,
): CheckResult => ({
  current,
  latest: rel?.version ?? null,
  available: rel !== null && error === null && compareSemver(rel.version, current) > 0,
  notesUrl: rel?.notesUrl ?? null,
  publishedAt: rel?.publishedAt ?? null,
  source,
  error,
})
