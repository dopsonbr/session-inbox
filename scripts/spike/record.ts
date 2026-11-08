// Phase 0 recorder. Hook command: bun record.ts <Event>
// Env: SPIKE_LOG (jsonl path), SPIKE_DECISION_FILE (json file) or SPIKE_DECISION (inline json):
//   {decision?, reason?, updatedInput?, sleep?: seconds, only?: toolName}
import { appendFileSync, existsSync, readFileSync } from "node:fs"

const event = process.argv[2] ?? "unknown"
const raw = await Bun.stdin.text()
let payload: unknown
try {
  payload = JSON.parse(raw)
} catch {
  payload = { _raw: raw }
}
const log = process.env.SPIKE_LOG ?? "/tmp/si-spike-record.jsonl"
const env = {
  entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
  hostSessionId: process.env.CLAUDE_CODE_HOST_SESSION_ID ?? null,
  claudePid: process.ppid,
}
appendFileSync(log, `${JSON.stringify({ event, payload, env, t: Date.now() })}\n`)

if (event === "PreToolUse") {
  const f = process.env.SPIKE_DECISION_FILE
  const src = process.env.SPIKE_DECISION ?? (f && existsSync(f) ? readFileSync(f, "utf8") : "")
  if (src) {
    const d = JSON.parse(src) as {
      decision?: string
      reason?: string
      updatedInput?: unknown
      sleep?: number
      only?: string
    }
    const tn = (payload as { tool_name?: string }).tool_name
    if (!d.only || d.only === tn) {
      if (d.sleep) await Bun.sleep(d.sleep * 1000)
      if (d.decision) {
        const out: Record<string, unknown> = {
          hookEventName: "PreToolUse",
          permissionDecision: d.decision,
        }
        if (d.reason) out.permissionDecisionReason = d.reason
        if (d.updatedInput) out.updatedInput = d.updatedInput
        console.log(JSON.stringify({ hookSpecificOutput: out }))
      }
    }
  }
}
