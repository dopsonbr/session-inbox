#!/usr/bin/env bun
/**
 * inbox-hook <Event> — forwards a Claude Code hook payload to the daemon over
 * its Unix socket, and for a held PreToolUse waits for the user's decision.
 *
 * FAIL OPEN: every error path exits 0 with no stdout, so Claude behaves as if
 * no hook were installed. This process never exits 2 (which would block Claude).
 *
 * Deliberately imports only `contracts/paths` (node:os/path) — no Effect — to
 * keep cold start small.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { INTERNAL_ENV, paths } from "@session-inbox/contracts/paths"

const INGEST_TIMEOUT_MS = 500
const MAX_WAIT_S = 110
const DEFAULT_HOLD_S = 120

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

const decisionJson = (decision: string, reason?: string, updatedInput?: unknown) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason ?? "",
      ...(updatedInput === undefined ? {} : { updatedInput }),
    },
  })

/** Long-poll for a decision. Returns stdout text, or null to stay silent. */
const awaitDecision = async (
  socket: string,
  requestId: string,
  holdSeconds: number,
): Promise<string | null> => {
  const deadline = Date.now() + holdSeconds * 1000
  while (true) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000)
    if (remaining <= 0) {
      return decisionJson("ask", "Session Inbox: no answer in time; asking in Claude")
    }
    const wait = Math.min(MAX_WAIT_S, remaining)
    const res = await call(
      socket,
      `/v1/hooks/decision/${encodeURIComponent(requestId)}?wait=${wait}`,
      { method: "GET" },
      wait * 1000 + 3000,
    )
    if (!res.ok) return null
    const body = (await res.json()) as {
      decision?: string
      reason?: string
      updatedInput?: unknown
    }
    if (body.decision === "allow" || body.decision === "deny" || body.decision === "ask") {
      return decisionJson(body.decision, body.reason, body.updatedInput)
    }
    // "pending": keep polling until the budget lapses.
  }
}

export const run = async (
  argv: string[],
  env: Record<string, string | undefined>,
  readStdin: () => Promise<string>,
): Promise<string | null> => {
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
  const p = paths(env.SESSION_INBOX_HOME || undefined)

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
  const ingest = (await res.json()) as { requestId?: string | null } | null
  if (!ingest?.requestId) return null

  const holdEnv = Number(env.SESSION_INBOX_HOLD_SECONDS)
  const hold = env.SESSION_INBOX_HOLD_SECONDS && holdEnv > 0 ? holdEnv : DEFAULT_HOLD_S
  return awaitDecision(p.socket, ingest.requestId, hold)
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
