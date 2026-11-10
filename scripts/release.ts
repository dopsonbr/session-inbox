/**
 * Build a release (G-024, H-025): payload dir, tarball and checksum.
 *   bun scripts/release.ts [--skip-app] [--version <v>] [--out <dir>] [--publish]
 * → <out>/session-inbox-<v>/                       the payload (H-020)
 *   <out>/session-inbox-<v>-macos-arm64.tar.gz      top-level dir session-inbox-<v>/
 *   <out>/session-inbox-<v>-macos-arm64.tar.gz.sha256   lowercase hex digest + newline
 * --skip-app leaves out the menu-bar app (fast; for tests). --version overrides VERSION
 * (tests build a "newer" fake release). --publish first checks the checkout matches origin
 * (H-042), then uploads with `gh release create --target <that commit>`.
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

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

/**
 * Checked BEFORE building, so a release is built from, and tagged at, exactly what origin has:
 * a clean tree, HEAD equal to origin's default branch after a fetch, and a tag that exists
 * neither here nor on origin. Returns the commit to tag. Throws with what to do otherwise.
 */
export const publishPreconditions = (cwd: string, version: string): { sha: string } => {
  const tag = `v${version}`
  if (git(cwd, "status", "--porcelain").out !== "")
    throw new Error("the working tree is dirty; commit or stash first")
  const f = git(cwd, "fetch", "--quiet", "--tags", "origin")
  if (f.code !== 0) throw new Error(`git fetch origin failed: ${f.err}`)
  const head = git(cwd, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
  const branch = head.code === 0 && head.out !== "" ? head.out : "origin/main"
  const sha = git(cwd, "rev-parse", "HEAD").out
  const remote = git(cwd, "rev-parse", "--verify", "--quiet", `${branch}^{commit}`)
  if (remote.code !== 0) throw new Error(`can't find ${branch}; is origin set up?`)
  if (sha !== remote.out)
    throw new Error(
      `HEAD (${sha.slice(0, 9)}) is not ${branch} (${remote.out.slice(0, 9)}); ` +
        `push or pull first, so the release is built from and tagged at what origin has`,
    )
  if (git(cwd, "rev-parse", "-q", "--verify", `refs/tags/${tag}`).code === 0)
    throw new Error(`tag ${tag} already exists`)
  if (git(cwd, "ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`).code === 0)
    throw new Error(`tag ${tag} already exists on origin`)
  return { sha }
}

const publish = (r: ReleaseResult, sha: string) => {
  const tag = `v${r.version}`
  if (git(root, "rev-parse", "HEAD").out !== sha || git(root, "status", "--porcelain").out !== "")
    throw new Error("the checkout changed during the build; not publishing")
  const p = Bun.spawnSync(
    [
      "gh",
      "release",
      "create",
      tag,
      r.tarball,
      r.sidecar,
      join(root, "install.sh"),
      "--target",
      sha,
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
  const version = values.version ?? fileVersion()
  const target = values.publish ? publishPreconditions(root, version) : null
  const r = await buildRelease({
    out: values.out ?? join(root, "dist", "release"),
    version,
    skipApp: values["skip-app"] === true,
  })
  console.log(`payload  ${r.payload}`)
  console.log(`tarball  ${r.tarball}`)
  console.log(`sha256   ${r.sidecar}`)
  if (target) publish(r, target.sha)
}
