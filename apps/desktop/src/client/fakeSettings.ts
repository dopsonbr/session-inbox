/**
 * The fake daemon's settings (U-004): just enough of the daemon's PUT /v1/settings
 * (clamp, reset with null, reject unknown keys) for `dev:mock` and tests.
 */
import {
  HOLDABLE_TOOLS,
  SETTING_LIMITS,
  type SettingsResponse,
  USER_SETTING_KEYS,
  type UserSettings,
  type UserSettingsPatch,
} from "@session-inbox/contracts"
import { Effect } from "effect"
import { DaemonError } from "./daemonClient.ts"

export const FAKE_SETTING_DEFAULTS: UserSettings = {
  "holds.enabled": true,
  "holds.tools": [...HOLDABLE_TOOLS],
  "holds.budgetMs": 120_000,
  "holds.safeBashPrefixes": ["ls", "pwd", "echo", "cat", "git status", "git diff", "git log"],
  "notifications.fallback": true,
  "notifications.reviewGroupMs": 30_000,
  "titles.generate": true,
  "updates.check": true,
  "updates.auto": true,
  "storage.retentionDays": 14,
}

const tidy = (key: string, value: unknown): unknown => {
  const limits = (SETTING_LIMITS as Record<string, { min: number; max: number }>)[key]
  if (limits !== undefined && typeof value === "number") {
    return Math.round(Math.min(limits.max, Math.max(limits.min, value)))
  }
  return value
}

export const makeFakeSettings = (otherChannel: string | null = "beta") => {
  let settings: UserSettings = { ...FAKE_SETTING_DEFAULTS }
  const response = (): SettingsResponse => ({
    settings,
    defaults: FAKE_SETTING_DEFAULTS,
    channel: "ga",
    otherChannel,
  })
  return {
    getSettings: Effect.sync(response),
    putSettings: (patch: UserSettingsPatch) =>
      Effect.suspend(() => {
        const unknown = Object.keys(patch).filter(
          (k) => !(USER_SETTING_KEYS as ReadonlyArray<string>).includes(k),
        )
        if (unknown.length > 0) {
          return Effect.fail(
            new DaemonError({ message: `Unknown setting ${unknown.join(", ")}`, status: 400 }),
          )
        }
        const next: Record<string, unknown> = { ...settings }
        for (const [key, value] of Object.entries(patch)) {
          next[key] =
            value === null ? FAKE_SETTING_DEFAULTS[key as keyof UserSettings] : tidy(key, value)
        }
        settings = next as UserSettings
        return Effect.succeed(response())
      }),
  }
}
