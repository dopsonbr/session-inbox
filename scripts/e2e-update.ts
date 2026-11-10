/**
 * End-to-end update under the REAL launchd, with a local fake releases server instead of
 * GitHub. One command, no arguments; exits non-zero on the first failed assertion.
 *
 *   bun scripts/e2e-update.ts
 *
 * Isolation: home /tmp/si-e2e-XXXX/h, its own settings file, launchd label
 * com.sessioninbox.inboxd.e2e (plist in ~/Library/LaunchAgents, removed at the end), no app,
 * an empty CLAUDE_CONFIG_DIR for the daemon. It never touches ~/.claude/settings.json, the GA
 * or beta jobs, ~/Applications or ~/.local/bin, and checks that at the end.
 */
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { startFakeReleases } from "./fake-releases.ts"
import { buildRelease } from "./release.ts"

const LABEL = "com.sessioninbox.inboxd.e2e"
const uid = process.getuid?.() ?? 501
const domain = `gui/${uid}`
const realHome = homedir()
const plist = join(realHome, "Library", "LaunchAgents", `${LABEL}.plist`)

const root = mkdtempSync("/tmp/si-e2e-")
const home = join(root, "h")
const settings = join(root, "settings.json")
const claudeDir = join(root, "claude")
const project = join(root, "proj")
mkdirSync(claudeDir)
mkdirSync(project)
await Bun.write(settings, `${JSON.stringify({ model: "opus" }, null, 2)}\n`)

const started = performance.now()
const elapsed = () => `${((performance.now() - started) / 1000).toFixed(1)}s`
const say = (s: string) => console.log(s)
const pass = (msg: string) => say(`PASS ${msg}`)
class Failed extends Error {}
const check = (cond: unknown, msg: string, extra = "") => {
  if (!cond) throw new Failed(`${msg}${extra ? ` — ${extra}` : ""}`)
  pass(msg)
}

// ---------- safety: the real installs must come out untouched ----------
const realSettings = join(realHome, ".claude", "settings.json")
const realPlists = ["com.sessioninbox.inboxd", "com.sessioninbox.inboxd.beta"].map((l) =>
  join(realHome, "Library", "LaunchAgents", `${l}.plist`),
)
const fingerprint = () => ({
  settings: existsSync(realSettings) ? readFileSync(realSettings, "utf8") : null,
  plists: realPlists.map((p) => (existsSync(p) ? statSync(p).mtimeMs : null)),
})
const before = fingerprint()
const startedAt = new Date().toISOString()

// ---------- helpers ----------
const baseEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: realHome }
const run = async (cmd: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) => {
  const p = Bun.spawn(cmd, {
    cwd: root,
    env: { ...baseEnv, ...opts.env },
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, stdout, stderr }
}
const launchctl = (...args: string[]) =>
  Bun.spawnSync(["/bin/launchctl", ...args], { stdout: "pipe", stderr: "pipe" })
const job = (): { loaded: boolean; pid: number | null } => {
  const p = launchctl("print", `${domain}/${LABEL}`)
  if (p.exitCode !== 0) return { loaded: false, pid: null }
  const pid = /\bpid = (\d+)/.exec(p.stdout.toString())?.[1]
  return { loaded: true, pid: pid ? Number(pid) : null }
}

const waitFor = async <T>(
  fn: () => T | null | undefined | Promise<T | null | undefined>,
  what: string,
  ms: number,
  every = 200,
): Promise<T> => {
  const end = Date.now() + ms
  let lastErr = ""
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v !== null && v !== undefined && v !== false) return v
    } catch (e) {
      lastErr = (e as Error).message
    }
    await Bun.sleep(every)
  }
  throw new Failed(
    `timed out after ${ms / 1000} s waiting for ${what}${lastErr ? ` (${lastErr})` : ""}`,
  )
}

type Conn = { httpPort: number; token: string; pid: number; socketPath: string }
const conn = (): Conn | null => {
  try {
    return JSON.parse(readFileSync(join(home, "connection.json"), "utf8")) as Conn
  } catch {
    return null
  }
}
const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const c = conn()
  if (!c) throw new Error("no connection.json")
  const res = await fetch(`http://127.0.0.1:${c.httpPort}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(5000),
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as never }
}
type UpdateStatus = {
  state: string
  current: string
  latest: string | null
  available: boolean
  error: string | null
  source: string | null
  target: string | null
  justUpdatedFrom: string | null
}
const updateStatus = async () => (await api("/v1/update")).body as UpdateStatus
const health = async () => (await api("/v1/health")).body as { version: string; pid: number }
const updateState = (): { version: string; state: string; error: string | null } | null => {
  try {
    return JSON.parse(readFileSync(join(home, "update-state.json"), "utf8"))
  } catch {
    return null
  }
}

const sid = "e2e00000-0000-4000-8000-00000000e2e0"
const hookPayload = (event: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: sid,
    cwd: project,
    hook_event_name: event,
    permission_mode: "default",
    ...extra,
  })
/** The real installed hook binary; it finds its daemon from its own path. */
const hook = (event: string, extra: Record<string, unknown> = {}) =>
  run([join(home, "bin", "inbox-hook"), event], { stdin: hookPayload(event, extra) })

// ---------- cleanup, always ----------
const fake = startFakeReleases()
let cleaned = false
const cleanup = () => {
  if (cleaned) return
  cleaned = true
  launchctl("bootout", `${domain}/${LABEL}`)
  rmSync(plist, { force: true })
  // A detached updater that outlived a failure would keep writing into the home.
  Bun.spawnSync(["/usr/bin/pkill", "-f", `${home}/`], { stderr: "ignore" })
  fake.stop()
  rmSync(root, { recursive: true, force: true })
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(sig, () => {
    say(`FAIL interrupted (${sig})`)
    cleanup()
    process.exit(130)
  })

// ---------- the steps ----------
const main = async () => {
  if (job().loaded) {
    say(`note: ${LABEL} was left loaded by an earlier run; removing it`)
    launchctl("bootout", `${domain}/${LABEL}`)
    await waitFor(() => !job().loaded, "the old e2e job to unload", 10_000)
  }

  say(`e2e-update: ${root}`)
  // One after the other: both build the UI in the same apps/desktop/dist.
  const r1 = await buildRelease({
    out: join(root, "r1"),
    version: "0.0.1",
    skipApp: true,
    verbose: false,
  })
  const r2 = await buildRelease({
    out: join(root, "r2"),
    version: "0.0.2",
    skipApp: true,
    verbose: false,
  })
  check(existsSync(r1.tarball) && existsSync(r2.tarball), `built 0.0.1 and 0.0.2 (${elapsed()})`)

  fake.add(r1, { latest: true })
  fake.add(r2)

  // 1. install 0.0.1 under the real launchd, from the mirror.
  const inst = await run([
    join(r1.payload, "bin", "session-inbox"),
    "install",
    "--from",
    r1.payload,
    "--yes",
    "--home",
    home,
    "--settings",
    settings,
    "--label",
    LABEL,
    "--no-app",
    "--releases-url",
    fake.releasesUrl,
    "--asset-url",
    fake.assetUrl,
    "--daemon-env",
    `CLAUDE_CONFIG_DIR=${claudeDir}`,
    "--daemon-env",
    "SESSION_INBOX_CLAUDE=/usr/bin/false",
  ])
  check(inst.code === 0, "install 0.0.1 exits 0", inst.stderr || inst.stdout)
  const plistText = readFileSync(plist, "utf8")
  check(
    plistText.includes(fake.releasesUrl) && plistText.includes(claudeDir),
    "the plist carries the mirror and the daemon env",
  )
  const pid1 = await waitFor(() => job().pid, "launchd to run the job", 15_000)
  pass(`launchd runs ${LABEL} (pid ${pid1})`)
  await waitFor(conn, "connection.json", 15_000)
  pass("connection.json appeared")
  const h1 = await waitFor(health, "health", 15_000)
  check(h1.version === "0.0.1", "GET /v1/health reports 0.0.1", JSON.stringify(h1))
  const c1 = (await api("/v1/update/check", { body: {} })).body as UpdateStatus
  check(
    c1.state === "idle" && c1.source === "release" && c1.available === false,
    "GET /v1/update is supported, idle, source release",
    JSON.stringify(c1),
  )
  const settingsAfterInstall = readFileSync(settings, "utf8")
  check(settingsAfterInstall.includes(`${home}/bin/inbox-hook`), "hooks point at the e2e home")

  // 2. a live hold through the real inbox-hook binary.
  for (const e of [
    ["SessionStart", { source: "startup" }],
    ["UserPromptSubmit", { prompt: "e2e update" }],
  ] as const) {
    const r = await hook(e[0], e[1])
    if (r.code !== 0) throw new Failed(`${e[0]} hook exited ${r.code}`)
  }
  const held = hook("PreToolUse", {
    tool_name: "Write",
    tool_use_id: "e2e-w1",
    tool_input: { file_path: join(project, "x.txt"), content: "hi" },
  })
  type Item = { id: string; kind: string; state: string; live: boolean }
  const item = await waitFor(
    async () =>
      ((await api("/v1/snapshot")).body as { items: Item[] }).items.find(
        (i) => i.kind === "permission" && i.state === "open" && i.live,
      ),
    "a live permission hold",
    10_000,
  )
  pass(`the Write is held (item ${item.id})`)

  fake.setLatest("0.0.2")
  const c2 = (await api("/v1/update/check", { body: {} })).body as UpdateStatus
  check(c2.state === "available" && c2.latest === "0.0.2", "check finds 0.0.2 available")
  await Bun.sleep(5000)
  const s2 = await updateStatus()
  check(
    s2.state === "available" && updateState() === null && job().pid === pid1,
    "no auto-apply while the hold is live (5 s)",
    JSON.stringify(s2),
  )

  // 3. deny; the daemon then auto-applies once quiet (30 s after the last hook event).
  const d = await api(`/v1/items/${item.id}/decision`, {
    body: { idempotencyKey: "e2e-deny-1", decision: "deny" },
  })
  check(d.status === 200, "deny accepted over HTTP")
  const hr = await held
  const out = JSON.parse(hr.stdout.trim() || "{}") as {
    hookSpecificOutput?: { permissionDecision?: string }
  }
  check(
    hr.code === 0 && out.hookSpecificOutput?.permissionDecision === "deny",
    "inbox-hook printed the deny and exited 0",
    hr.stdout,
  )

  const t0 = Date.now()
  const startedUpdating = await waitFor(
    async () => {
      if (updateState()) return true
      const s = await updateStatus().catch(() => null)
      return s?.state === "updating" ? true : null
    },
    "the daemon to start the update by itself",
    90_000,
    250,
  )
  check(
    startedUpdating,
    `the daemon auto-applied after ${((Date.now() - t0) / 1000).toFixed(0)} s of quiet`,
  )

  // Fail open during the swap: PostToolUse hooks fired in a loop until the new daemon answers.
  const hookRuns: { code: number; stdout: string }[] = []
  const seen: string[] = []
  let swapping = true
  const loop = (async () => {
    let n = 0
    while (swapping) {
      const r = await hook("PostToolUse", {
        tool_name: "Read",
        tool_use_id: `e2e-r${n++}`,
        tool_input: { file_path: join(project, "x.txt") },
        tool_response: {},
      })
      hookRuns.push(r)
      await Bun.sleep(100)
    }
  })()
  try {
    await waitFor(
      () => {
        const s = updateState()
        if (s && seen.at(-1) !== s.state) seen.push(s.state)
        if (s?.state === "failed") throw new Failed(`update failed: ${s.error}`)
        return s?.state === "done" && s.version === "0.0.2"
      },
      "update-state.json to say done for 0.0.2",
      120_000,
      50,
    )
    const order = ["downloading", "verifying", "installing", "done"]
    const idx = seen.map((s) => order.indexOf(s))
    check(
      idx.every((v, i) => v >= 0 && (i === 0 || v > (idx[i - 1] as number))),
      `update-state.json went ${seen.join(" → ")}`,
    )
    const pid2 = await waitFor(
      () => {
        const p = job().pid
        return p && p !== pid1 ? p : null
      },
      "launchd to run the job with a new pid",
      30_000,
    )
    pass(`launchd runs the job again with a new pid (${pid1} → ${pid2})`)
    const h2 = await waitFor(
      async () => {
        const h = await health()
        return h.version === "0.0.2" ? h : null
      },
      "the new daemon's health",
      30_000,
    )
    check(
      h2.version === "0.0.2" && conn()?.pid === h2.pid,
      `GET /v1/health reports 0.0.2 on port ${conn()?.httpPort} from connection.json`,
    )
  } finally {
    swapping = false
    await loop
  }
  const bad = hookRuns.filter((r) => r.code !== 0 || r.stdout !== "")
  check(
    hookRuns.length > 0 && bad.length === 0,
    `${hookRuns.length} PostToolUse hooks during the swap all exited 0 with no output`,
    JSON.stringify(bad.slice(0, 3)),
  )

  const hv = await run([join(home, "bin", "inbox-hook"), "--version"])
  const cv = await run([join(home, "bin", "session-inbox"), "--version"])
  check(
    hv.stdout.trim() === "0.0.2" && cv.stdout.includes("0.0.2"),
    "inbox-hook and session-inbox --version report 0.0.2",
    `${hv.stdout.trim()} / ${cv.stdout.trim()}`,
  )
  check(readFileSync(settings, "utf8") === settingsAfterInstall, "the hook commands are unchanged")
  const rec = JSON.parse(readFileSync(join(home, "install.json"), "utf8"))
  check(
    rec.version === "0.0.2" &&
      rec.label === LABEL &&
      rec.releasesUrl === fake.releasesUrl &&
      rec.assetUrl === fake.assetUrl,
    "install.json keeps the label and the mirror",
  )
  const s3 = await updateStatus()
  check(s3.justUpdatedFrom === "0.0.1", "GET /v1/update reports justUpdatedFrom 0.0.1")
  const db = new Database(join(home, "inbox.db"), { readonly: true })
  const updatedEvents = (
    db.query("SELECT count(*) AS n FROM events WHERE hook = 'daemon:updated'").get() as {
      n: number
    }
  ).n
  db.close()
  check(updatedEvents === 1, "daemon:updated was announced once", `got ${updatedEvents}`)
  const log = readFileSync(join(home, "update.log"), "utf8")
  const errors = log.split("\n").filter((l) => /\b(error|failed|exception)\b/i.test(l))
  check(errors.length === 0, "update.log has no error lines", errors.slice(0, 3).join(" | "))
  check(!existsSync(join(home, "updates", ".lock")), "no update lock left behind")

  const seqBefore = ((await api("/v1/snapshot")).body as { seq: number }).seq
  const after = await hook("UserPromptSubmit", { prompt: "after the update" })
  const seqAfter = await waitFor(
    async () => {
      const s = ((await api("/v1/snapshot")).body as { seq: number }).seq
      return s > seqBefore ? s : null
    },
    "a hook event after the update to be ingested",
    5000,
  )
  check(after.code === 0 && seqAfter > seqBefore, "a hook event after the update is ingested")

  // 4. a corrupted 0.0.3: manual apply fails on the checksum, 0.0.2 keeps running.
  const pid2 = job().pid
  fake.addBroken("0.0.3", { latest: true })
  const c3 = (await api("/v1/update/check", { body: {} })).body as UpdateStatus
  check(c3.state === "available" && c3.latest === "0.0.3", "check finds the broken 0.0.3")
  const a3 = await api("/v1/update/apply", { body: {} })
  // A hook just ran, so auto-apply can't have raced us; 409 here would mean it did.
  check(a3.status === 200, "manual POST /v1/update/apply accepted", JSON.stringify(a3.body))
  const s4 = await waitFor(
    async () => {
      const s = await updateStatus()
      return s.state === "failed" ? s : null
    },
    "the update to fail",
    60_000,
  )
  check(
    /checksum/i.test(s4.error ?? ""),
    "status ends failed with a checksum message",
    s4.error ?? "",
  )
  const h4 = await health()
  check(h4.version === "0.0.2" && job().pid === pid2, "the daemon is still 0.0.2 and still running")
  check(!existsSync(join(home, "updates", ".lock")), "no update lock left after the failure")

  // 5. uninstall with --purge and the label.
  const un = await run([
    join(home, "bin", "session-inbox"),
    "uninstall",
    "--yes",
    "--purge",
    "--home",
    home,
    "--label",
    LABEL,
    "--settings",
    settings,
  ])
  check(un.code === 0, "uninstall --purge exits 0", un.stderr)
  await waitFor(() => !job().loaded, "the job to unload", 10_000)
  pass("the launchd job is gone")
  check(!existsSync(plist), "the plist is removed")
  check(!existsSync(home), "the home is deleted")
  check(
    !readFileSync(settings, "utf8").includes("inbox-hook"),
    "the hooks are removed from the e2e settings file",
  )
}

let code = 0
try {
  await main()
} catch (e) {
  code = 1
  say(`FAIL ${(e as Error).message}`)
  if (!(e instanceof Failed)) say((e as Error).stack ?? "")
  for (const f of ["inboxd.log", "update.log"]) {
    const p = join(home, f)
    if (existsSync(p)) {
      say(`--- ${f} (tail) ---`)
      say(readFileSync(p, "utf8").split("\n").slice(-30).join("\n"))
    }
  }
} finally {
  cleanup()
}
const gone = !existsSync(root)
const after = fingerprint()
const changed = [
  ...(after.settings === before.settings ? [] : [realSettings]),
  ...realPlists.filter((_, i) => after.plists[i] !== before.plists[i]),
]
if (gone) pass("the temp dir is deleted")
else {
  code = 1
  say(`FAIL ${root} is still there`)
}
if (changed.length === 0)
  pass("the real installs were never touched (settings bytes, plist mtimes)")
else {
  code = 1
  const when = (p: string) => (existsSync(p) ? new Date(statSync(p).mtimeMs).toISOString() : "gone")
  say(
    `FAIL a real install changed during the run (started ${startedAt}): ` +
      changed.map((p) => `${p} (mtime ${when(p)})`).join(", "),
  )
}
say(`e2e-update: ${code === 0 ? "PASS" : "FAIL"} in ${elapsed()}`)
process.exit(code)
