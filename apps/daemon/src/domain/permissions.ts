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
  const [, ruleTool, spec] = m
  if (ruleTool !== tool) return false
  if (spec === undefined || spec === "" || spec === "*") return true
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

/** The rule "Always allow" writes: Bash → `Bash(<exact command>)`, others → the tool name. */
export const allowAlwaysRule = (tool: string, input: unknown): string => {
  if (tool === "Bash") {
    const cmd = ruleSpecifier(tool, input)
    if (cmd) return `Bash(${cmd})`
  }
  return tool
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
