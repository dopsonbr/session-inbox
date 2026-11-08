// bun run.ts <dir> <logfile> [--decision <json>] -- <claude args...>
// Runs claude with a clean env (no CLAUDECODE etc.), prints stdout. Hooks log to <logfile>.
const a = process.argv.slice(2)
const dir = a[0]!
const log = a[1]!
let rest = a.slice(2)
let decision: string | undefined
if (rest[0] === "--decision") {
  decision = rest[1]
  rest = rest.slice(2)
}
if (rest[0] === "--") rest = rest.slice(1)
const env: Record<string, string> = {
  HOME: process.env.HOME ?? "",
  PATH: process.env.PATH ?? "",
  USER: process.env.USER ?? "",
  TERM: "xterm-256color",
  SPIKE_LOG: log,
}
if (process.env.SPIKE_INHERIT) {
  // inherit parent env (auth proxy etc.) minus the vars that mark a nested session
  const drop = new Set(
    (
      process.env.SPIKE_DROP ??
      "CLAUDECODE,CLAUDE_CODE_ENTRYPOINT,CLAUDE_CODE_SESSION_ID,CLAUDE_CODE_HOST_SESSION_ID,CLAUDE_CODE_CHILD_SESSION,CLAUDE_CODE_SIMPLE,CLAUDE_CODE_MESSAGING_SOCKET,CLAUDE_CODE_MESSAGING_TOKEN"
    ).split(","),
  )
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !drop.has(k)) env[k] = v
  env.SPIKE_LOG = log
}
if (decision) env.SPIKE_DECISION = decision
for (const [k, v] of Object.entries(process.env))
  if (k.startsWith("EXTRA_") && v) env[k.slice(6)] = v
const t0 = Date.now()
const p = Bun.spawn(["claude", ...rest], {
  cwd: dir,
  env,
  stdout: "pipe",
  stderr: "pipe",
  stdin: "ignore",
})
const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
await p.exited
console.log(out)
if (err) console.error("STDERR:", err)
console.error(`exit=${p.exitCode} ms=${Date.now() - t0}`)
