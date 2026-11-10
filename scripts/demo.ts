/**
 * Run the real daemon on a throwaway home, seed it with a realistic set of
 * sessions through the hook socket, and keep it running so you can click
 * around the built UI. Needs no Claude account; touches nothing outside
 * /tmp/si-demo-*.
 *
 *   bun run --cwd apps/desktop build   # once, so there is a UI to serve
 *   bun scripts/demo.ts                # prints the URL; Ctrl-C to stop
 */

import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Connection, Snapshot } from "../packages/contracts/src/index.ts"
import { paths } from "../packages/contracts/src/paths.ts"

const repo = resolve(import.meta.dir, "..")
const home = mkdtempSync("/tmp/si-demo-")
const claudeDir = join(home, "claude")
mkdirSync(claudeDir)

const daemon = Bun.spawn(
  ["bun", join(repo, "apps/daemon/src/main.ts"), "--home", home, "--port", "0"],
  {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeDir,
      SESSION_INBOX_CLAUDE: "/usr/bin/false",
      SESSION_INBOX_UI_DIR: join(repo, "apps/desktop/dist"),
    },
    stdout: "inherit",
    stderr: "inherit",
  },
)
const cleanup = () => {
  daemon.kill("SIGTERM")
  rmSync(home, { recursive: true, force: true })
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    cleanup()
    process.exit(0)
  })
}

let conn: Connection | null = null
for (let i = 0; i < 100 && !conn; i++) {
  try {
    conn = JSON.parse(readFileSync(join(home, "connection.json"), "utf8")) as Connection
  } catch {
    await Bun.sleep(50)
  }
}
if (!conn) throw new Error("daemon did not start")
const c = conn
await Bun.sleep(200)

const projects: Record<string, string> = {}
const proj = (name: string) => {
  if (!projects[name]) {
    const dir = join(home, "projects", name)
    mkdirSync(dir, { recursive: true })
    projects[name] = dir
  }
  return projects[name]
}

const post = async (
  sid: string,
  project: string,
  event: string,
  payload: Record<string, unknown> = {},
  entrypoint = "claude-desktop",
) => {
  const r = await fetch(`http://localhost/v1/hooks/${event}`, {
    unix: c.socketPath,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event,
      payload: {
        session_id: sid,
        cwd: proj(project),
        hook_event_name: event,
        permission_mode: "default",
        ...payload,
      },
      env: { entrypoint, hostSessionId: `local_${sid}`, claudePid: process.pid },
      sentAt: Date.now(),
    }),
  })
  return (await r.json()) as { requestId: string | null }
}

/**
 * One hook event. A PreToolUse is followed by the PermissionRequest Claude sends when it is
 * about to ask (same tool and input, no tool_use_id): in the default mode that is what the
 * inbox answers (D-074), and without it the seeded approvals would only be observed.
 */
const hook: typeof post = async (sid, project, event, payload = {}, entrypoint) => {
  const first = await post(sid, project, event, payload, entrypoint)
  if (event !== "PreToolUse") return first
  const { tool_use_id: _id, ...request } = payload
  const asked = await post(sid, project, "PermissionRequest", request, entrypoint)
  if (asked.requestId) void keepPolling(asked.requestId)
  return asked
}

/**
 * Wait on a request the way a real `inbox-hook` does. Without a waiting hook the daemon takes
 * the request for orphaned after 20 seconds and hands it to Claude's own prompt (D-080), and
 * the seeded approvals could no longer be answered from the page.
 */
const keepPolling = async (requestId: string) => {
  for (;;) {
    try {
      const r = await fetch(
        `http://localhost/v1/hooks/decision/${encodeURIComponent(requestId)}?wait=25`,
        { unix: c.socketPath },
      )
      const body = (await r.json()) as { decision?: string } | null
      if (!r.ok || (body?.decision && body.decision !== "pending")) return
    } catch {
      return
    }
  }
}

const session = async (sid: string, project: string, prompt: string, entrypoint?: string) => {
  await hook(sid, project, "SessionStart", { source: "startup" }, entrypoint)
  await hook(sid, project, "UserPromptSubmit", { prompt }, entrypoint)
}
const tool = (sid: string, project: string, name: string, input: Record<string, unknown>) =>
  hook(sid, project, "PostToolUse", { tool_name: name, tool_input: input, tool_response: {} })

// Finished items for the History view: answer through the API as the UI would.
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${c.httpPort}${path}`, {
    method,
    headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!r.ok) console.warn(`demo: ${method} ${path} answered ${r.status}`)
  return r
}
const openItem = async (sid: string, kind: string) => {
  const snap = (await (await api("GET", "/v1/snapshot")).json()) as Snapshot
  const item = snap.items.find((i) => i.sessionId === sid && i.kind === kind && i.state === "open")
  if (!item) throw new Error(`demo: no open ${kind} item in ${sid}`)
  return item.id
}
let keys = 0
const decide = async (sid: string, decision: string) =>
  api("POST", `/v1/items/${await openItem(sid, "permission")}/decision`, {
    idempotencyKey: `demo-${++keys}`,
    decision,
  })
const answer = async (sid: string, selected: string[]) =>
  api("POST", `/v1/items/${await openItem(sid, "question")}/answers`, {
    idempotencyKey: `demo-${++keys}`,
    answers: [{ idx: 0, selected }],
  })
/** A Bash call the inbox is asked about, answered there, then run. */
const decidedBash = async (
  sid: string,
  project: string,
  id: string,
  command: string,
  decision: "allow" | "deny",
) => {
  const input = { command }
  await hook(sid, project, "PreToolUse", { tool_name: "Bash", tool_use_id: id, tool_input: input })
  await decide(sid, decision)
  if (decision === "allow") await tool(sid, project, "Bash", input)
}

// 1 · Two questions via AskUserQuestion, with a subagent tree.
const s1 = "11111111-0000-4000-8000-000000000001"
await session(s1, "order-up-api", "Retry policy for usom calls")
await tool(s1, "order-up-api", "Edit", { file_path: "src/UsomClient.kt" })
await hook(s1, "order-up-api", "SubagentStart", { agent_id: "a-explore", agent_type: "Explore" })
await hook(s1, "order-up-api", "SubagentStop", { agent_id: "a-explore", agent_type: "Explore" })
await hook(s1, "order-up-api", "SubagentStart", {
  agent_id: "a-test",
  agent_type: "test-runner",
})
await tool(s1, "order-up-api", "Bash", { command: "./gradlew test" })
await hook(s1, "order-up-api", "PreToolUse", {
  tool_name: "AskUserQuestion",
  tool_use_id: "q1",
  tool_input: {
    questions: [
      {
        question: "Which integration tests should I run before opening the PR?",
        header: "Tests",
        options: [
          { label: "Only Usom tests" },
          { label: "Full integration suite" },
          { label: "Skip — I'll run them" },
        ],
      },
      {
        question: "How many retries on a 5xx before the breaker counts it as a failure?",
        header: "Retries",
        options: [{ label: "2 (recommended)" }, { label: "3" }],
      },
    ],
  },
})

// 2 · A held permission request.
const s2 = "22222222-0000-4000-8000-000000000002"
await session(s2, "ravelo-insights", "POS export ingestion")
await decidedBash(s2, "ravelo-insights", "b0", "bun install --frozen-lockfile", "allow")
await tool(s2, "ravelo-insights", "Write", { file_path: "migrations/004_pos.sql" })
await hook(s2, "ravelo-insights", "PreToolUse", {
  tool_name: "Bash",
  tool_use_id: "b1",
  tool_input: { command: "bun run migrate", description: "Apply the new migration" },
})

// 3 · A clean stop → ready to review (CLI session).
const s3 = "33333333-0000-4000-8000-000000000003"
await session(s3, "simple-offline-pos", "Add receipt reprint button", "cli")
await tool(s3, "simple-offline-pos", "Edit", { file_path: "src/Receipt.tsx" })
await hook(
  s3,
  "simple-offline-pos",
  "Stop",
  { last_assistant_message: "Added a Reprint button; tests pass." },
  "cli",
)

// 4 · Still working.
const s4 = "44444444-0000-4000-8000-000000000004"
await session(s4, "agent-kit", "Session tree parser")
await hook(s4, "agent-kit", "PreToolUse", {
  tool_name: "AskUserQuestion",
  tool_use_id: "q4",
  tool_input: {
    questions: [
      {
        question: "Should the parser keep sidechain messages in the tree?",
        header: "Sidechains",
        options: [{ label: "Keep them, collapsed" }, { label: "Drop them" }],
      },
    ],
  },
})
await answer(s4, ["Keep them, collapsed"])
await tool(s4, "agent-kit", "Read", { file_path: "src/tree.ts" })

// 5 · Held Edit against a real file under the throwaway home → a real diff (D-056), with
// a transcript so the card can quote what Claude said first.
const s5 = "55555555-0000-4000-8000-000000000005"
await session(s5, "order-up-api", "Validate delivery windows")
const windowTs = join(proj("order-up-api"), "src", "window.ts")
mkdirSync(join(proj("order-up-api"), "src"), { recursive: true })
writeFileSync(
  windowTs,
  [
    'import { addMinutes } from "date-fns"',
    "",
    "export const DEFAULT_PREP_MINUTES = 15",
    "",
    "export const deliveryWindow = (order: Order, now: Date) => {",
    "  const start = addMinutes(now, order.prepMinutes ?? DEFAULT_PREP_MINUTES)",
    "  const end = addMinutes(start, 30)",
    "  return { start, end }",
    "}",
    "",
  ].join("\n"),
)
const transcript = join(home, "transcript-s5.jsonl")
writeFileSync(
  transcript,
  `${[
    { type: "user", message: { role: "user", content: "Validate delivery windows" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "The window end is hard-coded to 30 minutes. I'll make it configurable and reject windows that end before they start.",
          },
          { type: "tool_use", id: "e1", name: "Edit" },
        ],
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n")}\n`,
)
await hook(s5, "order-up-api", "PreToolUse", {
  tool_name: "Edit",
  tool_use_id: "e1",
  transcript_path: transcript,
  tool_input: {
    file_path: windowTs,
    old_string: "  const end = addMinutes(start, 30)\n  return { start, end }",
    new_string: [
      "  const end = addMinutes(start, order.windowMinutes ?? 30)",
      "  if (end <= start) throw new WindowError(order.id)",
      "  return { start, end }",
    ].join("\n"),
  },
})

// 6 · Held Write of a new file, and a held WebFetch.
const s6 = "66666666-0000-4000-8000-000000000006"
await session(s6, "agent-kit", "Changelog script", "cli")
await hook(
  s6,
  "agent-kit",
  "PreToolUse",
  {
    tool_name: "Write",
    tool_use_id: "w1",
    tool_input: {
      file_path: join(proj("agent-kit"), "scripts", "changelog.ts"),
      content: 'import { $ } from "bun"\n\nconsole.log(await $`git log --oneline -n 20`.text())\n',
    },
  },
  "cli",
)
await hook(
  s6,
  "agent-kit",
  "PreToolUse",
  {
    tool_name: "WebFetch",
    tool_use_id: "f1",
    tool_input: {
      url: "https://keepachangelog.com/en/1.1.0/",
      prompt: "Which section headings does the format use?",
    },
  },
  "cli",
)

// 7 · Older, finished sessions for History: each ended, then moved back in time below.
const past: Array<[sid: string, project: string, daysAgo: number]> = []
const pastSession = async (n: number, project: string, prompt: string, daysAgo: number) => {
  const sid = `7777777${n}-0000-4000-8000-00000000000${n}`
  await session(sid, project, prompt)
  past.push([sid, project, daysAgo])
  return sid
}
const h1 = await pastSession(1, "order-up-api", "Rotate the staging API keys", 1)
await decidedBash(h1, "order-up-api", "p1", "git push --force origin main", "deny")
await decidedBash(h1, "order-up-api", "p2", "./gradlew test --tests KeyRotationTest", "allow")
await hook(h1, "order-up-api", "Stop", { last_assistant_message: "Keys rotated; tests pass." })
await hook(h1, "order-up-api", "UserPromptSubmit", { prompt: "Now update the runbook" })

const h2 = await pastSession(2, "agent-kit", "Pick a test runner", 1)
await hook(h2, "agent-kit", "PreToolUse", {
  tool_name: "AskUserQuestion",
  tool_use_id: "q7",
  tool_input: {
    questions: [
      {
        question: "Which test runner should the kit ship with?",
        header: "Runner",
        options: [{ label: "bun test" }, { label: "Vitest" }],
      },
    ],
  },
})
await answer(h2, ["bun test"])

const h3 = await pastSession(3, "ravelo-insights", "Nightly export job", 3)
// Asked in Claude and answered there: the inbox only watched.
const exportCmd = { command: "aws s3 sync ./export s3://ravelo-exports/nightly" }
await hook(h3, "ravelo-insights", "PreToolUse", {
  tool_name: "Bash",
  tool_use_id: "p3",
  tool_input: exportCmd,
})
await tool(h3, "ravelo-insights", "Bash", exportCmd)
await hook(h3, "ravelo-insights", "Stop", { last_assistant_message: "Export job scheduled." })
await api("POST", `/v1/items/${await openItem(h3, "review")}/dismiss`)

const h4 = await pastSession(4, "simple-offline-pos", "Offline sync retries", 6)
await decidedBash(h4, "simple-offline-pos", "p4", "rm -rf node_modules/.cache", "allow")
await hook(h4, "simple-offline-pos", "Stop", {
  last_assistant_message: "Sync now retries with backoff.",
})
await hook(h4, "simple-offline-pos", "UserPromptSubmit", { prompt: "Add a test for the backoff" })

for (const [sid, project] of past) await hook(sid, project, "SessionEnd", { reason: "other" })
// The daemon stamps everything with the real clock; date the finished sessions by hand.
// Only this throwaway database is touched.
const db = new Database(paths(home).db)
db.exec("PRAGMA busy_timeout = 2000")
for (const [sid, , daysAgo] of past) {
  const back = daysAgo * 24 * 3600_000 + sid.charCodeAt(7) * 60_000
  db.query(
    `UPDATE attention_items SET created_at = created_at - ?1, updated_at = updated_at - ?1,
       answered_at = answered_at - ?1 WHERE session_id = ?2`,
  ).run(back, sid)
  db.query(
    `UPDATE approvals SET decided_at = decided_at - ?1
      WHERE item_id IN (SELECT id FROM attention_items WHERE session_id = ?2)`,
  ).run(back, sid)
  db.query(
    "UPDATE sessions SET created_at = created_at - ?1, last_event_at = last_event_at - ?1 WHERE id = ?2",
  ).run(back, sid)
}
db.close()

// `?k=` proves the page may have the token (D-095); without it the daemon serves a notice.
const k = encodeURIComponent(c.token)
console.log(`\nSession Inbox demo running: http://127.0.0.1:${c.httpPort}/?k=${k}`)
console.log(`  compact: http://127.0.0.1:${c.httpPort}/?view=compact&k=${k}`)
console.log(`  home:    ${home}`)
console.log("  approvals stay answerable for 10 minutes, then wait in Claude. Ctrl-C to stop.\n")
await daemon.exited
