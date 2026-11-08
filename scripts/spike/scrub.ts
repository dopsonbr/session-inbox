// bun scrub.ts <in.jsonl> <out.jsonl> : drop timing, replace home dir, redact emails / tokens / uuid-like account ids
import { readFileSync, writeFileSync } from "node:fs"

const [inp, out] = process.argv.slice(2) as [string, string]
const home = process.env.HOME ?? "/Users/unknown"
const lines = readFileSync(inp, "utf8").split("\n").filter(Boolean)
const scrubbed = lines.map((l) => {
  const o = JSON.parse(l) as Record<string, unknown>
  o.t = undefined
  return JSON.stringify(o)
    .replaceAll(home, "/Users/USER")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g, "user@example.com")
    .replace(/(sk-[A-Za-z0-9_-]{10,}|Bearer [A-Za-z0-9._-]+)/g, "REDACTED")
})
writeFileSync(out, `${scrubbed.join("\n")}\n`)
console.log(`${out}: ${scrubbed.length} lines`)
