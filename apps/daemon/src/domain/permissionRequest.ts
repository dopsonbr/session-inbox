/**
 * Pure helpers for Claude's PermissionRequest hook (D-068..D-071): matching a request to its
 * tool call, and what "Always allow" echoes back.
 */
import { createHash } from "node:crypto"
import { MCP_TOOL } from "./permissions.ts"

/** JSON with object keys sorted at every level, so equal inputs compare equal as text. */
export const canonicalJson = (v: unknown): string => {
  if (v === undefined) return "null"
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null"
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`
}

/** Identity of one call when no tool_use_id is known: tool name + canonical input. */
export const inputKey = (tool: string, input: unknown): string =>
  createHash("sha256")
    .update(`${tool}\n${canonicalJson(input)}`)
    .digest("hex")
    .slice(0, 32)

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

/**
 * The `permission_suggestions` entries an "Always allow" may echo as `updatedPermissions`:
 * `addRules` with `behavior: "allow"` and at least one rule naming a tool. Never `setMode`,
 * `replaceRules`/`removeRules` (they rewrite or drop other rules), directory changes, or
 * anything that mentions `bypassPermissions`. Empty ⇒ the caller falls back to D-014.
 */
export const allowAlwaysPermissions = (suggestions: unknown): unknown[] => {
  if (!Array.isArray(suggestions)) return []
  return suggestions.filter(
    (s) =>
      isRecord(s) &&
      s.type === "addRules" &&
      s.behavior === "allow" &&
      typeof s.destination === "string" &&
      Object.hasOwn(DESTINATION_WORDS, s.destination) &&
      Array.isArray(s.rules) &&
      s.rules.length > 0 &&
      s.rules.every(specificRule) &&
      !JSON.stringify(s).includes("bypassPermissions"),
  )
}

/**
 * A rule naming a tool and saying which calls (D-082): a `ruleContent`, or an MCP tool name with
 * server and tool parts. A bare `Edit` or `Read` would allow every such call.
 */
const specificRule = (r: unknown): boolean =>
  isRecord(r) &&
  typeof r.toolName === "string" &&
  r.toolName !== "" &&
  ((typeof r.ruleContent === "string" && r.ruleContent.trim() !== "") ||
    (r.ruleContent === undefined && MCP_TOOL.test(r.toolName)))

/** Where an `addRules` suggestion saves its rules, in the card's words (C-026). */
export const DESTINATION_WORDS: Record<string, string> = {
  session: "for this session",
  localSettings: "in this project's .claude/settings.local.json",
  projectSettings: "in this project's .claude/settings.json",
  userSettings: "in your user settings (all projects)",
}

/** What the card says Always allow does when it echoes these (already filtered) entries. */
export const describeSuggestions = (entries: ReadonlyArray<unknown>): string =>
  entries
    .filter(isRecord)
    .map((s) => {
      const rules = (s.rules as Array<{ toolName: string; ruleContent?: string }>)
        .map((r) => (r.ruleContent === undefined ? r.toolName : `${r.toolName}(${r.ruleContent})`))
        .join(", ")
      return `${rules} ${DESTINATION_WORDS[String(s.destination)]}`
    })
    .join("; ")
