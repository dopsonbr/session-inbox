/**
 * Check a built release the way a user gets it: verify the tarball's checksum, unpack it,
 * install it with `--no-launchd --no-app` into a temp HOME and ask every binary its version.
 *   bun scripts/verify-release.ts [--out dist/release] [--version <v>] [--require-app]
 * Touches nothing outside its /tmp/si-verify-* dir. CI runs it after `scripts/release.ts`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { verifySha256 } from "../apps/cli/src/fsx.ts"
import { payloadDirName, sidecarName, tarballName } from "../apps/cli/src/releases.ts"
import { fileVersion } from "./build.ts"

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    version: { type: "string" },
    "require-app": { type: "boolean", default: false },
  },
})
const root = join(import.meta.dir, "..")
const out = values.out ?? join(root, "dist", "release")
const version = values.version ?? fileVersion()

const tmp = mkdtempSync("/tmp/si-verify-")
const fail = (msg: string): never => {
  throw new Error(msg)
}
const ok = (msg: string) => console.log(`ok   ${msg}`)

const run = (cmd: string[], env: Record<string, string>) => {
  const p = Bun.spawnSync(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() }
}

try {
  const tarball = join(out, tarballName(version))
  const sidecar = join(out, sidecarName(version))
  if (!existsSync(tarball) || !existsSync(sidecar)) fail(`no ${tarball} (+ .sha256)`)
  await verifySha256(tarball, readFileSync(sidecar, "utf8"))
  ok(`checksum of ${tarballName(version)}`)

  const x = run(["/usr/bin/tar", "-xzf", tarball, "-C", tmp], { PATH: "/usr/bin:/bin" })
  if (x.code !== 0) fail(`tar: ${x.stderr}`)
  const payload = join(tmp, payloadDirName(version))
  const manifest = JSON.parse(readFileSync(join(payload, "manifest.json"), "utf8"))
  if (manifest.version !== version) fail(`manifest says ${manifest.version}`)
  ok(`manifest ${manifest.version} (${manifest.build})`)
  const hasApp = existsSync(join(payload, "app", "Session Inbox.app"))
  if (values["require-app"] && !hasApp) fail("the payload has no app/Session Inbox.app")
  ok(hasApp ? "payload includes Session Inbox.app" : "payload has no app (--skip-app build)")

  const user = join(tmp, "user")
  const home = join(tmp, "h")
  const settings = join(tmp, "settings.json")
  mkdirSync(user)
  writeFileSync(settings, "{}\n")
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: user }
  const inst = run(
    [
      join(payload, "bin", "session-inbox"),
      "install",
      "--from",
      payload,
      "--yes",
      "--no-launchd",
      "--no-app",
      "--home",
      home,
      "--settings",
      settings,
    ],
    env,
  )
  if (inst.code !== 0) fail(`install exited ${inst.code}: ${inst.stderr || inst.stdout}`)
  ok("installs with --no-launchd --no-app into a temp HOME")
  const rec = JSON.parse(readFileSync(join(home, "install.json"), "utf8"))
  if (rec.version !== version || rec.source !== "release")
    fail(`install.json: ${JSON.stringify(rec)}`)
  const hook = run([join(home, "bin", "inbox-hook"), "--version"], env).stdout.trim()
  const cli = run([join(home, "bin", "session-inbox"), "--version"], env).stdout.trim()
  if (hook !== version) fail(`inbox-hook --version says ${hook}`)
  if (!cli.startsWith(`session-inbox ${version} `)) fail(`session-inbox --version says ${cli}`)
  if (!readFileSync(settings, "utf8").includes(`${home}/bin/inbox-hook`)) fail("no hooks merged")
  ok(`installed binaries report ${version}; hooks merged`)
  console.log("verify-release: PASS")
} catch (e) {
  console.log(`FAIL ${(e as Error).message}`)
  console.log("verify-release: FAIL")
  process.exitCode = 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
