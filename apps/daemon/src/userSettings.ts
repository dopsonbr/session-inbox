/**
 * The Settings pane's slice of Settings (C-016, D-045): decode a PUT body, clamp and
 * tidy each value, and project the running Settings onto the user-facing keys.
 * The engine applies the result live (`Engine.updateSettings`).
 */
import {
  HOLDABLE_TOOLS,
  type HoldableTool,
  normalizeShortcut,
  SETTING_LIMITS,
  shortcutActionOf,
  shortcutProblem,
  USER_SETTING_KEYS,
  type UserSettingKey,
  type UserSettings,
  UserSettingsPatch,
} from "@session-inbox/contracts"
import { Result, Schema } from "effect"
import type { Settings } from "./settings.ts"

const decodePatchResult = Schema.decodeUnknownResult(UserSettingsPatch)

/** Unknown keys are an error, not silently dropped: a typo should not look like a save. */
export const decodeSettingsPatch = (raw: unknown): Result.Result<UserSettingsPatch, string> => {
  const r = decodePatchResult(raw, { onExcessProperty: "error" })
  if (Result.isFailure(r)) return Result.fail(r.failure.message)
  // A key press the app can't bind is refused, not quietly dropped (C-029).
  for (const [key, value] of Object.entries(r.success)) {
    const action = shortcutActionOf(key)
    if (action === null || typeof value !== "string") continue
    const problem = shortcutProblem(action, value.trim())
    if (problem !== null) return Result.fail(`${key}: ${problem}`)
  }
  return Result.succeed(r.success)
}

const clamp = (key: keyof typeof SETTING_LIMITS, v: number) =>
  Math.round(Math.min(SETTING_LIMITS[key].max, Math.max(SETTING_LIMITS[key].min, v)))

const isHoldable = (t: string): t is HoldableTool =>
  (HOLDABLE_TOOLS as ReadonlyArray<string>).includes(t)

/** One value as the daemon will store it: clamped, deduped, trimmed. */
export const normalizeSetting = <K extends UserSettingKey>(
  key: K,
  value: UserSettings[K],
): UserSettings[K] => {
  switch (key) {
    case "holds.budgetMs":
    case "holds.requestBudgetMs":
    case "notifications.reviewGroupMs":
    case "storage.retentionDays":
      return clamp(key, value as number) as UserSettings[K]
    case "holds.tools": {
      const set = new Set(value as ReadonlyArray<string>)
      return HOLDABLE_TOOLS.filter((t) => set.has(t)) as unknown as UserSettings[K]
    }
    case "holds.safeBashPrefixes": {
      const out: string[] = []
      for (const p of value as ReadonlyArray<string>) {
        const t = p.trim().replace(/\s+/g, " ")
        if (t !== "" && !out.includes(t)) out.push(t)
      }
      return out as unknown as UserSettings[K]
    }
    default: {
      const action = shortcutActionOf(key)
      if (action === null) return value
      // Canonical spelling; an unusable one never gets here (decodeSettingsPatch refuses it).
      return (normalizeShortcut(action, value as string) ?? "") as UserSettings[K]
    }
  }
}

/** The running Settings, seen through the pane. */
export const pickUserSettings = (s: Settings): UserSettings => {
  const out: Record<string, unknown> = {}
  for (const k of USER_SETTING_KEYS) out[k] = s[k]
  out["holds.tools"] = s["holds.tools"].filter(isHoldable)
  return out as UserSettings
}
