/**
 * Where a notification goes (D-062). Only the menu-bar app can see its own macOS
 * permission, so it reports it (C-022); until it does, a wrong guess must err towards the
 * user seeing the notification, but never send both when the app is known to be allowed.
 */
import type { NotificationPermission } from "@session-inbox/contracts"

/** An app that connected and hasn't reported within this long is an older app that never will. */
export const SHELL_REPORT_GRACE_MS = 10_000

/**
 * - `shell`: the app only.
 * - `shell-unverified`: the app now; the osascript fallback follows if the app doesn't
 *   report `authorized`/`provisional` within the grace period (or disconnects first).
 * - `both`: the app and the fallback (an app that doesn't report, or reports `unknown`).
 * - `fallback`: osascript only.
 * - `none`: stays pending; re-sent when an allowed app connects or reports (D-019).
 */
export type Route = "shell" | "shell-unverified" | "both" | "fallback" | "none"

export interface DeliveryState {
  readonly shellConnected: boolean
  /** The app's last report since it connected; null = it hasn't reported. */
  readonly permission: NotificationPermission | null
  /** How long the app has been connected. */
  readonly connectedForMs: number
  /** `notifications.fallback`. */
  readonly fallback: boolean
}

export const canShow = (p: NotificationPermission | null): boolean =>
  p === "authorized" || p === "provisional"

export const deliveryRoute = (s: DeliveryState): Route => {
  if (!s.shellConnected) return s.fallback ? "fallback" : "none"
  if (canShow(s.permission)) return "shell"
  if (s.permission === "denied" || s.permission === "notDetermined")
    return s.fallback ? "fallback" : "none"
  if (s.permission === null && s.connectedForMs < SHELL_REPORT_GRACE_MS) return "shell-unverified"
  // Reported "unknown", or an older app that never reports: it may or may not show it.
  return s.fallback ? "both" : "shell"
}
