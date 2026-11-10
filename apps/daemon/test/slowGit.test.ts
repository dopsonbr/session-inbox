/**
 * A slow git lookup must not hold up the ingest of a request the hook waits on (D-081): the hook
 * gives up after 500 ms, and the daemon would then hold a request nobody polls.
 */
import { describe, expect, test } from "bun:test"
import type { GitInfo } from "../src/services.ts"
import type { SessionRow } from "../src/store.ts"
import { envelope, FakeGit, makeHarness } from "./fakes.ts"

class SlowGit extends FakeGit {
  constructor(
    public delayMs: number,
    map: Record<string, GitInfo>,
  ) {
    super(map)
  }
  override resolve = async (cwd: string): Promise<GitInfo> => {
    this.calls++
    await Bun.sleep(this.delayMs)
    return this.map[cwd] ?? { root: cwd, worktree: null, branch: "main" }
  }
}

const SID = "abababab-0000-4000-8000-0000000000a1"
const CWD = "/work/repo/packages/app"
const repo: Record<string, GitInfo> = {
  [CWD]: { root: "/work/repo", worktree: null, branch: "feature/x" },
}

describe("slow git (D-081)", () => {
  for (const event of ["PermissionRequest", "PreToolUse"] as const) {
    test(`${event} answers within 100 ms; project and branch are filled in afterwards`, async () => {
      const git = new SlowGit(700, repo)
      const h = makeHarness({
        git,
        settings: event === "PreToolUse" ? { "holds.via": "preToolUse" } : {},
      })
      const t = performance.now()
      const r = await h.engine.ingest(
        event,
        envelope(event, {
          session_id: SID,
          cwd: CWD,
          permission_mode: "default",
          tool_name: "Bash",
          tool_use_id: "t1",
          tool_input: { command: "rm -rf dist" },
        }),
      )
      expect(performance.now() - t).toBeLessThan(100)
      expect(r.requestId).not.toBeNull()
      await h.engine.idle()
      const s = h.engine.store.session(SID) as SessionRow
      expect(s.branch).toBe("feature/x")
      expect(h.engine.store.project(s.project_id)?.root_path).toBe("/work/repo")
      // The guess the ingest used is gone once nothing points at it.
      expect(h.engine.snapshot().projects.map((p) => p.rootPath)).toEqual(["/work/repo"])
      expect(h.engine.store.all("SELECT * FROM projects")).toHaveLength(1)
      expect(
        h.engine.store.one("SELECT 1 AS x FROM events WHERE hook = 'daemon:git'"),
      ).not.toBeNull()
    })
  }

  test("a fast git is still used inline, and a known project root is the guess for a new cwd", async () => {
    const git = new SlowGit(0, repo)
    const h2 = makeHarness({ git })
    await h2.engine.ingest("Stop", envelope("Stop", { session_id: "s0", cwd: CWD }))
    const known = h2.engine.store.session("s0")
    expect(known?.branch).toBe("feature/x")
    h2.engine.mute(known?.project_id ?? "", true)
    // A muted project is recognised by the guess before git answers: nothing is held.
    git.delayMs = 700
    const r = await h2.engine.ingest(
      "PermissionRequest",
      envelope("PermissionRequest", {
        session_id: SID,
        cwd: CWD,
        permission_mode: "default",
        tool_name: "Bash",
        tool_input: { command: "rm -rf dist" },
      }),
    )
    expect(r.requestId).toBeNull()
    expect(h2.engine.store.session(SID)?.project_id).toBe(known?.project_id ?? "")
    await h2.engine.idle()
    expect(h2.engine.store.session(SID)?.project_id).toBe(known?.project_id ?? "")
  })
})
