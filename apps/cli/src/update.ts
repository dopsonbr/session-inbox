/**
 * `session-inbox update` (G-026, H-023): find the release, download the tarball and its
 * checksum into `<home>/updates/<version>/`, verify, unpack, and hand over to the NEW
 * version's own `install --from <payload> --yes` with the choices in install.json.
 *
 * The daemon starts this detached and is itself restarted by it (the new install reloads
 * launchd), so nothing here may depend on the parent: progress goes to update-state.json
 * and update.log, stdout writes are best effort, SIGHUP/SIGPIPE are ignored.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"
import { CHANNELS, type Channel } from "@session-inbox/contracts/paths"
import { VERSION } from "@session-inbox/contracts/version"
import { appPath, defaultSettingsPath } from "./common.ts"
import { verifySha256 } from "./fsx.ts"
import { readPayload } from "./manifest.ts"
import {
  type CheckResult,
  checkResult,
  fetchRelease,
  HEADERS,
  payloadDirName,
  type ResolvedRelease,
} from "./releases.ts"
import { compareSemver } from "./semver.ts"
import {
  type InstallRecord,
  mirrorEnv,
  readInstallRecord,
  updateLogPath,
  updatesDir,
  writeUpdateState,
} from "./state.ts"
import { holdsNow } from "./status.ts"

type Env = Record<string, string | undefined>

export type UpdateContext = {
  home: string
  channel: Channel
  env: Env
  fetchImpl?: typeof fetch
  /** Human output (stdout); every line also goes to update.log while applying. */
  say: (line: string) => void
}

export const BETA_REFUSAL =
  "the beta channel never updates from releases; reinstall it from your checkout " +
  "with `bun scripts/install.ts --channel beta --yes`"

/**
 * The release source for this home: the environment wins, else what install.json recorded
 * (a mirror install), else GitHub. The daemon's plist carries the same variables.
 */
export const sourceEnv = (env: Env, rec: InstallRecord | null): Env => {
  const keys = ["SESSION_INBOX_RELEASES_URL", "SESSION_INBOX_ASSET_URL", "SESSION_INBOX_REPO"]
  if (keys.some((k) => env[k])) return env
  return rec ? { ...env, ...mirrorEnv(rec) } : env
}

const currentOf = (rec: InstallRecord | null) => rec?.version ?? VERSION
const sourceOf = (rec: InstallRecord | null) => rec?.source ?? "source"

export const check = async (ctx: UpdateContext, to: string | null): Promise<CheckResult> => {
  const rec = readInstallRecord(ctx.home)
  const current = currentOf(rec)
  const source = sourceOf(rec)
  if (ctx.channel === "beta" || rec?.channel === "beta")
    return checkResult(current, source, null, BETA_REFUSAL)
  try {
    const env = sourceEnv(ctx.env, rec)
    return checkResult(current, source, await fetchRelease(env, to, ctx.fetchImpl), null)
  } catch (e) {
    return checkResult(current, source, null, (e as Error).message)
  }
}

export const describeCheck = (r: CheckResult): string => {
  if (r.error) return `couldn't check for updates: ${r.error}`
  if (r.available)
    return `Session Inbox ${r.latest} is available (you have ${r.current}); notes: ${r.notesUrl}\nrun \`session-inbox update --yes\` to install it`
  return `Session Inbox ${r.current} is up to date${r.latest ? ` (latest release ${r.latest})` : ""}`
}

const download = async (url: string, file: string, fetchImpl: typeof fetch) => {
  const res = await fetchImpl(url, {
    headers: { "user-agent": HEADERS["user-agent"] },
    redirect: "follow",
    signal: AbortSignal.timeout(10 * 60_000),
  })
  if (!res.ok) throw new Error(`download ${url} answered ${res.status}`)
  await Bun.write(file, res)
}

/** One updater per home at a time: `<home>/updates/.lock` holds the pid. */
const takeLock = (home: string): (() => void) => {
  const dir = updatesDir(home)
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, ".lock")
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(lock, "wx")
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return () => rmSync(lock, { force: true })
    } catch {
      const pid = Number(readFileSync(lock, "utf8").trim())
      let alive = false
      try {
        alive = pid > 0 && pid !== process.pid && process.kill(pid, 0)
      } catch {}
      if (alive) throw new Error(`another update is running (pid ${pid})`)
      rmSync(lock, { force: true }) // stale
    }
  }
  throw new Error("couldn't take the update lock")
}

/** The new payload's installer, with the options this home was installed with. */
export const installArgs = (
  payload: string,
  home: string,
  channel: Channel,
  rec: InstallRecord | null,
  holds: boolean,
): string[] => {
  const app = rec ? rec.app : existsSync(appPath(CHANNELS[channel].title))
  return [
    join(payload, "bin", "session-inbox"),
    "install",
    "--from",
    payload,
    "--yes",
    "--updating",
    "--home",
    home,
    "--channel",
    channel,
    "--settings",
    rec?.settingsPath || defaultSettingsPath(),
    ...(rec && !rec.launchd ? ["--no-launchd"] : []),
    ...(rec && !rec.hooks ? ["--no-hooks"] : []),
    ...(app ? [] : ["--no-app"]),
    ...(holds ? ["--holds"] : []),
    ...(rec?.label ? ["--label", rec.label] : []),
    ...(rec?.releasesUrl ? ["--releases-url", rec.releasesUrl] : []),
    ...(rec?.assetUrl ? ["--asset-url", rec.assetUrl] : []),
    ...(rec?.repo ? ["--repo", rec.repo] : []),
    ...Object.entries(rec?.daemonEnv ?? {}).flatMap(([k, v]) => ["--daemon-env", `${k}=${v}`]),
  ]
}

/**
 * Download, verify and install. Returns the exit code: 0 done or already up to date,
 * 1 failed (update-state.json says why), 2 refused (beta, no --yes).
 */
export const apply = async (
  ctx: UpdateContext,
  opts: { to: string | null; yes: boolean },
): Promise<number> => {
  const { home } = ctx
  const fetchImpl = ctx.fetchImpl ?? fetch
  const rec = readInstallRecord(home)
  const env = sourceEnv(ctx.env, rec)
  const channel = rec?.channel ?? ctx.channel
  if (ctx.channel === "beta" || channel === "beta") {
    ctx.say(BETA_REFUSAL)
    return 2
  }

  let rel: ResolvedRelease
  try {
    rel = await fetchRelease(env, opts.to, fetchImpl)
  } catch (e) {
    ctx.say(`couldn't find the release: ${(e as Error).message}`)
    return 1
  }
  const current = currentOf(rec)
  if (!opts.to && compareSemver(rel.version, current) <= 0) {
    ctx.say(`Session Inbox ${current} is up to date`)
    return 0
  }
  if (!opts.yes) {
    ctx.say(`DRY RUN: would update ${home} from ${current} to ${rel.version} (${rel.notesUrl})`)
    if (sourceOf(rec) === "source")
      ctx.say(
        "note: this home was installed from source; updating replaces it with the release build",
      )
    ctx.say("pass --yes to apply")
    return 0
  }

  const logFile = updateLogPath(home)
  mkdirSync(home, { recursive: true })
  const log = (line: string) => {
    try {
      const fd = openSync(logFile, "a")
      writeSync(fd, `${new Date().toISOString()} ${line}\n`)
      closeSync(fd)
    } catch {}
    ctx.say(line)
  }
  const version = rel.version
  const state = (s: Parameters<typeof writeUpdateState>[2], error: string | null = null) =>
    writeUpdateState(home, version, s, error)

  let release: () => void
  try {
    release = takeLock(home)
  } catch (e) {
    log((e as Error).message)
    return 1
  }
  const dir = join(updatesDir(home), version)
  try {
    log(`updating ${home} from ${current} to ${version}`)
    // Leftovers from earlier attempts.
    for (const d of readdirSync(updatesDir(home)))
      if (d !== ".lock") rmSync(join(updatesDir(home), d), { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })

    state("downloading")
    const tarball = join(dir, rel.tarball.name)
    const sidecar = join(dir, rel.sidecar.name)
    await download(rel.sidecar.browser_download_url, sidecar, fetchImpl)
    await download(rel.tarball.browser_download_url, tarball, fetchImpl)
    log(`downloaded ${rel.tarball.browser_download_url}`)

    state("verifying")
    await verifySha256(tarball, readFileSync(sidecar, "utf8"))
    log("checksum ok")
    const x = Bun.spawnSync(["/usr/bin/tar", "-xzf", tarball, "-C", dir], { stderr: "pipe" })
    if (x.exitCode !== 0) throw new Error(`tar failed: ${x.stderr.toString().trim()}`)
    const payload = join(dir, payloadDirName(version))
    const manifest = readPayload(payload)
    if (manifest.version !== version)
      throw new Error(`payload says ${manifest.version}, release says ${version}`)

    state("installing")
    const args = installArgs(payload, home, channel, rec, holdsNow(channel, home, rec?.label))
    log(`running ${args.join(" ")}`)
    const out = openSync(logFile, "a")
    const { SESSION_INBOX_UPDATE_DETACHED: _, ...childEnv } = env
    const p = Bun.spawn(args, { stdin: "ignore", stdout: out, stderr: out, env: childEnv })
    const code = await p.exited
    closeSync(out)
    if (code !== 0) throw new Error(`the ${version} installer exited ${code}; see ${logFile}`)

    state("done")
    log(`updated to ${version}`)
    rmSync(dir, { recursive: true, force: true })
    return 0
  } catch (e) {
    const msg = (e as Error).message
    state("failed", msg)
    log(`update failed: ${msg}`)
    return 1
  } finally {
    release()
  }
}
