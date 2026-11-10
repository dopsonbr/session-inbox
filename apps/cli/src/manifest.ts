/**
 * A payload dir (H-020): what a release tarball unpacks to and what `install --from` reads.
 *   manifest.json  bin/inbox-hook  bin/inboxd  bin/session-inbox  ui/  [app/<Title>.app]
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { isSemver } from "./semver.ts"

export type Manifest = {
  name: "session-inbox"
  version: string
  build: string
  arch: "arm64"
  builtAt: string
}

export const PAYLOAD_BINARIES = ["inbox-hook", "inboxd", "session-inbox"] as const

export const validateManifest = (v: unknown): Manifest => {
  if (v === null || typeof v !== "object" || Array.isArray(v))
    throw new Error("manifest is not a JSON object")
  const m = v as Record<string, unknown>
  if (m.name !== "session-inbox") throw new Error(`manifest name is ${JSON.stringify(m.name)}`)
  if (!isSemver(m.version)) throw new Error(`manifest version ${JSON.stringify(m.version)}`)
  if (typeof m.build !== "string") throw new Error("manifest has no build")
  if (m.arch !== "arm64") throw new Error(`manifest arch is ${JSON.stringify(m.arch)}, not arm64`)
  if (typeof m.builtAt !== "string") throw new Error("manifest has no builtAt")
  return {
    name: "session-inbox",
    version: m.version,
    build: m.build,
    arch: "arm64",
    builtAt: m.builtAt,
  }
}

/** Read and check `<dir>/manifest.json` and that the binaries and UI are there. */
export const readPayload = (dir: string): Manifest => {
  const file = join(dir, "manifest.json")
  if (!existsSync(file)) throw new Error(`${dir} is not a Session Inbox payload (no manifest.json)`)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`)
  }
  const m = validateManifest(raw)
  for (const b of PAYLOAD_BINARIES)
    if (!existsSync(join(dir, "bin", b))) throw new Error(`payload is missing bin/${b}`)
  if (!existsSync(join(dir, "ui"))) throw new Error("payload is missing ui/")
  return m
}

/** The payload a binary at `<payload>/bin/session-inbox` belongs to, if it sits beside a manifest. */
export const payloadOfExecutable = (execPath: string): string | null => {
  const dir = dirname(dirname(execPath))
  return existsSync(join(dir, "manifest.json")) ? dir : null
}
