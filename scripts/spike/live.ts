// bun scripts/spike/live.ts [scenario...]
// Runs the model-dependent Phase 0 experiments (Q1-Q4) against a LOGGED-IN `claude` (run `claude auth status` first).
// Needs a real terminal login or ANTHROPIC_API_KEY: it could not be run inside the agent sandbox (no auth there).
// Each scenario: scratch repo in /tmp/si-spike-<name>, project-local hooks -> record.ts, jsonl in /tmp/si-spike-<name>.jsonl,
// scrubbed copy in fixtures/recorded/<name>.jsonl. Never touches ~/.claude/settings.json.
import { existsSync, rmSync } from "node:fs"
import { resolve } from "node:path"

const here = import.meta.dir
const root = resolve(here, "../..")
const drop = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
])

type Scenario = {
  name: string
  hookTimeout?: number
  decision?: object
  prompt: string
  extra?: string[]
  resumeOf?: string
}
const BASH = "Use the Bash tool to run: echo hi > out.txt . Then reply with exactly: done"
const scenarios: Scenario[] = [
  {
    name: "tools",
    prompt: `${BASH} Then use the Write tool to create note.txt containing hi.`,
    decision: { decision: "allow" },
  },
  {
    name: "tools-deny",
    prompt: BASH,
    decision: {
      decision: "deny",
      reason: "Blocked by Session Inbox test: say the word PINEAPPLE in your reply",
    },
  },
  { name: "tools-ask", prompt: BASH, decision: { decision: "ask" } },
  { name: "tools-noop", prompt: BASH },
  { name: "tools-slow", prompt: BASH, hookTimeout: 20, decision: { decision: "allow", sleep: 10 } },
  {
    name: "tools-timeout",
    prompt: BASH,
    hookTimeout: 5,
    decision: { decision: "allow", sleep: 8 },
  },
  {
    name: "subagent",
    prompt:
      "Use the Agent (Task) tool with a general-purpose subagent to list the files in the current directory, then reply done.",
    decision: { decision: "allow" },
  },
  { name: "resume", prompt: "What file did you create? one word", resumeOf: "tools" },
]

const only = process.argv.slice(2)
const sessionIds: Record<string, string> = {}
for (const s of scenarios) {
  if (only.length && !only.includes(s.name)) continue
  const dir = s.resumeOf ? `/tmp/si-spike-${s.resumeOf}` : `/tmp/si-spike-${s.name}`
  const log = `/tmp/si-spike-${s.name}.jsonl`
  if (existsSync(log)) rmSync(log)
  if (!s.resumeOf)
    Bun.spawnSync(["bun", resolve(here, "mk.ts"), s.name, String(s.hookTimeout ?? 30)])
  const env: Record<string, string> = { SPIKE_LOG: log }
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !drop.has(k)) env[k] = v
  if (s.decision) env.SPIKE_DECISION = JSON.stringify(s.decision)
  const args = [
    "-p",
    s.prompt,
    "--model",
    "haiku",
    "--max-turns",
    "6",
    "--permission-mode",
    "default",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(s.extra ?? []),
  ]
  if (s.resumeOf) args.push("--resume", sessionIds[s.resumeOf] ?? "")
  const t0 = Date.now()
  const p = Bun.spawn(["claude", ...args], {
    cwd: dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const out = await new Response(p.stdout).text()
  await p.exited
  const sid = /"session_id":"([0-9a-f-]{36})"/.exec(out)?.[1]
  if (sid) sessionIds[s.name] = sid
  await Bun.write(`/tmp/si-spike-${s.name}.stream.jsonl`, out)
  console.log(
    `[${s.name}] exit=${p.exitCode} ms=${Date.now() - t0} session=${sid} hookEvents=${existsSync(log) ? (await Bun.file(log).text()).split("\n").filter(Boolean).length : 0}`,
  )
  if (existsSync(log))
    Bun.spawnSync([
      "bun",
      resolve(here, "scrub.ts"),
      log,
      resolve(root, `fixtures/recorded/${s.name}.jsonl`),
    ])
}
console.log(
  "stream-json outputs: /tmp/si-spike-<scenario>.stream.jsonl (read tool_result lines for deny reasons / answers)",
)
