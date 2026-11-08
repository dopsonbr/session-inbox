/**
 * Run the real daemon on a throwaway home, seed it with a realistic set of
 * sessions through the hook socket, and keep it running so you can click
 * around the built UI. Needs no Claude account; touches nothing outside
 * /tmp/si-demo-*.
 *
 *   bun run --cwd apps/desktop build   # once, so there is a UI to serve
 *   bun scripts/demo.ts                # prints the URL; Ctrl-C to stop
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Connection } from "../packages/contracts/src/index.ts"

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
process.on("SIGINT", () => {
  cleanup()
  process.exit(0)
})

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

const hook = async (
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

const session = async (sid: string, project: string, prompt: string, entrypoint?: string) => {
  await hook(sid, project, "SessionStart", { source: "startup" }, entrypoint)
  await hook(sid, project, "UserPromptSubmit", { prompt }, entrypoint)
}
const tool = (sid: string, project: string, name: string, input: Record<string, unknown>) =>
  hook(sid, project, "PostToolUse", { tool_name: name, tool_input: input, tool_response: {} })

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
          { label: "Only *Usom* tests" },
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
await tool(s4, "agent-kit", "Read", { file_path: "src/tree.ts" })

console.log(`\nSession Inbox demo running: http://127.0.0.1:${c.httpPort}/`)
console.log(`  compact: http://127.0.0.1:${c.httpPort}/?view=compact`)
console.log("  held hooks lapse to 'ask' after 120 s. Ctrl-C to stop.\n")
await daemon.exited
