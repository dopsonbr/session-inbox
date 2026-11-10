import { describe, expect, test } from "bun:test"
import type { StreamMessage } from "@session-inbox/contracts"
import { deliveryRoute, SHELL_REPORT_GRACE_MS } from "../src/delivery.ts"
import { envelope, type Harness, makeClassicHarness as makeHarness } from "./fakes.ts"

const SID = "cccccccc-0000-4000-8000-000000000001"
const base = { session_id: SID, cwd: "/work/x" }

describe("delivery truth table (D-062)", () => {
  const r = (
    shellConnected: boolean,
    permission: Parameters<typeof deliveryRoute>[0]["permission"],
    connectedForMs: number,
    fallback: boolean,
  ) => deliveryRoute({ shellConnected, permission, connectedForMs, fallback })
  test.each([
    [false, null, 0, true, "fallback"],
    [false, null, 0, false, "none"],
    [true, "authorized", 0, true, "shell"],
    [true, "provisional", 99_999, true, "shell"],
    [true, "authorized", 0, false, "shell"],
    [true, "denied", 0, true, "fallback"],
    [true, "notDetermined", 0, true, "fallback"],
    [true, "denied", 0, false, "none"],
    [true, null, 0, true, "shell-unverified"],
    [true, null, SHELL_REPORT_GRACE_MS - 1, false, "shell-unverified"],
    [true, null, SHELL_REPORT_GRACE_MS, true, "both"],
    [true, null, SHELL_REPORT_GRACE_MS, false, "shell"],
    [true, "unknown", 0, true, "both"],
    [true, "unknown", 0, false, "shell"],
  ] as const)("connected=%p permission=%p for=%p fallback=%p → %p", (c, p, ms, fb, want) => {
    expect(r(c, p, ms, fb)).toBe(want)
  })
})

/** A fake shell client on the hub; returns the messages it received. */
const connectShell = (h: Harness) => {
  const msgs: StreamMessage[] = []
  const unsubscribe = h.engine.hub.subscribe(
    {
      kind: "shell",
      send: (frame) => {
        const data = frame.split("\n").find((l) => l.startsWith("data: "))
        if (data) msgs.push(JSON.parse(data.slice(6)) as StreamMessage)
      },
    },
    null,
    h.engine.store.maxSeq(),
  )
  return { msgs, unsubscribe, notifies: () => msgs.filter((m) => m._tag === "notify") }
}

const permissionPrompt = (h: Harness) =>
  h.engine.ingest(
    "Notification",
    envelope("Notification", {
      ...base,
      notification_type: "permission_prompt",
      message: "Claude needs your permission to use Bash",
    }),
  )

const heldBash = (h: Harness, id = "tu1") =>
  h.engine.ingest(
    "PreToolUse",
    envelope("PreToolUse", {
      ...base,
      tool_name: "Bash",
      tool_use_id: id,
      tool_input: { command: "rm -rf build" },
    }),
  )

const notificationRows = (h: Harness) =>
  h.engine.deps.db.query("SELECT id, state, channel FROM notifications ORDER BY rowid").all() as {
    id: string
    state: string
    channel: string | null
  }[]

const shellEvents = (h: Harness) =>
  h.engine.deps.db.query("SELECT payload_json FROM events WHERE hook = 'daemon:shell-status'").all()

describe("notification delivery through the engine", () => {
  test("authorized app: shell only, never the fallback", async () => {
    const h = makeHarness()
    const shell = connectShell(h)
    h.engine.reportShellStatus({ notifications: "authorized", alertStyle: "alert" })
    await permissionPrompt(h)
    h.clock.advance(SHELL_REPORT_GRACE_MS * 2)
    h.engine.tick()
    await h.engine.idle()
    expect(shell.notifies()).toHaveLength(1)
    expect(h.notifier.posted).toHaveLength(0)
    expect(notificationRows(h)[0]?.channel).toBe("shell")
  })

  test("denied app: fallback only; the status is recorded once per change", async () => {
    const h = makeHarness()
    const shell = connectShell(h)
    h.engine.reportShellStatus({ notifications: "denied" })
    h.engine.reportShellStatus({ notifications: "denied" })
    expect(shellEvents(h)).toHaveLength(1)
    await permissionPrompt(h)
    await h.engine.idle()
    expect(shell.notifies()).toHaveLength(0)
    expect(h.notifier.posted).toHaveLength(1)
    expect(notificationRows(h)[0]?.channel).toBe("osascript")
    h.engine.reportShellStatus({ notifications: "authorized" })
    expect(shellEvents(h)).toHaveLength(2)
  })

  test("an app that hasn't reported yet: shell now, fallback after the grace period", async () => {
    const h = makeHarness()
    const shell = connectShell(h)
    await permissionPrompt(h)
    await h.engine.idle()
    expect(shell.notifies()).toHaveLength(1)
    expect(h.notifier.posted).toHaveLength(0)
    h.clock.advance(SHELL_REPORT_GRACE_MS)
    h.engine.tick()
    await h.engine.idle()
    expect(h.notifier.posted).toHaveLength(1)
    expect(notificationRows(h)[0]?.channel).toBe("both")
    // Only once.
    h.clock.advance(60_000)
    h.engine.tick()
    await h.engine.idle()
    expect(h.notifier.posted).toHaveLength(1)
  })

  test("reporting authorized within the grace period cancels the fallback", async () => {
    const h = makeHarness()
    connectShell(h)
    await permissionPrompt(h)
    h.engine.reportShellStatus({ notifications: "authorized" })
    h.clock.advance(SHELL_REPORT_GRACE_MS * 2)
    h.engine.tick()
    await h.engine.idle()
    expect(h.notifier.posted).toHaveLength(0)
  })

  test("reporting denied within the grace period sends the fallback at once", async () => {
    const h = makeHarness()
    connectShell(h)
    await permissionPrompt(h)
    h.engine.reportShellStatus({ notifications: "denied" })
    await h.engine.idle()
    expect(h.notifier.posted).toHaveLength(1)
  })

  test("an older app that never reports gets both", async () => {
    const h = makeHarness()
    const shell = connectShell(h)
    h.clock.advance(SHELL_REPORT_GRACE_MS + 1)
    await permissionPrompt(h)
    await h.engine.idle()
    expect(shell.notifies()).toHaveLength(1)
    expect(h.notifier.posted).toHaveLength(1)
  })

  test("disconnecting resets the status to unknown", async () => {
    const h = makeHarness()
    const shell = connectShell(h)
    h.engine.reportShellStatus({ notifications: "authorized" })
    shell.unsubscribe()
    expect(h.engine.shellStatus()).toEqual({ connected: false, status: null, connectedAt: null })
    await permissionPrompt(h)
    await h.engine.idle()
    expect(h.notifier.posted).toHaveLength(1)
  })

  test("fallback off and denied: pending until the app is allowed (D-019)", async () => {
    const h = makeHarness({ settings: { "notifications.fallback": false } })
    const shell = connectShell(h)
    h.engine.reportShellStatus({ notifications: "denied" })
    await permissionPrompt(h)
    await h.engine.idle()
    expect(notificationRows(h)[0]?.state).toBe("pending")
    expect(shell.notifies()).toHaveLength(0)
    h.engine.reportShellStatus({ notifications: "authorized" })
    expect(shell.notifies()).toHaveLength(1)
    expect(notificationRows(h)[0]).toMatchObject({ state: "posted", channel: "shell" })
    expect(h.notifier.posted).toHaveLength(0)
  })

  test("a decision sends unnotify for what the app was given", async () => {
    const h = makeHarness()
    const shell = connectShell(h)
    h.engine.reportShellStatus({ notifications: "authorized" })
    await heldBash(h)
    const n = shell.notifies()[0]
    const itemId = n?._tag === "notify" ? n.notification.itemId : ""
    h.engine.decide(itemId, "allow", "k1")
    const un = shell.msgs.find((m) => m._tag === "unnotify")
    expect(un?._tag === "unnotify" && un.ids).toEqual([
      n?._tag === "notify" ? n.notification.id : "",
    ])
    expect(notificationRows(h)[0]?.state).toBe("cleared")
  })

  test("superseded, dismissed and expired items unnotify too", async () => {
    const h = makeHarness()
    const shell = connectShell(h)
    h.engine.reportShellStatus({ notifications: "authorized" })
    const count = () => shell.msgs.filter((m) => m._tag === "unnotify").length
    // Supersede: an idle question, then the user typed in Claude.
    await h.engine.ingest(
      "Notification",
      envelope("Notification", { ...base, notification_type: "idle_prompt", message: "Waiting" }),
    )
    await h.engine.ingest(
      "UserPromptSubmit",
      envelope("UserPromptSubmit", { ...base, prompt: "carry on" }),
    )
    expect(count()).toBe(1)
    // Dismiss.
    await heldBash(h, "tu2")
    const item = h.engine.snapshot().items.find((i) => i.live)
    h.engine.dismiss(item?.id ?? "")
    expect(count()).toBe(2)
    // Hold expiry.
    await heldBash(h, "tu3")
    h.clock.advance(h.engine.settings["holds.budgetMs"] + 1)
    h.engine.tick()
    expect(count()).toBe(3)
  })

  test("the test notification takes the same route, with no row", async () => {
    const h = makeHarness()
    expect(h.engine.testNotification().via).toBe("fallback")
    await h.engine.idle()
    expect(h.notifier.posted[0]?.title).toBe("Session Inbox test notification")
    const shell = connectShell(h)
    h.engine.reportShellStatus({ notifications: "authorized" })
    expect(h.engine.testNotification().via).toBe("shell")
    const n = shell.notifies()[0]
    expect(n?._tag === "notify" && n.notification.itemId).toBe("setup")
    expect(n?._tag === "notify" && n.notification.actions).toEqual(["open"])
    expect(notificationRows(h)).toHaveLength(0)
    const id = n?._tag === "notify" ? n.notification.id : ""
    expect((await h.engine.notificationActed(id, "click")).ok).toBe(true)
    h.engine.reportShellStatus({ notifications: "denied" })
    expect(h.engine.testNotification().via).toBe("fallback")
    h.engine.updateSettings({ "notifications.fallback": false })
    expect(h.engine.testNotification().via).toBe("none")
  })
})
