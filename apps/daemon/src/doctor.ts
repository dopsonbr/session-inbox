/**
 * Setup check (C-021, G-030 #3, D-065). The daemon writes every word; the app and
 * `session-inbox doctor` only render them. `gather` reads the outside world (settings file,
 * binaries, DB size); `buildReport` is pure so each branch is testable.
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type {
  DoctorCheck,
  DoctorFix,
  DoctorReport,
  ShellStatus,
  UpdateStatus,
} from "@session-inbox/contracts"
import { HOOK_SPECS, hookHome, isOurs } from "../../hook/src/settings.ts"
import { SHELL_REPORT_GRACE_MS } from "./delivery.ts"
import type { Engine } from "./engine.ts"
import type { ClaudeAuth } from "./services.ts"

export const HOOK_EVENTS = HOOK_SPECS.map((s) => s.event)

export interface HooksFacts {
  readonly settingsPath: string
  /** null: file missing; "unreadable": not JSON. */
  readonly settings: "missing" | "unreadable" | "ok"
  /** Our events registered with a command pointing at this home. */
  readonly registered: ReadonlyArray<string>
  /** Other homes our hook commands point at (another channel, or a moved install). */
  readonly otherHomes: ReadonlyArray<string>
  readonly binary: "ok" | "missing" | "not-executable"
  readonly binaryPath: string
}

export interface DoctorFacts {
  readonly now: number
  readonly version: string
  readonly build: string
  readonly channel: string
  readonly startedAt: number
  readonly home: string
  readonly installSource: "release" | "source" | null
  readonly hooks: HooksFacts
  readonly firstHookAt: number | null
  readonly lastHookAt: number | null
  readonly holds: { enabled: boolean; tools: ReadonlyArray<string> }
  readonly otherChannel: string | null
  readonly auth: ClaudeAuth
  readonly shell: { connected: boolean; status: ShellStatus | null; connectedAt: number | null }
  readonly fallback: boolean
  readonly update: UpdateStatus | null
  readonly storage: { dbBytes: number | null; events: number; retentionDays: number }
}

const NOTIFICATION_SETTINGS = "x-apple.systempreferences:com.apple.Notifications-Settings.extension"

export const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`
  return `${Math.round(h / 24)} days`
}

const bytes = (n: number): string =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

const list = (xs: ReadonlyArray<string>) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`

export const installCommand = (f: Pick<DoctorFacts, "installSource" | "channel">): string =>
  f.installSource === "release"
    ? "session-inbox install --yes"
    : `bun scripts/install.ts --yes${f.channel === "beta" ? " --channel beta" : ""}`

const check = (
  id: string,
  title: string,
  status: DoctorCheck["status"],
  detail: string,
  fix?: DoctorFix,
): DoctorCheck => (fix ? { id, title, status, detail, fix } : { id, title, status, detail })

const daemonCheck = (f: DoctorFacts): DoctorCheck =>
  check(
    "daemon",
    "Session Inbox is running",
    "ok",
    `Version ${f.version} (${f.channel}, build ${f.build}), running for ${ago(f.now - f.startedAt)}.`,
  )

const hooksCheck = (f: DoctorFacts): DoctorCheck => {
  const h = f.hooks
  const title = "Claude Code hooks"
  const fix: DoctorFix = { label: "Reinstall the hooks", kind: "copy", value: installCommand(f) }
  if (h.settings === "unreadable")
    return check(
      "hooks",
      title,
      "fail",
      `${h.settingsPath} isn't valid JSON, so Claude Code can't load any hooks from it. Fix the file, then reinstall.`,
      fix,
    )
  if (h.registered.length === 0) {
    const elsewhere =
      h.otherHomes.length > 0
        ? ` The hooks there point at another install (${list(h.otherHomes)}).`
        : ""
    return check(
      "hooks",
      title,
      "fail",
      `${h.settings === "missing" ? `${h.settingsPath} doesn't exist` : `${h.settingsPath} has none of this install's hooks`}, so no Claude session reports to this inbox.${elsewhere}`,
      fix,
    )
  }
  if (h.binary !== "ok")
    return check(
      "hooks",
      title,
      "fail",
      `The hooks point at ${h.binaryPath}, which ${h.binary === "missing" ? "doesn't exist" : "isn't executable"}. Claude runs it on every event, so nothing reaches the inbox.`,
      fix,
    )
  const missing = HOOK_EVENTS.filter((e) => !h.registered.includes(e))
  if (missing.length > 0)
    return check(
      "hooks",
      title,
      "warn",
      `Only ${h.registered.length} of ${HOOK_EVENTS.length} hook events are registered; ${list(missing)} ${missing.length === 1 ? "is" : "are"} missing, so some sessions won't show up correctly.`,
      fix,
    )
  return check(
    "hooks",
    title,
    "ok",
    `All ${HOOK_EVENTS.length} hook events in ${h.settingsPath} run ${h.binaryPath}.`,
  )
}

const eventsCheck = (f: DoctorFacts): DoctorCheck =>
  f.lastHookAt === null
    ? check(
        "events",
        "Hook events",
        "warn",
        "No hook events yet. Hooks load when a Claude session starts: restart sessions that were already open.",
      )
    : check(
        "events",
        "Hook events",
        "info",
        `The last hook event arrived ${ago(f.now - f.lastHookAt)} ago.`,
      )

const holdsCheck = (f: DoctorFacts): DoctorCheck => {
  const other = f.otherChannel
    ? ` The ${f.otherChannel} channel is also installed on this Mac; only one should hold tool calls, or each waits for its own answer.`
    : ""
  if (!f.holds.enabled)
    return check(
      "holds",
      "Approvals",
      "info",
      `This install only observes: Claude asks for permission in its own window, and the inbox shows and notifies.${other}`,
    )
  const tools = f.holds.tools.length > 0 ? list(f.holds.tools) : "no tools"
  return check(
    "holds",
    "Approvals",
    "ok",
    `This install holds tool calls for approval in the inbox (${tools}, plus Claude's questions) whenever Claude itself would ask.${other}`,
  )
}

const cliCheck = (f: DoctorFacts): DoctorCheck => {
  const title = "claude command-line tool"
  const fix: DoctorFix = { label: "Run claude once to log in", kind: "copy", value: "claude" }
  const without =
    "Without it, replies to sessions that are waiting for a new prompt and generated session titles don't work; approvals, questions and notifications still do."
  if (f.auth.found === false)
    return check("claude-cli", title, "warn", `claude isn't on this Mac's PATH. ${without}`, fix)
  if (f.auth.loggedIn === false)
    return check(
      "claude-cli",
      title,
      "warn",
      `claude is installed but not logged in. ${without}`,
      fix,
    )
  if (f.auth.loggedIn === true)
    return check(
      "claude-cli",
      title,
      "ok",
      `claude is installed and logged in${f.auth.method && f.auth.method !== "none" ? ` (${f.auth.method})` : ""}, so replies and generated titles work.`,
    )
  return check(
    "claude-cli",
    title,
    "info",
    "Couldn't tell whether claude is logged in yet. Replies to idle sessions and generated titles need a logged-in claude.",
  )
}

const appCheck = (f: DoctorFacts): DoctorCheck => {
  const title = "Menu-bar app"
  if (!f.shell.connected)
    return check(
      "app",
      title,
      "warn",
      "The Session Inbox menu-bar app isn't connected. Notifications fall back to plain macOS ones without Allow/Deny buttons.",
    )
  const v = f.shell.status?.version
  if (!f.shell.status)
    return check(
      "app",
      title,
      reportPending(f) ? "info" : "warn",
      reportPending(f)
        ? "The menu-bar app is connected and hasn't reported its version yet."
        : "The menu-bar app is connected but doesn't report its version or notification permission: it's an older build. Update it.",
    )
  if (!v) return check("app", title, "info", "The menu-bar app is connected.")
  if (v !== f.version)
    return check(
      "app",
      title,
      "warn",
      `The menu-bar app is version ${v} but the daemon is ${f.version}. Reinstall so they match.`,
      { label: "Reinstall", kind: "copy", value: installCommand(f) },
    )
  return check("app", title, "ok", `The menu-bar app is connected (version ${v}).`)
}

const reportPending = (f: DoctorFacts) =>
  f.shell.connectedAt !== null && f.now - f.shell.connectedAt < SHELL_REPORT_GRACE_MS

const notificationsCheck = (f: DoctorFacts): DoctorCheck => {
  const title = "Notifications"
  const fix: DoctorFix = {
    label: "Open Notification settings",
    kind: "url",
    value: NOTIFICATION_SETTINGS,
  }
  const fallback = f.fallback
    ? "Meanwhile the daemon posts plain fallback notifications (no buttons)."
    : "The plain fallback is turned off in Settings, so you get no notifications meanwhile."
  if (!f.shell.connected)
    return check(
      "notifications",
      title,
      f.fallback ? "warn" : "fail",
      f.fallback
        ? "No menu-bar app is connected, so only plain fallback notifications are posted: no Allow/Deny or Answer buttons."
        : "No menu-bar app is connected and the plain fallback is turned off in Settings, so you get no notifications.",
    )
  const p = f.shell.status?.notifications ?? null
  switch (p) {
    case "authorized": {
      const style = f.shell.status?.alertStyle
      const note =
        style === "alert"
          ? "Style is Alerts: Allow/Deny stay on screen until you answer."
          : style === "banner"
            ? 'Style is Banners: they disappear after a few seconds. Choose "Alerts" to keep Allow/Deny on screen.'
            : style === "none"
              ? "Style is None: they go straight to Notification Center without showing."
              : 'Choose "Alerts" to keep Allow/Deny on screen; "Banners" disappear after a few seconds.'
      return check(
        "notifications",
        title,
        style === "none" ? "warn" : "ok",
        `macOS allows notifications from the menu-bar app. ${note}`,
        style === "alert" ? undefined : fix,
      )
    }
    case "provisional":
      return check(
        "notifications",
        title,
        "warn",
        "macOS delivers the app's notifications quietly, to Notification Center only. Allow them to see Allow/Deny when Claude asks.",
        fix,
      )
    case "notDetermined":
      return check(
        "notifications",
        title,
        "warn",
        `macOS hasn't been answered yet — look for the permission prompt. ${fallback}`,
      )
    case "denied":
      return check(
        "notifications",
        title,
        "fail",
        `Notifications from the menu-bar app are turned off in macOS. ${fallback} Turn them on for Session Inbox.`,
        fix,
      )
    default:
      if (p === null && reportPending(f))
        return check(
          "notifications",
          title,
          "info",
          "Waiting for the menu-bar app to report its notification permission.",
        )
      return check(
        "notifications",
        title,
        "warn",
        f.fallback
          ? "The menu-bar app can't say whether macOS lets it show notifications, so each one is also posted as a plain fallback notification. You may see two."
          : "The menu-bar app can't say whether macOS lets it show notifications, and the plain fallback is off, so some may never appear.",
        fix,
      )
  }
}

const updatesCheck = (f: DoctorFacts): DoctorCheck => {
  const u = f.update
  const title = "Updates"
  if (!u || u.state === "unsupported")
    return check(
      "updates",
      title,
      "info",
      `Version ${f.version}. Updates aren't managed by this install (it runs from source, or the session-inbox command isn't installed).`,
    )
  const checked =
    u.checkedAt === null ? "not checked yet" : `last checked ${ago(f.now - u.checkedAt)} ago`
  const auto = u.auto
    ? "installs updates by itself when no session is waiting"
    : "auto-update is off"
  const source = u.source ? ` (${u.source} install)` : ""
  if (u.state === "failed")
    return check(
      "updates",
      title,
      "warn",
      `Updating to ${u.target ?? "the new version"} failed: ${u.error ?? "unknown error"}. Version ${u.current} is still running.`,
    )
  if (u.available && u.latest)
    return check(
      "updates",
      title,
      "info",
      `Version ${u.latest} is available (running ${u.current}${source}); ${auto}.`,
    )
  if (u.error)
    return check(
      "updates",
      title,
      "warn",
      `Version ${u.current}${source}. The last update check failed: ${u.error}`,
    )
  return check(
    "updates",
    title,
    "ok",
    `Version ${u.current} is up to date${source}; ${checked}; ${auto}.`,
  )
}

const storageCheck = (f: DoctorFacts): DoctorCheck =>
  check(
    "storage",
    "Storage",
    "info",
    `${f.storage.dbBytes === null ? "The database" : `The database is ${bytes(f.storage.dbBytes)}`} with ${f.storage.events} events; history older than ${f.storage.retentionDays} days is pruned daily. Home: ${f.home}.`,
  )

export const buildReport = (f: DoctorFacts): DoctorReport => {
  const checks = [
    daemonCheck(f),
    hooksCheck(f),
    eventsCheck(f),
    holdsCheck(f),
    cliCheck(f),
    appCheck(f),
    notificationsCheck(f),
    updatesCheck(f),
    storageCheck(f),
  ]
  return {
    generatedAt: f.now,
    ok: !checks.some((c) => c.status === "fail"),
    attention: checks.filter((c) => c.status === "warn" || c.status === "fail").length,
    firstRun: f.firstHookAt === null,
    checks,
  }
}

// ---------------------------------------------------------------------------
// Gathering facts
// ---------------------------------------------------------------------------

type HookGroup = { hooks?: Array<{ command?: unknown }> }

/** Which of our events in `<claudeConfigDir>/settings.json` run `<home>/bin/inbox-hook`. */
export const inspectHooks = (claudeConfigDir: string, home: string): HooksFacts => {
  const settingsPath = join(claudeConfigDir, "settings.json")
  const binaryPath = join(home, "bin", "inbox-hook")
  let binary: HooksFacts["binary"] = "missing"
  try {
    if (existsSync(binaryPath) && statSync(binaryPath).isFile()) {
      accessSync(binaryPath, constants.X_OK)
      binary = "ok"
    }
  } catch {
    binary = "not-executable"
  }
  const base = { settingsPath, binaryPath, binary }
  if (!existsSync(settingsPath))
    return { ...base, settings: "missing", registered: [], otherHomes: [] }
  let hooks: Record<string, unknown>
  try {
    const o = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks?: unknown }
    hooks = o && typeof o.hooks === "object" && o.hooks !== null ? (o.hooks as typeof hooks) : {}
  } catch {
    return { ...base, settings: "unreadable", registered: [], otherHomes: [] }
  }
  const registered: string[] = []
  const others = new Set<string>()
  const norm = (p: string) => p.replace(/\/+$/, "")
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : []
    let mine = false
    for (const g of groups)
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        if (!isOurs(h?.command)) continue
        const at = hookHome(h?.command)
        if (at !== null && norm(at) === norm(home)) mine = true
        else if (at !== null) others.add(at)
      }
    if (mine) registered.push(event)
  }
  return { ...base, settings: "ok", registered, otherHomes: [...others] }
}

/** `<home>/install.json` `{ "source": "release" | "source" }`, written by the installer. */
export const readInstallSource = (home: string): "release" | "source" | null => {
  try {
    const o = JSON.parse(readFileSync(join(home, "install.json"), "utf8")) as { source?: unknown }
    return o.source === "release" || o.source === "source" ? o.source : null
  } catch {
    return null
  }
}

export interface DoctorEnv {
  readonly home: string
  readonly dbPath: string
  readonly claudeConfigDir: string
  readonly channel: string
  readonly version: string
  readonly build: string
  readonly otherChannel: () => string | null
}

/** The setup check over a running engine; tells pages when its attention count changes. */
export class Doctor {
  private lastAttention: number | null = null

  constructor(
    private readonly engine: Engine,
    private readonly env: DoctorEnv,
  ) {
    engine.onDoctorChange = () => this.recheck()
    engine.hub.doctorGreeting = () =>
      this.lastAttention === null
        ? null
        : { _tag: "doctor", seq: engine.store.maxSeq(), attention: this.lastAttention }
  }

  facts(): DoctorFacts {
    const e = this.engine
    let dbBytes: number | null = null
    try {
      dbBytes = statSync(this.env.dbPath).size
      const wal = `${this.env.dbPath}-wal`
      if (existsSync(wal)) dbBytes += statSync(wal).size
    } catch {
      dbBytes = null
    }
    return {
      now: e.deps.clock.now(),
      version: this.env.version,
      build: this.env.build,
      channel: this.env.channel,
      startedAt: e.startedAt,
      home: this.env.home,
      installSource: readInstallSource(this.env.home),
      hooks: inspectHooks(this.env.claudeConfigDir, this.env.home),
      firstHookAt: e.firstHookAt,
      lastHookAt: e.lastHookAt,
      holds: { enabled: e.settings["holds.enabled"], tools: e.settings["holds.tools"] },
      otherChannel: this.env.otherChannel(),
      auth: e.auth,
      shell: e.shellStatus(),
      fallback: e.settings["notifications.fallback"],
      update: e.updates?.status() ?? null,
      storage: {
        dbBytes,
        events: e.store.one<{ n: number }>("SELECT COUNT(*) AS n FROM events")?.n ?? 0,
        retentionDays: e.settings["storage.retentionDays"],
      },
    }
  }

  /** GET /v1/doctor: fresh, including the (cached) claude CLI probe. Read-only: no event. */
  async report(): Promise<DoctorReport> {
    await this.engine.refreshAuth()
    const r = buildReport(this.facts())
    this.note(r.attention)
    return r
  }

  /** Cheap re-evaluation (cached CLI probe); publishes `doctor` when attention changed. */
  recheck(): void {
    try {
      this.note(buildReport(this.facts()).attention)
    } catch (e) {
      this.engine.deps.log.warn("setup check failed", e)
    }
  }

  private note(attention: number) {
    if (attention === this.lastAttention) return
    this.lastAttention = attention
    this.engine.hub.publish({ _tag: "doctor", seq: this.engine.store.maxSeq(), attention })
  }
}
