#!/usr/bin/env bun
/**
 * inbox-hook <Event> — forwards a Claude Code hook payload to the daemon over
 * its Unix socket, and for a PermissionRequest the daemon answers (or, in the classic
 * mode, a held PreToolUse) waits for the user's decision.
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
/** A poll is aborted this long after its `wait` (the daemon answers at `wait`; H-050). */
const POLL_SLACK_MS = 10_000
/** Failed polls are retried this often, for up to RETRY_S of consecutive failures (H-050). */
const RETRY_EVERY_MS = 1_000
const RETRY_S = 15

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

/** One poll: the daemon's answer, or null when it failed (refused, timed out, non-2xx, bad body). */
const pollOnce = async (
  socket: string,
  requestId: string,
  wait: number,
): Promise<{ decision?: string } | null> => {
  try {
    const res = await call(
      socket,
      `/v1/hooks/decision/${encodeURIComponent(requestId)}?wait=${wait}`,
      { method: "GET" },
      wait * 1000 + POLL_SLACK_MS,
    )
    if (!res.ok) return null
    const body = (await res.json()) as { decision?: string } | null
    return body && typeof body === "object" ? body : null
  } catch {
    return null
  }
}

/**
 * Long-poll for a decision. Returns stdout text, or null to stay silent. A failed poll is not
 * the end (H-050): the daemon may be restarting, or this process may have stalled. Re-poll the
 * same request every second while failures are consecutive for up to `retrySeconds`, never past
 * the budget; only then give up silently. `pending` just loops, as before.
 */
const awaitDecision = async (
  socket: string,
  event: string,
  requestId: string,
  holdSeconds: number,
  retrySeconds: number,
): Promise<string | null> => {
  const deadline = Date.now() + holdSeconds * 1000
  let failingSince: number | null = null
  while (true) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000)
    if (remaining <= 0) {
      // Still failing at the budget's end: the daemon is gone, stay silent (H-002).
      if (failingSince !== null) return null
      return encodeDecision(event, {
        decision: "ask",
        reason: "Session Inbox: no answer in time; asking in Claude",
      })
    }
    const wait = Math.min(MAX_WAIT_S, remaining)
    const body = await pollOnce(socket, requestId, wait)
    if (body === null) {
      const now = Date.now()
      failingSince ??= now
      if (now - failingSince >= retrySeconds * 1000) return null
      const pause = Math.min(RETRY_EVERY_MS, deadline - now)
      if (pause <= 0) return null
      await Bun.sleep(pause)
      continue
    }
    failingSince = null
    const d = body.decision
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
  const retryEnv = Number(env.SESSION_INBOX_RETRY_SECONDS)
  const retry = env.SESSION_INBOX_RETRY_SECONDS && retryEnv >= 0 ? retryEnv : RETRY_S
  return awaitDecision(p.socket, event, ingest.requestId, hold, retry)
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
