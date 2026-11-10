/**
 * Number settings the daemon may report before these contracts list them (U-036). Decoding
 * `SettingsResponse` drops unknown keys, so the HTTP client copies these back from the raw
 * body when they are finite numbers; the pane shows a field only when its key is present.
 * Once the key is in `UserSettings` the copy is a no-op.
 */
import type { SettingsResponse } from "@session-inbox/contracts"

export const EXTRA_NUMBER_SETTINGS = ["storage.retentionDays"] as const
export type ExtraNumberSetting = (typeof EXTRA_NUMBER_SETTINGS)[number]

const numbersFrom = (raw: unknown): Record<string, number> => {
  if (raw === null || typeof raw !== "object") return {}
  const out: Record<string, number> = {}
  for (const key of EXTRA_NUMBER_SETTINGS) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value
    }
  }
  return out
}

export const withExtraSettings = (raw: unknown, response: SettingsResponse): SettingsResponse => {
  if (raw === null || typeof raw !== "object") return response
  const body = raw as { settings?: unknown; defaults?: unknown }
  return {
    ...response,
    settings: { ...numbersFrom(body.settings), ...response.settings },
    defaults: { ...numbersFrom(body.defaults), ...response.defaults },
  }
}
