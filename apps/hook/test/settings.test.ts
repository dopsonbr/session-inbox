import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildHooks,
  hookHome,
  isOurs,
  mergeHooks,
  type Settings,
  serialize,
  unmergeHooks,
} from "../src/settings.ts"

const HOME = "/Users/me/Library/Application Support/SessionInbox"
const root = join(import.meta.dir, "../../..")

const existing: Settings = {
  model: "opus",
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "/usr/bin/audit", timeout: 3 }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: "say done", timeout: 5 }] }],
    Custom: [{ hooks: [] }],
  },
}

describe("settings merge", () => {
  test("fresh file gets all ten events", () => {
    const out = mergeHooks({}, HOME)
    expect(Object.keys(out.hooks ?? {})).toHaveLength(10)
    expect(out.hooks?.PreToolUse?.[0]?.hooks[0]).toEqual({
      type: "command",
      command: `"${HOME}/bin/inbox-hook" PreToolUse`,
      timeout: 130,
    })
    expect(out.hooks?.PostToolUse?.[0]?.matcher).toBe("*")
    expect(out.hooks?.PermissionRequest).toEqual([
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: `"${HOME}/bin/inbox-hook" PermissionRequest`,
            timeout: 3600,
          },
        ],
      },
    ])
  })

  test("PermissionRequest beside a user's own hook: merged, unmerged, the user's kept", () => {
    const mine: Settings = {
      hooks: {
        PermissionRequest: [
          { matcher: "Bash", hooks: [{ type: "command", command: "/usr/bin/audit", timeout: 3 }] },
        ],
      },
    }
    const merged = mergeHooks(mine, HOME)
    expect(merged.hooks?.PermissionRequest).toHaveLength(2)
    expect(merged.hooks?.PermissionRequest?.[0]).toEqual(mine.hooks?.PermissionRequest?.[0])
    expect(mergeHooks(merged, HOME)).toEqual(merged)
    expect(unmergeHooks(merged)).toEqual(mine)
    // An install from before PermissionRequest existed gains it on re-merge, and loses it again.
    const old = mergeHooks({}, HOME)
    delete old.hooks?.PermissionRequest
    expect(mergeHooks(old, HOME).hooks?.PermissionRequest).toHaveLength(1)
    expect(unmergeHooks(mergeHooks(old, HOME))).toEqual({})
  })

  test("preserves unrelated keys and hooks", () => {
    const out = mergeHooks(existing, HOME)
    expect(out.model).toBe("opus")
    expect(out.permissions).toEqual(existing.permissions)
    expect(out.hooks?.PreToolUse?.[0]).toEqual(existing.hooks?.PreToolUse?.[0])
    expect(out.hooks?.PreToolUse).toHaveLength(2)
    expect(out.hooks?.Stop?.[0]).toEqual(existing.hooks?.Stop?.[0])
    expect(out.hooks?.Custom).toEqual([{ hooks: [] }])
  })

  test("idempotent, also when the home moved", () => {
    const once = mergeHooks(existing, HOME)
    expect(mergeHooks(once, HOME)).toEqual(once)
    const moved = mergeHooks(once, "/tmp/other")
    expect(moved.hooks?.Stop).toHaveLength(2)
    expect(JSON.stringify(moved)).not.toContain("Application Support")
  })

  test("uninstall restores the original", () => {
    expect(unmergeHooks(mergeHooks(existing, HOME))).toEqual(existing)
    expect(unmergeHooks(mergeHooks({}, HOME))).toEqual({})
  })

  test("isOurs matches quoted and bare paths only", () => {
    expect(isOurs(`"${HOME}/bin/inbox-hook" Stop`)).toBe(true)
    expect(isOurs("/x/bin/inbox-hook Stop")).toBe(true)
    expect(isOurs("/x/bin/other-inbox-hook Stop")).toBe(false)
    expect(isOurs("echo inbox-hook")).toBe(false)
    // The executable must be <home>/bin/inbox-hook itself, followed by an event name.
    expect(isOurs("node /opt/x/inbox-hook")).toBe(false)
    expect(isOurs("node /opt/x/bin/inbox-hook Stop")).toBe(false)
    expect(isOurs("/opt/x/inbox-hook Stop")).toBe(false)
    expect(isOurs("/x/bin/inbox-hook")).toBe(false)
    expect(isOurs(`"${HOME}/bin/inbox-hook"`)).toBe(false)
    expect(isOurs(`  "${HOME}/bin/inbox-hook"   PermissionRequest`)).toBe(true)
  })

  test("a user's look-alike hook is left alone by merge and unmerge", () => {
    const user: Settings = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "node /opt/x/inbox-hook", timeout: 5 }] }],
      },
    }
    const merged = mergeHooks(user, HOME)
    expect(merged.hooks?.Stop?.[0]).toEqual(user.hooks?.Stop?.[0])
    expect(merged.hooks?.Stop).toHaveLength(2)
    expect(unmergeHooks(merged)).toEqual(user)
  })

  test("a hooks.<Event> that isn't a list is refused, not replaced", () => {
    const odd = { hooks: { Stop: { command: "say done" }, PreToolUse: [] } } as unknown as Settings
    expect(() => mergeHooks(odd, HOME)).toThrow(/hooks\.Stop.*not a list/)
    expect(() => mergeHooks({ hooks: "x" } as unknown as Settings, HOME)).toThrow(/not an object/)
    // An unknown event's odd value is ours to ignore, and unmerge leaves it be.
    const other = { hooks: { Custom: "x" } } as unknown as Settings
    expect(mergeHooks(other, HOME).hooks?.Custom).toBe("x" as never)
    expect(unmergeHooks(mergeHooks(other, HOME))).toEqual(other)
  })

  test("hookHome reads the home out of quoted and bare commands", () => {
    expect(hookHome(`"${HOME}/bin/inbox-hook" Stop`)).toBe(HOME)
    expect(hookHome("/x/bin/inbox-hook Stop")).toBe("/x")
    expect(hookHome("/x/inbox-hook Stop")).toBeNull()
    expect(hookHome("say done")).toBeNull()
  })

  test("two channels side by side: each merge and unmerge leaves the other alone", () => {
    const BETA = "/Users/me/Library/Application Support/SessionInbox-beta"
    const ga = mergeHooks(existing, HOME, [BETA])
    const both = mergeHooks(ga, BETA, [HOME])
    expect(both.hooks?.PreToolUse).toHaveLength(3)
    expect(JSON.stringify(both)).toContain(`${BETA}/bin/inbox-hook`)
    expect(JSON.stringify(both)).toContain(`"${HOME}/bin/inbox-hook`)
    expect(mergeHooks(both, BETA, [HOME])).toEqual(both)
    expect(mergeHooks(both, HOME, [BETA])).toEqual(both)
    expect(unmergeHooks(both, [HOME])).toEqual(ga)
    expect(unmergeHooks(unmergeHooks(both, [HOME]), [BETA])).toEqual(existing)
  })

  test("ops snippet matches buildHooks", () => {
    const snippet = readFileSync(join(root, "ops/claude-settings.snippet.json"), "utf8")
    expect(snippet).toBe(serialize({ hooks: buildHooks("<home>") }))
  })
})

describe("install / uninstall scripts", () => {
  test("--yes against a temp settings file, then uninstall", () => {
    const dir = mkdtempSync(join(tmpdir(), "sih-inst-"))
    try {
      const settings = join(dir, "settings.json")
      const original = `${JSON.stringify(existing, null, 2)}\n`
      writeFileSync(settings, original)
      const run = (script: string, ...flags: string[]) =>
        Bun.spawnSync(
          [
            "bun",
            join(root, "scripts", script),
            "--settings",
            settings,
            "--home",
            join(dir, "h"),
            "--no-launchd",
            ...flags,
          ],
          // HOME too, so nothing derived from it (~/.local/bin, ~/Applications) is the real one.
          { cwd: root, env: { ...process.env, HOME: join(dir, "user") } },
        )

      const dry = run("install.ts")
      expect(dry.exitCode).toBe(0)
      expect(readFileSync(settings, "utf8")).toBe(original)
      expect(dry.stdout.toString()).toContain("would change")

      // --yes builds a payload (three compiled binaries and the UI): the slow step, done once.
      expect(run("install.ts", "--yes").exitCode).toBe(0)
      const installed = readFileSync(settings, "utf8")
      expect(installed).toContain("inbox-hook")
      expect(run("install.ts").stdout.toString()).toContain("no change")
      expect(readFileSync(settings, "utf8")).toBe(installed)

      expect(run("uninstall.ts", "--yes").exitCode).toBe(0)
      expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(existing)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
