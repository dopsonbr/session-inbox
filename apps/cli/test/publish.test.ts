/**
 * `release.ts --publish` preconditions, against a throwaway repo whose origin is a local bare
 * repo in /tmp. Nothing here talks to GitHub, creates a release or touches this checkout.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { publishPreconditions } from "../../../scripts/release.ts"

const root = mkdtempSync("/tmp/si-pub-")
afterAll(() => rmSync(root, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { cwd, stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: root } },
  )
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`)
  return p.stdout.toString().trim()
}

describe("release.ts --publish preconditions", () => {
  const origin = join(root, "origin.git")
  const work = join(root, "work")

  test("a clean HEAD equal to origin's default branch, with a new tag, is the commit to tag", () => {
    git(root, "init", "--quiet", "--bare", "-b", "main", origin)
    git(root, "clone", "--quiet", origin, work)
    writeFileSync(join(work, "VERSION"), "0.1.0\n")
    git(work, "add", "VERSION")
    git(work, "commit", "--quiet", "-m", "one")
    git(work, "push", "--quiet", "origin", "HEAD:main")
    git(work, "remote", "set-head", "origin", "main")
    expect(publishPreconditions(work, "0.1.0")).toEqual({ sha: git(work, "rev-parse", "HEAD") })
  })

  test("a dirty tree is refused before anything is built", () => {
    writeFileSync(join(work, "VERSION"), "0.1.1\n")
    expect(() => publishPreconditions(work, "0.1.1")).toThrow(/dirty/)
    git(work, "checkout", "--", "VERSION")
  })

  test("a local commit origin doesn't have is refused: push first", () => {
    writeFileSync(join(work, "NOTES"), "x\n")
    git(work, "add", "NOTES")
    git(work, "commit", "--quiet", "-m", "two")
    expect(() => publishPreconditions(work, "0.1.0")).toThrow(/push or pull first/)
    git(work, "push", "--quiet", "origin", "HEAD:main")
    expect(publishPreconditions(work, "0.1.0").sha).toBe(git(work, "rev-parse", "HEAD"))
  })

  test("an existing tag, here or only on origin, is refused", () => {
    git(work, "tag", "v0.1.0")
    expect(() => publishPreconditions(work, "0.1.0")).toThrow(/tag v0.1.0 already exists$/)
    git(work, "push", "--quiet", "origin", "v0.1.0")
    git(work, "tag", "-d", "v0.1.0")
    // fetch --tags brings it back, so it's refused either way.
    expect(() => publishPreconditions(work, "0.1.0")).toThrow(/tag v0.1.0 already exists/)
    expect(publishPreconditions(work, "0.2.0").sha).toBe(git(work, "rev-parse", "HEAD"))
  })
})
