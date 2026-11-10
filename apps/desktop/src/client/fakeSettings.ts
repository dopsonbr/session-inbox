/**
 * The fake daemon's settings (U-004): just enough of the daemon's PUT /v1/settings
 * (clamp, reset with null, reject unknown keys) for `dev:mock` and tests.
 */
import {
  HOLDABLE_TOOLS,
  normalizeShortcut,
  SETTING_LIMITS,
  type SettingsResponse,
  SHORTCUT_ACTIONS,
  SHORTCUT_DEFAULTS,
  shortcutActionOf,
  shortcutProblem,
  shortcutSettingKey,
  USER_SETTING_KEYS,
  type UserSettings,
  type UserSettingsPatch,
} from "@session-inbox/contracts"
import { Effect } from "effect"
import { DaemonError } from "./daemonClient.ts"
import { EXTRA_NUMBER_SETTINGS } from "./extraSettings.ts"

// `storage.retentionDays` is the daemon's; until contracts list it, the fake reports it
// as an extra key the way a newer daemon would (U-036). `as` keeps this compiling either way.
export const FAKE_SETTING_DEFAULTS = {
  "holds.enabled": true,
  "holds.via": "permissionRequest",
  "holds.requestBudgetMs": 600_000,
  "holds.tools": [...HOLDABLE_TOOLS],
  "holds.budgetMs": 120_000,
  "holds.safeBashPrefixes": ["ls", "pwd", "echo", "cat", "git status", "git diff", "git log"],
  "notifications.fallback": true,
  "notifications.reviewGroupMs": 30_000,
  "titles.generate": true,
  "updates.check": true,
  "updates.auto": true,
  "storage.retentionDays": 14,
  "stuck.enabled": true,
  "stuck.afterMs": 300_000,
  "shortcuts.jump": SHORTCUT_DEFAULTS.jump,
  "shortcuts.submit": SHORTCUT_DEFAULTS.submit,
  "shortcuts.deny": SHORTCUT_DEFAULTS.deny,
  "shortcuts.next": SHORTCUT_DEFAULTS.next,
  "shortcuts.previous": SHORTCUT_DEFAULTS.previous,
  "shortcuts.done": SHORTCUT_DEFAULTS.done,
  "shortcuts.settings": SHORTCUT_DEFAULTS.settings,
  "shortcuts.help": SHORTCUT_DEFAULTS.help,
  "shortcuts.openInbox": SHORTCUT_DEFAULTS.openInbox,
} as UserSettings

const EXTRA_LIMITS: Record<string, { min: number; max: number }> = {
  "storage.retentionDays": { min: 1, max: 365 },
}

const KNOWN_KEYS: ReadonlyArray<string> = [...USER_SETTING_KEYS, ...EXTRA_NUMBER_SETTINGS]

const tidy = (key: string, value: unknown): unknown => {
  const action = shortcutActionOf(key)
  if (action !== null && typeof value === "string") {
    return normalizeShortcut(action, value) ?? ""
  }
  const limits =
    (SETTING_LIMITS as Record<string, { min: number; max: number }>)[key] ?? EXTRA_LIMITS[key]
  if (limits !== undefined && typeof value === "number") {
    return Math.round(Math.min(limits.max, Math.max(limits.min, value)))
  }
  return value
}

/** Every action's key press, as the stream's `shortcuts` message carries them. */
export const shortcutBindingsOf = (settings: UserSettings): Record<string, string> =>
  Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a, settings[shortcutSettingKey(a)]]))

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
        const unknown = Object.keys(patch).filter((k) => !KNOWN_KEYS.includes(k))
        if (unknown.length > 0) {
          return Effect.fail(
            new DaemonError({ message: `Unknown setting ${unknown.join(", ")}`, status: 400 }),
          )
        }
        // Like the daemon (C-029): a key press the app can't bind is a 400 naming the key.
        for (const [key, value] of Object.entries(patch)) {
          const action = shortcutActionOf(key)
          const problem =
            action === null || typeof value !== "string"
              ? null
              : shortcutProblem(action, value.trim())
          if (problem !== null) {
            return Effect.fail(new DaemonError({ message: `${key}: ${problem}`, status: 400 }))
          }
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
