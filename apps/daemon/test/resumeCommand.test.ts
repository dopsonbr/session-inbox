/** The "Open in Claude" clipboard command is safe to paste into a shell (D-086). */
import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { Session } from "@session-inbox/contracts"
import { resumeCommandFor } from "../src/engine.ts"

const root = mkdtempSync("/tmp/si-q-")
afterAll(() => rmSync(root, { recursive: true, force: true }))

test("a cwd with $(…), a quote and a space, and an odd session id, stay literal", () => {
  const cwd = join(root, "it's a $(touch pwned) dir")
  mkdirSync(cwd)
  const id = "abc'; touch pwned2; echo '"
  const cmd = resumeCommandFor({ id, cwd } as Session)
  // Run it with `claude` swapped for something that prints what it was given.
  const r = Bun.spawnSync(
    ["/bin/sh", "-c", cmd.replace("claude --resume", "pwd; printf '%s\\n'")],
    { cwd: root },
  )
  expect(r.exitCode).toBe(0)
  expect(r.stdout.toString()).toBe(`${cwd}\n${id}\n`)
  expect(readdirSync(cwd)).toEqual([])
  expect(readdirSync(root)).toEqual([`it's a $(touch pwned) dir`])
  expect(existsSync(join(root, "pwned"))).toBe(false)
})

test("no cwd: just the resume", () => {
  expect(resumeCommandFor({ id: "s-1", cwd: null } as unknown as Session)).toBe(
    "claude --resume 's-1'",
  )
})
