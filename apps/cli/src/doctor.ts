/**
 * `session-inbox doctor`: the setup check (C-021). Online, the running daemon writes every
 * word (`GET /v1/doctor`) and this only renders it. Offline (no connection.json, or no answer
 * within 3 s) the CLI checks what it can see itself: home, binaries, launchd job, log, hooks.
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { DoctorCheck, DoctorReport } from "@session-inbox/contracts"
import { paths } from "@session-inbox/contracts/paths"
import { hookHome, isOurs } from "../../hook/src/settings.ts"
import { parseSettings, plistPath, uid } from "./common.ts"
import { jobState } from "./launchd.ts"
import { PAYLOAD_BINARIES } from "./manifest.ts"
import { connection } from "./status.ts"

export type DoctorTarget = { home: string; label: string; settingsPath: string }

const MARK: Record<DoctorCheck["status"], string> = { ok: "✓", warn: "!", fail: "✗", info: "·" }
const WIDTH = 80

/** Greedy word wrap; a word longer than the width gets a line of its own. */
export const wrap = (text: string, width: number): string[] => {
  const out: string[] = []
  for (const para of text.split("\n")) {
    let line = ""
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line === "") line = word
      else if (line.length + 1 + word.length <= width) line += ` ${word}`
      else {
        out.push(line)
        line = word
      }
    }
    out.push(line)
  }
  return out
}

/** Aligned plain text: marker, title column, detail wrapped at 80 columns, fix underneath. */
export const renderReport = (r: Pick<DoctorReport, "checks">): string[] => {
  const titleWidth = Math.max(0, ...r.checks.map((c) => c.title.length))
  const indent = 2 + titleWidth + 2
  const pad = " ".repeat(indent)
  const lines: string[] = []
  for (const c of r.checks) {
    const detail = wrap(c.detail, Math.max(20, WIDTH - indent))
    lines.push(`${MARK[c.status]} ${c.title.padEnd(titleWidth)}  ${detail[0] ?? ""}`.trimEnd())
    for (const d of detail.slice(1)) lines.push(`${pad}${d}`.trimEnd())
    if (c.fix) lines.push(`${pad}→ ${c.fix.kind === "url" ? "open" : "run"}: ${c.fix.value}`)
  }
  return lines
}

export const summaryLine = (r: Pick<DoctorReport, "checks">): string => {
  const n = (s: DoctorCheck["status"]) => r.checks.filter((c) => c.status === s).length
  const fail = n("fail")
  const warn = n("warn")
  if (fail === 0 && warn === 0) return "Everything looks good."
  return [
    fail ? `${fail} failed` : "",
    warn ? `${warn} need${warn === 1 ? "s" : ""} attention` : "",
  ]
    .filter(Boolean)
    .join(", ")
}

export type Online =
  | { _tag: "report"; report: DoctorReport }
  | { _tag: "too-old" }
  | { _tag: "offline"; reason: string }

/** Ask the running daemon. Never throws; 3 s budget. */
export const fetchDoctor = async (
  home: string,
  timeoutMs = 3000,
  fetchImpl: typeof fetch = fetch,
): Promise<Online> => {
  const conn = connection(home)
  if (!conn) return { _tag: "offline", reason: `no ${paths(home).connection}` }
  try {
    const res = await fetchImpl(`http://127.0.0.1:${conn.httpPort}/v1/doctor`, {
      headers: { authorization: `Bearer ${conn.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 404) return { _tag: "too-old" }
    if (!res.ok) return { _tag: "offline", reason: `the daemon answered ${res.status}` }
    const v = (await res.json()) as DoctorReport
    if (!Array.isArray(v?.checks)) return { _tag: "offline", reason: "the daemon sent no checks" }
    return { _tag: "report", report: v }
  } catch (e) {
    const msg =
      (e as Error).name === "TimeoutError"
        ? `no answer within ${timeoutMs / 1000} s`
        : (e as Error).message
    return { _tag: "offline", reason: msg }
  }
}

const executable = (f: string) => {
  try {
    accessSync(f, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export const tailLines = (file: string, n: number): string[] | null => {
  try {
    const text = readFileSync(file, "utf8")
    return text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-n)
  } catch {
    return null
  }
}

/** Hook homes in a settings file: ours pointing here, and ours pointing elsewhere. */
const hookHomes = (settingsPath: string): { homes: Set<string>; error: string | null } => {
  const homes = new Set<string>()
  try {
    const text = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null
    const s = parseSettings(text, settingsPath)
    for (const groups of Object.values(s.hooks ?? {}))
      if (Array.isArray(groups))
        for (const g of groups)
          for (const h of g?.hooks ?? []) {
            if (!isOurs(h?.command)) continue
            const hh = hookHome(h?.command)
            if (hh) homes.add(hh)
          }
    return { homes, error: null }
  } catch (e) {
    return { homes, error: (e as Error).message }
  }
}

/**
 * What the CLI can check without the daemon. `launchd` is injectable for tests; `reason` is
 * why the daemon couldn't be asked.
 */
export const localChecks = (
  t: DoctorTarget,
  reason: string,
  launchd: (label: string) => { loaded: boolean; pid: number | null } = jobState,
): DoctorCheck[] => {
  const domain = `gui/${uid()}`
  const kick: DoctorCheck["fix"] = {
    label: "Restart the daemon",
    kind: "copy",
    value: `launchctl kickstart -k ${domain}/${t.label}`,
  }
  const checks: DoctorCheck[] = []
  const homeOk = existsSync(t.home)
  checks.push({
    id: "home",
    title: "Home",
    status: homeOk ? "ok" : "fail",
    detail: homeOk ? t.home : `${t.home} does not exist: Session Inbox isn't installed here.`,
    ...(homeOk
      ? {}
      : {
          fix: {
            label: "Install",
            kind: "url" as const,
            value: "https://github.com/dopsonbr/session-inbox#install",
          },
        }),
  })
  const missing = PAYLOAD_BINARIES.filter((b) => !executable(join(t.home, "bin", b)))
  checks.push({
    id: "binaries",
    title: "Binaries",
    status: missing.length === 0 ? "ok" : "fail",
    detail:
      missing.length === 0
        ? `${PAYLOAD_BINARIES.join(", ")} are in ${join(t.home, "bin")}`
        : `missing or not executable in ${join(t.home, "bin")}: ${missing.join(", ")}. Reinstall.`,
  })
  const job = launchd(t.label)
  const plist = plistPath(t.label)
  checks.push(
    job.pid
      ? {
          id: "launchd",
          title: "Background job",
          status: "ok",
          detail: `${t.label} is running (pid ${job.pid})`,
        }
      : job.loaded
        ? {
            id: "launchd",
            title: "Background job",
            status: "fail",
            detail: `${t.label} is loaded but not running.`,
            fix: kick,
          }
        : {
            id: "launchd",
            title: "Background job",
            status: "fail",
            detail: existsSync(plist)
              ? `${t.label} is not loaded.`
              : `${t.label} is not installed (no ${plist}).`,
            ...(existsSync(plist)
              ? {
                  fix: {
                    label: "Load it",
                    kind: "copy" as const,
                    value: `launchctl bootstrap ${domain} "${plist}"`,
                  },
                }
              : {}),
          },
  )
  checks.push({
    id: "daemon",
    title: "Daemon",
    status: "fail",
    detail: `not answering (${reason}).`,
    fix: kick,
  })
  const hooks = hookHomes(t.settingsPath)
  const elsewhere = [...hooks.homes].filter((h) => h !== t.home)
  checks.push(
    hooks.error
      ? { id: "hooks", title: "Hooks", status: "fail", detail: hooks.error }
      : hooks.homes.has(t.home)
        ? {
            id: "hooks",
            title: "Hooks",
            status: "ok",
            detail:
              `${t.settingsPath} runs this home's inbox-hook` +
              (elsewhere.length ? ` (and also ${elsewhere.join(", ")})` : ""),
          }
        : {
            id: "hooks",
            title: "Hooks",
            status: "fail",
            detail:
              elsewhere.length > 0
                ? `${t.settingsPath} points at another home: ${elsewhere.join(", ")}. Reinstall to point it here.`
                : `${t.settingsPath} has no Session Inbox hooks: Claude won't send anything. Reinstall.`,
          },
  )
  const log = tailLines(paths(t.home).log, 10)
  checks.push({
    id: "log",
    title: "Log",
    status: "info",
    detail:
      log === null
        ? `no ${paths(t.home).log} yet`
        : log.length === 0
          ? `${paths(t.home).log} is empty`
          : `last lines of ${paths(t.home).log}:\n${log.join("\n")}`,
  })
  return checks
}

/** A DoctorReport built from local checks, so `--json` has one shape online and offline. */
export const offlineReport = (checks: DoctorCheck[], now = Date.now()): DoctorReport => ({
  generatedAt: now,
  ok: !checks.some((c) => c.status === "fail"),
  attention: checks.filter((c) => c.status === "warn" || c.status === "fail").length,
  firstRun: false,
  checks,
})

export const TOO_OLD =
  "This daemon is too old for the setup check. Update it with `session-inbox update --yes`; " +
  "meanwhile, here is what can be checked from the outside:"

export const doctor = async (
  t: DoctorTarget,
  opts: { json: boolean },
  say: (line: string) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<number> => {
  const online = await fetchDoctor(t.home, 3000, fetchImpl)
  if (online._tag === "report") {
    if (opts.json) say(JSON.stringify(online.report))
    else {
      for (const l of renderReport(online.report)) say(l)
      say("")
      say(summaryLine(online.report))
    }
    return online.report.ok ? 0 : 1
  }
  const reason = online._tag === "too-old" ? "it predates the setup check" : online.reason
  const checks = localChecks(t, reason).filter(
    // An old daemon that answered is up; only the local view of the rest is useful.
    (c) => online._tag !== "too-old" || c.id !== "daemon",
  )
  const report = offlineReport(checks)
  if (opts.json) {
    say(JSON.stringify(report))
    return 1
  }
  say(
    online._tag === "too-old"
      ? TOO_OLD
      : "The daemon isn't answering, so these are the checks the CLI can do on its own:",
  )
  say("")
  for (const l of renderReport(report)) say(l)
  say("")
  say(`Start it with: launchctl kickstart -k gui/${uid()}/${t.label}`)
  return 1
}
