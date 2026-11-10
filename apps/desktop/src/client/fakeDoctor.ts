/**
 * The fake daemon's setup check (C-021) for `dev:mock` and tests. `?setup=` picks the
 * report: ok (default), attention, firstrun, or none (a daemon without /v1/doctor).
 * The words are stand-ins; the real daemon writes its own.
 */
import type { DoctorCheck, DoctorReport } from "@session-inbox/contracts"
import type { TestNotifyResult } from "./daemonClient.ts"

export type FakeSetup = "ok" | "attention" | "firstrun" | "none"

export const fakeSetupKind = (value: string | null | undefined): FakeSetup =>
  value === "attention" || value === "firstrun" || value === "none" ? value : "ok"

const okChecks: ReadonlyArray<DoctorCheck> = [
  {
    id: "daemon",
    title: "Daemon running",
    status: "ok",
    detail: "Version 0.1.0 (ga), up 3 h, listening on 127.0.0.1:47321.",
  },
  {
    id: "hooks",
    title: "Hooks installed",
    status: "ok",
    detail: "8 hook events in ~/.claude/settings.json point at inbox-hook.",
  },
  {
    id: "events",
    title: "Hook events arriving",
    status: "ok",
    detail: "Last event 2 min ago from order-up-api.",
  },
  {
    id: "holds",
    title: "This install holds tool calls",
    status: "info",
    detail: "The beta install on this Mac only observes.",
  },
  {
    id: "claude-cli",
    title: "claude CLI found and logged in",
    status: "ok",
    detail: "/opt/homebrew/bin/claude 2.4.1. Replies from the inbox can be delivered.",
  },
  {
    id: "app",
    title: "Menu-bar app connected",
    status: "ok",
    detail: "Session Inbox 0.1.0 is connected and allowed to post notifications (banners).",
  },
  {
    id: "notifications",
    title: "Notifications delivered",
    status: "ok",
    detail: "The last notification went out through the menu-bar app 14 min ago.",
  },
  {
    id: "updates",
    title: "Update checks",
    status: "info",
    detail: "On. Last checked 1 h ago; you have the latest release.",
  },
  {
    id: "storage",
    title: "Storage",
    status: "ok",
    detail: "inbox.db is 2.1 MB; history is kept for 30 days.",
  },
]

const replace = (
  checks: ReadonlyArray<DoctorCheck>,
  patches: Record<string, DoctorCheck>,
): ReadonlyArray<DoctorCheck> => checks.map((c) => patches[c.id] ?? c)

const attentionChecks = replace(okChecks, {
  "claude-cli": {
    id: "claude-cli",
    title: "claude CLI isn't logged in",
    status: "warn",
    detail:
      "Replies from the inbox are sent with claude --resume, which needs its own login (the desktop app's doesn't count). Until then, reply in Claude.",
    fix: { label: "Copy login command", kind: "copy", value: "claude /login" },
  },
  notifications: {
    id: "notifications",
    title: "Notifications are turned off for Session Inbox",
    status: "fail",
    detail:
      "macOS is blocking the menu-bar app's notifications, so nothing pops up when a session needs you. Turn them on in System Settings › Notifications › Session Inbox.",
    fix: {
      label: "Open Notification settings",
      kind: "url",
      value: "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
    },
  },
  updates: {
    id: "updates",
    title: "Update checks",
    status: "info",
    detail: "On. See the release notes for what changed.",
    fix: {
      label: "Release notes",
      kind: "url",
      value: "https://github.com/dopsonbr/session-inbox/releases",
    },
  },
})

const firstRunChecks = replace(okChecks, {
  events: {
    id: "events",
    title: "No hook events yet",
    status: "warn",
    detail:
      "The hooks are installed, but no Claude session has sent an event. Sessions that were already open load hooks only when they start: restart them.",
  },
  notifications: {
    id: "notifications",
    title: "No notifications sent yet",
    status: "info",
    detail: "Send a test notification to check that they show up.",
  },
})

export const fakeDoctorReport = (kind: FakeSetup, now: number): DoctorReport | null => {
  if (kind === "none") return null
  const checks =
    kind === "attention" ? attentionChecks : kind === "firstrun" ? firstRunChecks : okChecks
  const attention = checks.filter((c) => c.status === "warn" || c.status === "fail").length
  return {
    generatedAt: now,
    ok: checks.every((c) => c.status !== "fail"),
    attention,
    firstRun: kind === "firstrun",
    checks,
  }
}

export const fakeTestNotify = (kind: FakeSetup): TestNotifyResult =>
  kind === "attention" ? { via: "fallback" } : { via: "shell" }
