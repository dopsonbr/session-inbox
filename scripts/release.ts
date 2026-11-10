/**
 * Build a release (G-024, H-025): payload dir, tarball and checksum.
 *   bun scripts/release.ts [--skip-app] [--version <v>] [--out <dir>] [--publish]
 * → <out>/session-inbox-<v>/                       the payload (H-020)
 *   <out>/session-inbox-<v>-macos-arm64.tar.gz      top-level dir session-inbox-<v>/
 *   <out>/session-inbox-<v>-macos-arm64.tar.gz.sha256   lowercase hex digest + newline
 * --skip-app leaves out the menu-bar app (fast; for tests). --version overrides VERSION
 * (tests build a "newer" fake release). --publish uploads with `gh release create`.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { sha256File } from "../apps/cli/src/fsx.ts"
import { payloadDirName, sidecarName, tarballName } from "../apps/cli/src/releases.ts"
import { isSemver } from "../apps/cli/src/semver.ts"
import { build, buildStamp, fileVersion } from "./build.ts"

const root = join(import.meta.dir, "..")

export type PayloadOptions = {
  dir: string
  version: string
  stamp?: string
  /** A built .app to include as app/<its name>. */
  appBundle?: string | null
  verbose?: boolean
}

/** Build hook, daemon, CLI and UI into `dir` and write its manifest.json. */
export const buildPayload = async (o: PayloadOptions): Promise<string> => {
  if (!isSemver(o.version)) throw new Error(`not a version: ${o.version}`)
  const stamp = o.stamp ?? buildStamp()
  rmSync(o.dir, { recursive: true, force: true })
  mkdirSync(o.dir, { recursive: true })
  await build({
    binDir: join(o.dir, "bin"),
    uiDir: join(o.dir, "ui"),
    version: o.version,
    stamp,
    ...(o.verbose === undefined ? {} : { verbose: o.verbose }),
  })
  if (o.appBundle) {
    const name = o.appBundle.split("/").at(-1) as string
    mkdirSync(join(o.dir, "app"), { recursive: true })
    cpSync(o.appBundle, join(o.dir, "app", name), { recursive: true, verbatimSymlinks: true })
  }
  const manifest = {
    name: "session-inbox",
    version: o.version,
    build: stamp,
    arch: "arm64",
    builtAt: new Date().toISOString(),
  }
  writeFileSync(join(o.dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  return o.dir
}

/** `bun scripts/build-shell.ts --channel <c>`; its last stdout line is the .app path. */
export const buildShell = (channel: "ga" | "beta"): string => {
  const b = Bun.spawnSync(["bun", join(root, "scripts/build-shell.ts"), "--channel", channel], {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
  })
  const built = b.stdout.toString().trim().split("\n").at(-1) ?? ""
  if (b.exitCode !== 0 || !built.endsWith(".app") || !existsSync(built))
    throw new Error(`menu-bar app build failed (${built || `exit ${b.exitCode}`})`)
  return built
}

export type ReleaseResult = { payload: string; tarball: string; sidecar: string; version: string }

export const buildRelease = async (o: {
  out: string
  version: string
  skipApp: boolean
  verbose?: boolean
}): Promise<ReleaseResult> => {
  mkdirSync(o.out, { recursive: true })
  const appBundle = o.skipApp ? null : buildShell("ga")
  const payload = await buildPayload({
    dir: join(o.out, payloadDirName(o.version)),
    version: o.version,
    appBundle,
    ...(o.verbose === undefined ? {} : { verbose: o.verbose }),
  })
  const tarball = join(o.out, tarballName(o.version))
  const sidecar = join(o.out, sidecarName(o.version))
  rmSync(tarball, { force: true })
  // COPYFILE_DISABLE: no AppleDouble ._ files for extended attributes.
  const t = Bun.spawnSync(
    ["/usr/bin/tar", "-czf", tarball, "-C", o.out, payloadDirName(o.version)],
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, stderr: "inherit" },
  )
  if (t.exitCode !== 0) throw new Error("tar failed")
  writeFileSync(sidecar, `${await sha256File(tarball)}\n`)
  return { payload, tarball, sidecar, version: o.version }
}

const sh = (...cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd: root, stdout: "pipe", stderr: "pipe" })
  return { code: p.exitCode, out: p.stdout.toString().trim() }
}

const publish = (r: ReleaseResult) => {
  const tag = `v${r.version}`
  if (sh("git", "status", "--porcelain").out !== "")
    throw new Error("the working tree is dirty; commit first")
  if (sh("git", "rev-parse", "-q", "--verify", `refs/tags/${tag}`).code === 0)
    throw new Error(`tag ${tag} already exists`)
  if (sh("git", "ls-remote", "--exit-code", "--tags", "origin", tag).code === 0)
    throw new Error(`tag ${tag} already exists on origin`)
  const p = Bun.spawnSync(
    [
      "gh",
      "release",
      "create",
      tag,
      r.tarball,
      r.sidecar,
      join(root, "install.sh"),
      "--title",
      `Session Inbox ${tag}`,
      "--generate-notes",
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  )
  if (p.exitCode !== 0) throw new Error("gh release create failed")
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      "skip-app": { type: "boolean", default: false },
      version: { type: "string" },
      out: { type: "string" },
      publish: { type: "boolean", default: false },
    },
  })
  const r = await buildRelease({
    out: values.out ?? join(root, "dist", "release"),
    version: values.version ?? fileVersion(),
    skipApp: values["skip-app"] === true,
  })
  console.log(`payload  ${r.payload}`)
  console.log(`tarball  ${r.tarball}`)
  console.log(`sha256   ${r.sidecar}`)
  if (values.publish) publish(r)
}
