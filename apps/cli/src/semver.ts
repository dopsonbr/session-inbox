/** Just enough semver: MAJOR.MINOR.PATCH with an optional -prerelease (build metadata ignored). */
export type SemVer = { major: number; minor: number; patch: number; pre: string[] }

const RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export const parseSemver = (s: string): SemVer | null => {
  const m = RE.exec(s.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : [],
  }
}

export const isSemver = (s: unknown): s is string =>
  typeof s === "string" && parseSemver(s) !== null

const cmpId = (a: string, b: string): number => {
  const na = /^\d+$/.test(a)
  const nb = /^\d+$/.test(b)
  if (na && nb) return Math.sign(Number(a) - Number(b))
  if (na) return -1
  if (nb) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** -1, 0 or 1. Throws on anything that isn't semver. */
export const compareSemver = (a: string, b: string): number => {
  const x = parseSemver(a)
  const y = parseSemver(b)
  if (!x || !y) throw new Error(`not a semver version: ${!x ? a : b}`)
  for (const k of ["major", "minor", "patch"] as const)
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  // A prerelease sorts before its release; otherwise compare identifiers left to right.
  if (x.pre.length === 0 && y.pre.length === 0) return 0
  if (x.pre.length === 0) return 1
  if (y.pre.length === 0) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const c = cmpId(p, q)
    if (c !== 0) return c
  }
  return 0
}

export const isNewer = (candidate: string, current: string) => compareSemver(candidate, current) > 0
