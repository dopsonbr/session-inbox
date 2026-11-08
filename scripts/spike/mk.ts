// bun mk.ts <name> [hookTimeoutSeconds] : create /tmp/si-spike-<name> git repo with project-local hooks calling record.ts
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const name = process.argv[2] ?? "x"
const timeout = Number(process.argv[3] ?? 30)
const dir = `/tmp/si-spike-${name}`
mkdirSync(join(dir, ".claude"), { recursive: true })
const rec = resolve(import.meta.dir, "record.ts")
const events = [
  "SessionStart",
  "UserPromptSubmit",
  "Notification",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "SessionEnd",
]
const hooks: Record<string, unknown> = {}
for (const e of events)
  hooks[e] = [{ matcher: "", hooks: [{ type: "command", command: `bun ${rec} ${e}`, timeout }] }]
writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ hooks }, null, 2))
Bun.spawnSync(["git", "init", "-q"], { cwd: dir })
console.log(dir)
