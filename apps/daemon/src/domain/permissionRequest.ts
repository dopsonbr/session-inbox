/**
 * Pure helpers for Claude's PermissionRequest hook (D-068..D-071): matching a request to its
 * tool call, and what "Always allow" echoes back.
 */
import { createHash } from "node:crypto"

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
      Array.isArray(s.rules) &&
      s.rules.length > 0 &&
      s.rules.every((r) => isRecord(r) && typeof r.toolName === "string" && r.toolName !== "") &&
      !JSON.stringify(s).includes("bypassPermissions"),
  )
}
