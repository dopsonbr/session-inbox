#!/usr/bin/env bun
/**
 * inbox-hook <Event> — forwards a Claude Code hook payload to the daemon over
 * its Unix socket, and for a held PreToolUse (or, in the experimental mode, a
 * PermissionRequest the daemon answers) waits for the user's decision.
 *
 * FAIL OPEN: every error path exits 0 with no stdout, so Claude behaves as if
 * no hook were installed. This process never exits 2 (which would block Claude).
 *
 * Deliberately imports only `contracts/paths` (node:os/path) — no Effect — to
 * keep cold start small.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { homeOfExecutable, INTERNAL_ENV, paths } from "@session-inbox/contracts/paths"
import { VERSION } from "@session-inbox/contracts/version"

const INGEST_TIMEOUT_MS = 500
const MAX_WAIT_S = 110
const DEFAULT_HOLD_S = 120
/** Under the PermissionRequest hook's registered 3600 s timeout (settings.ts). */
const MAX_REQUEST_HOLD_S = 3500

const call = (socket: string, path: string, init: RequestInit, timeoutMs: number) =>
  fetch(`http://localhost${path}`, {
    ...init,
    unix: socket,
    signal: AbortSignal.timeout(timeoutMs),
  } as RequestInit)

const claudePid = (env: Record<string, string | undefined>): number | null => {
  const fromEnv = Number(env.CLAUDE_PID)
  if (env.CLAUDE_PID && Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  return process.ppid > 1 ? process.ppid : null
}

/** The daemon's event-neutral answer (contracts HookDecision; not imported, H-001). */
export type Decision = {
  decision: "allow" | "deny" | "ask"
  reason?: string
  updatedInput?: unknown
  updatedPermissions?: unknown[]
}

/**
 * THE place a decision becomes hook output, per event. Null = print nothing.
 * PreToolUse: `permissionDecision` allow/deny/ask. PermissionRequest: `decision.behavior`
 * allow/deny; `ask` prints nothing, so Claude's own prompt just stays (exit 2 isn't honoured).
 */
export const encodeDecision = (event: string, d: Decision): string | null => {
  if (event === "PermissionRequest") {
    if (d.decision === "allow")
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "allow",
            ...(d.updatedInput === undefined ? {} : { updatedInput: d.updatedInput }),
            ...(Array.isArray(d.updatedPermissions) && d.updatedPermissions.length > 0
              ? { updatedPermissions: d.updatedPermissions }
              : {}),
          },
        },
      })
    if (d.decision === "deny")
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny", message: d.reason ?? "", interrupt: false },
        },
      })
    return null
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: d.decision,
      permissionDecisionReason: d.reason ?? "",
      ...(d.updatedInput === undefined ? {} : { updatedInput: d.updatedInput }),
    },
  })
}

/** Long-poll for a decision. Returns stdout text, or null to stay silent. */
const awaitDecision = async (
  socket: string,
  event: string,
  requestId: string,
  holdSeconds: number,
): Promise<string | null> => {
  const deadline = Date.now() + holdSeconds * 1000
  while (true) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000)
    if (remaining <= 0) {
      return encodeDecision(event, {
        decision: "ask",
        reason: "Session Inbox: no answer in time; asking in Claude",
      })
    }
    const wait = Math.min(MAX_WAIT_S, remaining)
    const res = await call(
      socket,
      `/v1/hooks/decision/${encodeURIComponent(requestId)}?wait=${wait}`,
      { method: "GET" },
      wait * 1000 + 3000,
    )
    if (!res.ok) return null
    const body = (await res.json()) as Partial<Decision> | { decision?: string } | null
    const d = body?.decision
    if (d === "allow" || d === "deny" || d === "ask") {
      return encodeDecision(event, body as Decision)
    }
    // "pending": keep polling until the budget lapses.
  }
}

export const run = async (
  argv: string[],
  env: Record<string, string | undefined>,
  readStdin: () => Promise<string>,
  execPath: string = process.execPath,
): Promise<string | null> => {
  if (argv[0] === "--version") return VERSION
  if (env[INTERNAL_ENV]) return null

  const args = [...argv]
  const recordMode = args[0] === "record"
  if (recordMode) args.shift()
  let out: string | null = null
  let forward = true
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === "--out") out = args[++i] ?? null
    else if (a === "--no-forward") forward = false
    else positional.push(a)
  }
  const event = positional[0]
  if (!event || !/^[A-Za-z]+$/.test(event)) return null

  const payload: unknown = JSON.parse(await readStdin())
  const hookEnv = {
    entrypoint: env.CLAUDE_CODE_ENTRYPOINT ?? null,
    hostSessionId: env.CLAUDE_CODE_HOST_SESSION_ID ?? null,
    claudePid: claudePid(env),
  }
  const p = paths(env.SESSION_INBOX_HOME || homeOfExecutable(execPath) || undefined)

  if (recordMode) {
    const file = out ?? join(p.fixtures, `${new Date().toISOString().slice(0, 10)}.jsonl`)
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify({ event, payload, env: hookEnv })}\n`)
    if (!forward) return null
  }

  const envelope = { event, payload, env: hookEnv, sentAt: Date.now() }
  const res = await call(
    p.socket,
    `/v1/hooks/${event}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    },
    INGEST_TIMEOUT_MS,
  )
  if (!res.ok) return null
  const ingest = (await res.json()) as { requestId?: string | null; holdMs?: number } | null
  if (!ingest?.requestId) return null

  const holdEnv = Number(env.SESSION_INBOX_HOLD_SECONDS)
  // A PermissionRequest waits as long as the daemon holds it (+5 s for the daemon's own
  // lapse to arrive first), under the registered timeout. PreToolUse keeps 120 s (H-003).
  const daemonHold =
    event === "PermissionRequest" && typeof ingest.holdMs === "number" && ingest.holdMs > 0
      ? Math.min(MAX_REQUEST_HOLD_S, Math.ceil(ingest.holdMs / 1000) + 5)
      : DEFAULT_HOLD_S
  const hold = env.SESSION_INBOX_HOLD_SECONDS && holdEnv > 0 ? holdEnv : daemonHold
  return awaitDecision(p.socket, event, ingest.requestId, hold)
}

const main = async () => {
  let text: string | null = null
  try {
    text = await run(process.argv.slice(2), process.env, () => Bun.stdin.text())
  } catch {
    text = null // fail open
  }
  if (text) process.stdout.write(`${text}\n`)
  process.exit(0)
}

// No top-level await: `bun build --bytecode` emits CommonJS.
if (import.meta.main) void main()
