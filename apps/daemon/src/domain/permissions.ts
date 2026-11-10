/**
 * "Would Claude itself have asked?" — permission rule matching against Claude's
 * own settings files, plus the allow-always writer.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** The string a rule's `(…)` part is compared with, per tool. */
export const ruleSpecifier = (tool: string, input: unknown): string | null => {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === "string" ? v : null)
  switch (tool) {
    case "Bash":
      return str(i.command)
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "Read":
      return str(i.file_path)
    case "NotebookEdit":
      return str(i.notebook_path)
    case "WebFetch": {
      const url = str(i.url)
      if (!url) return null
      try {
        return `domain:${new URL(url).hostname}`
      } catch {
        return null
      }
    }
    default:
      return null
  }
}

/**
 * Supports `Tool`, `Tool(exact)`, `Tool(prefix:*)` and `Tool(prefix*)`.
 * Path globs beyond a trailing `*`/`**` are not interpreted (D-0xx).
 */
export const ruleMatches = (rule: string, tool: string, input: unknown): boolean => {
  const m = /^([A-Za-z0-9_\-.]+)(?:\((.*)\))?$/s.exec(rule.trim())
  if (!m) return false
  const [, ruleTool, rawSpec] = m
  if (ruleTool !== tool) return false
  if (rawSpec === undefined || rawSpec === "" || rawSpec === "*") return true
  // `//abs/path` is Claude's filesystem-absolute path form (D-082): compare as `/abs/path`.
  const spec =
    ruleTool && FILE_TOOLS.has(ruleTool) && rawSpec.startsWith("//") ? rawSpec.slice(1) : rawSpec
  const actual = ruleSpecifier(tool, input)
  if (actual === null) return false
  if (spec.endsWith(":*")) return actual.startsWith(spec.slice(0, -2))
  if (spec.endsWith("**")) return actual.startsWith(spec.slice(0, -2))
  if (spec.endsWith("*")) return actual.startsWith(spec.slice(0, -1))
  return actual === spec
}

interface PermissionLists {
  allow: string[]
  deny: string[]
}

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
  } catch {
    return null
  }
}

const listsOf = (json: Record<string, unknown> | null): PermissionLists => {
  const p = (json?.permissions ?? {}) as Record<string, unknown>
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : [])
  return { allow: arr(p.allow), deny: arr(p.deny) }
}

export const settingsFiles = (claudeConfigDir: string, projectDirs: ReadonlyArray<string>) => {
  const files = [join(claudeConfigDir, "settings.json")]
  for (const dir of new Set(projectDirs)) {
    files.push(join(dir, ".claude", "settings.json"), join(dir, ".claude", "settings.local.json"))
  }
  return files
}

export type RuleVerdict = "allow" | "deny" | "none"

/** deny wins over allow, as in Claude. */
export const ruleVerdict = (
  claudeConfigDir: string,
  projectDirs: ReadonlyArray<string>,
  tool: string,
  input: unknown,
): RuleVerdict => {
  const all: PermissionLists = { allow: [], deny: [] }
  for (const f of settingsFiles(claudeConfigDir, projectDirs)) {
    const l = listsOf(readJson(f))
    all.allow.push(...l.allow)
    all.deny.push(...l.deny)
  }
  if (all.deny.some((r) => ruleMatches(r, tool, input))) return "deny"
  if (all.allow.some((r) => ruleMatches(r, tool, input))) return "allow"
  return "none"
}

/** File tools whose rules take a path (`Tool(<path rule>)`). */
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Read"])
/** An MCP tool name with server and tool parts: on its own it is already one tool's rule. */
export const MCP_TOOL = /^mcp__[^_].*__[^_].*$/
/** Characters that would make a rule wider than the one call (globs, wildcards, new lines). */
const WIDENS = /[*?[\]{}\\\n\r\0]/

/**
 * The rule "Always allow" writes when Claude offers none we can echo (D-082), always scoped to
 * the call itself, or null when Always allow isn't offered:
 * - file tools → `Tool(//abs/path)`: exactly that file, in Claude's syntax for a filesystem-
 *   absolute path (as in its own suggestion `Read(//tmp/proj/**)`);
 * - `WebFetch` → `WebFetch(domain:<host>)`; `Bash` → `Bash(<exact command>)`;
 * - an MCP tool → its own name; anything else → null. Never a bare tool name that takes a
 *   specifier, and never text that a glob or wildcard would widen.
 */
export const scopedAllowRule = (tool: string, input: unknown): string | null => {
  const spec = ruleSpecifier(tool, input)
  if (FILE_TOOLS.has(tool)) {
    if (!spec?.startsWith("/") || WIDENS.test(spec)) return null
    return `${tool}(/${spec})`
  }
  if (tool === "WebFetch") return spec && !WIDENS.test(spec) ? `WebFetch(${spec})` : null
  if (tool === "Bash") {
    return spec?.trim() && !WIDENS.test(spec) ? `Bash(${spec})` : null
  }
  return MCP_TOOL.test(tool) ? tool : null
}

/**
 * Append `rule` to `<projectDir>/.claude/settings.local.json` permissions.allow,
 * preserving everything else in the file. Atomic write via rename.
 */
export const appendAllowRule = (projectDir: string, rule: string): void => {
  const file = join(projectDir, ".claude", "settings.local.json")
  let json: Record<string, unknown> = {}
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      json = parsed as Record<string, unknown>
    else throw new Error(`${file} is not a JSON object; refusing to overwrite`)
  }
  const permissions =
    json.permissions && typeof json.permissions === "object"
      ? (json.permissions as Record<string, unknown>)
      : {}
  const allow = Array.isArray(permissions.allow) ? [...permissions.allow] : []
  if (!allow.includes(rule)) allow.push(rule)
  json.permissions = { ...permissions, allow }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.inboxd-${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`)
  renameSync(tmp, file)
}
