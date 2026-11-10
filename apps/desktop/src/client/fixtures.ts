/**
 * Fixture data matching docs/mockups/InboxDesktop.dc.html and MenuBar.dc.html.
 * Everything is relative to `now` so "waiting 2m" reads right whenever it runs.
 */
import type {
  Agent,
  Approval,
  Item,
  OutboxEntry,
  Project,
  Question,
  Session,
  TimelineEntry,
} from "@session-inbox/contracts"
import { bashPreview, makePreviewFixtures } from "./previewFixtures.ts"

const MIN = 60_000

export type ItemExtras = {
  questions: ReadonlyArray<Question>
  approval: Approval | null
  outbox: ReadonlyArray<OutboxEntry>
  draft: unknown
  openUrl: string | null
  /** Seq of the timeline entry that created the item (the fake marks it `isSource`). */
  sourceSeq?: number
  /** What Claude said last (C-023), Markdown. */
  lastMessage?: string
  /** Why a reply can't be sent from the inbox (C-023). */
  replyUnavailable?: string
}

/** A long review message: >24 lines, every block kind, a relative link and a bare URL. */
export const RECEIPTS_LAST_MESSAGE = `## ESC/POS driver is done

The receipt printer driver now talks **ESC/POS** directly over USB, with a *fallback* to the system print queue when no printer answers within \`PRINTER_TIMEOUT_MS\`.

### What changed
- \`src/printer/escpos.ts\`: command builder (bold, cut, QR codes)
- \`src/printer/usb.ts\`: device discovery and reconnect
  - retries 3 times with backoff
  - logs the vendor id on failure
- \`src/printer/queue.ts\`: fallback path

### How to try it
1. Plug in the TM-T20III
2. Run the demo:

\`\`\`bash
bun run printer:demo --copies 2
\`\`\`

3. Check the cut lands below the QR code

| File | Lines |
|------|-------|
| escpos.ts | 412 |
| usb.ts | 188 |

Notes for review are in [docs/printer-handoff.md](docs/printer-handoff.md); the spec I followed is https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/index.html.

---

Tests: 7 files changed, **38 passing**, 0 failing. Nothing is committed yet; I left the branch \`feat/escpos\` for you to look at before the PR.`

const DOCS_LAST_MESSAGE =
  "I drafted `README.md` for the hook installer: install, uninstall, and what each hook does. Have a read and tell me what to change."

const HOOKS_LAST_MESSAGE = `I stopped: 3 tests in \`parser.spec.ts\` fail after the schema change.

- \`parses SubagentStop\`: expected \`agent_type\`, got \`undefined\`
- \`rejects unknown events\`: now accepted
- \`keeps raw payload\`: snapshot changed

Want me to update the snapshots, or fix the parser to keep the old field?`

export type Fixtures = {
  projects: Array<Project>
  sessions: Array<Session>
  agents: Array<Agent>
  items: Array<Item>
  extras: Record<string, ItemExtras>
  timelines: Record<string, Array<TimelineEntry>>
}

const project = (id: string, name: string): Project => ({
  id,
  name,
  rootPath: `/Users/dev/code/${name}`,
  muted: false,
})

export const makeFixtures = (now: number): Fixtures => {
  const ago = (minutes: number) => now - minutes * MIN

  const projects = [
    project("p-orderup", "order-up-api"),
    project("p-ravelo", "ravelo-insights"),
    project("p-agentkit", "agent-kit"),
    project("p-pos", "simple-offline-pos"),
  ]

  const session = (
    id: string,
    projectId: string,
    title: string,
    runtime: Session["runtime"],
    state: Session["state"],
    lastEventMinutesAgo: number,
    extra: Partial<Session> = {},
  ): Session => {
    const projectName = projects.find((p) => p.id === projectId)?.name ?? projectId
    return {
      id,
      projectId,
      title,
      runtime,
      cwd: `/Users/dev/code/${projectName}`,
      branch: "main",
      worktree: null,
      hostSessionId: runtime === "desktop" ? `local_${id}` : null,
      state,
      lastEventAt: ago(lastEventMinutesAgo),
      ...extra,
    }
  }

  const sessions: Array<Session> = [
    session("s-retry", "p-orderup", "Retry policy for usom calls", "desktop", "waiting", 2, {
      branch: "feat/usom-retry",
      worktree: "feat/usom-retry",
      cwd: "/Users/dev/code/order-up-api/.claude/worktrees/feat-usom-retry",
    }),
    session("s-delivery", "p-orderup", "Delivery window refactor", "cli", "running", 0),
    session("s-ravelo", "p-ravelo", "POS export ingestion", "desktop", "waiting", 14, {
      branch: "feat/pos-export",
    }),
    session("s-ravelo-dash", "p-ravelo", "Dashboard tile caching", "cli", "running", 1),
    session("s-hooks", "p-agentkit", "Hook event schema v2", "cli", "idle", 41, {
      branch: "schema-v2",
    }),
    session("s-agentkit-docs", "p-agentkit", "README for hook installer", "desktop", "idle", 58),
    session("s-pos-sync", "p-pos", "Offline sync conflict resolver", "desktop", "running", 0, {
      branch: "sync-conflicts",
      worktree: "sync-conflicts",
    }),
    session("s-pos-receipts", "p-pos", "Receipt printer driver", "cli", "idle", 23),
    session("s-pos-bench", "p-pos", "Benchmark IndexedDB batching", "cli", "running", 3),
  ]

  const agent = (
    id: string,
    sessionId: string,
    name: string,
    state: Agent["state"],
    parentAgentId: string | null,
    startedMinutesAgo: number,
  ): Agent => ({
    id,
    sessionId,
    parentAgentId,
    name,
    state,
    startedAt: ago(startedMinutesAgo),
    endedAt: state === "done" || state === "failed" ? ago(startedMinutesAgo - 3) : null,
  })

  const agents: Array<Agent> = [
    agent("a-retry-main", "s-retry", "main", "waiting", null, 26),
    agent("a-retry-explore", "s-retry", "Explore · usom clients", "done", "a-retry-main", 24),
    agent("a-retry-tests", "s-retry", "test-runner", "waiting", "a-retry-main", 9),
    agent("a-retry-review", "s-retry", "code-reviewer", "running", "a-retry-main", 4),
    agent("a-delivery-main", "s-delivery", "main", "running", null, 12),
    agent("a-ravelo-main", "s-ravelo", "main", "waiting", null, 30),
    agent("a-dash-main", "s-ravelo-dash", "main", "running", null, 8),
    agent("a-hooks-main", "s-hooks", "main", "failed", null, 50),
    agent("a-docs-main", "s-agentkit-docs", "main", "done", null, 70),
    agent("a-sync-main", "s-pos-sync", "main", "running", null, 35),
    agent("a-sync-scout", "s-pos-sync", "conflict-scout", "waiting", "a-sync-main", 20),
    agent("a-sync-tests", "s-pos-sync", "test-runner", "running", "a-sync-main", 2),
    // A subagent the hook couldn't name: the tree shows "agent" (U-040).
    agent("a-sync-anon", "s-pos-sync", "", "done", "a-sync-main", 12),
    agent("a-receipts-main", "s-pos-receipts", "main", "done", null, 40),
    agent("a-bench-main", "s-pos-bench", "main", "running", null, 6),
  ]

  const item = (
    id: string,
    sessionId: string,
    agentId: string | null,
    kind: Item["kind"],
    queue: Item["queue"],
    summary: string,
    minutesAgo: number,
    extra: Partial<Item> = {},
  ): Item => ({
    id,
    sessionId,
    agentId,
    kind,
    state: queue === "snoozed" ? "snoozed" : "open",
    queue,
    summary,
    unconfirmed: false,
    live: false,
    unread: true,
    snoozeUntil: null,
    createdAt: ago(minutesAgo),
    updatedAt: ago(minutesAgo),
    ...extra,
  })

  const items: Array<Item> = [
    item(
      "i-retry-questions",
      "s-retry",
      "a-retry-tests",
      "question",
      "needs-you",
      "Which tests to run · retry budget for 5xx",
      2,
      { live: true, questionCount: 2 },
    ),
    item(
      "i-ravelo-migrate",
      "s-ravelo",
      "a-ravelo-main",
      "permission",
      "needs-you",
      "Wants to run bun run migrate",
      14,
      { live: true },
    ),
    item(
      "i-hooks-failed",
      "s-hooks",
      "a-hooks-main",
      "failed",
      "needs-you",
      "3 tests failing in `parser.spec.ts`",
      41,
      { unread: false },
    ),
    item(
      "i-receipts-review",
      "s-pos-receipts",
      "a-receipts-main",
      "review",
      "review",
      "**ESC/POS** driver done · 7 files changed in `src/printer`",
      23,
    ),
    item(
      "i-docs-review",
      "s-agentkit-docs",
      "a-docs-main",
      "review",
      "review",
      "Installer README drafted, waiting on your read",
      58,
      { unread: false },
    ),
    item(
      "i-sync-snoozed",
      "s-pos-sync",
      "a-sync-scout",
      "question",
      "snoozed",
      "Tombstone merge strategy",
      20,
      { snoozeUntil: now + 45 * MIN, unread: false, questionCount: 1 },
    ),
  ]

  const none: ItemExtras = { questions: [], approval: null, outbox: [], draft: null, openUrl: null }

  const extras: Record<string, ItemExtras> = {
    "i-retry-questions": {
      ...none,
      openUrl: "claude://code/session/local_s-retry",
      questions: [
        {
          idx: 0,
          header: "Tests",
          text: "Which integration tests should I run before opening the PR?",
          options: [
            { label: "Only *Usom* tests", description: "~2 min" },
            { label: "Full integration suite", description: "~14 min" },
            { label: "Skip — I'll run them" },
          ],
          multi: false,
          answer: null,
        },
        {
          idx: 1,
          header: "Retries",
          text: "How many retries on a 5xx before the breaker counts it as a failure?",
          options: [{ label: "2 (recommended)" }, { label: "3" }],
          multi: false,
          answer: null,
        },
      ],
    },
    "i-ravelo-migrate": {
      ...none,
      openUrl: "claude://code/session/local_s-ravelo",
      approval: {
        tool: "Bash",
        input: {
          command: "bun run migrate",
          description: "Apply 3 pending migrations to the local dev database",
        },
        decision: null,
        decidedAt: null,
        expiresAt: now + 100_000,
        preview: bashPreview,
        context: "The export tables are in place and tests pass. Applying the migrations next.",
        alwaysAllow: "Bash(bun run migrate) in this project's .claude/settings.local.json",
      },
    },
    "i-hooks-failed": { ...none, openUrl: null, lastMessage: HOOKS_LAST_MESSAGE },
    "i-receipts-review": { ...none, openUrl: null, lastMessage: RECEIPTS_LAST_MESSAGE },
    "i-docs-review": {
      ...none,
      openUrl: "claude://code/session/local_s-agentkit-docs",
      lastMessage: DOCS_LAST_MESSAGE,
      replyUnavailable:
        "Replies are sent with the claude CLI, which isn't logged in on this Mac. Reply in Claude instead, or log in with claude /login in a terminal.",
    },
    "i-sync-snoozed": {
      ...none,
      openUrl: "claude://code/session/local_s-pos-sync",
      questions: [
        {
          idx: 0,
          text: "Which tombstone merge strategies should the resolver support?",
          options: [
            { label: "Last-writer-wins" },
            { label: "Keep both, flag for review" },
            { label: "Server always wins" },
          ],
          multi: true,
          answer: null,
        },
      ],
    },
  }

  let seq = 0
  const entry = (minutesAgo: number, hook: string, text: string, agentId: string | null = null) => {
    seq += 1
    return { seq, at: ago(minutesAgo), hook, agentId, text }
  }

  const timelines: Record<string, Array<TimelineEntry>> = {
    "s-retry": [
      entry(28, "SessionStart", "Session started in feat/usom-retry"),
      entry(26, "PostToolUse", "Read src/clients/UsomClient.ts"),
      entry(18, "PostToolUse", "Backoff with jitter in UsomClient", "a-retry-main"),
      entry(10, "PostToolUse", "Added circuit breaker (5 fails / 30s)", "a-retry-main"),
      entry(7, "PostToolUse", "Unit tests pass — 42 / 42", "a-retry-tests"),
      entry(2, "PreToolUse", "Asked 2 questions", "a-retry-tests"),
    ],
    "s-ravelo": [
      entry(31, "SessionStart", "Session started"),
      entry(22, "PostToolUse", "Wrote migrations/0012_pos_exports.sql"),
      entry(16, "PostToolUse", "Ran bun test — 18 passed"),
      entry(14, "PreToolUse", "Wants to run bun run migrate"),
    ],
    "s-hooks": [
      entry(52, "SessionStart", "Session started"),
      entry(47, "PostToolUse", "Edited src/schema/events.ts"),
      entry(43, "PostToolUse", "Ran bun test — 3 failing in parser.spec.ts"),
      entry(41, "Stop", "Stopped with errors"),
    ],
    "s-pos-receipts": [
      entry(40, "SessionStart", "Session started"),
      entry(31, "PostToolUse", "Wrote src/printer/escpos.ts"),
      entry(23, "Stop", "Finished: driver + 7 files changed"),
    ],
    "s-agentkit-docs": [
      entry(70, "SessionStart", "Session started"),
      entry(58, "Stop", "Finished: README.md drafted"),
    ],
    "s-pos-sync": [
      entry(35, "SessionStart", "Session started in sync-conflicts"),
      entry(20, "PreToolUse", "Asked about tombstone merge strategy", "a-sync-scout"),
      entry(2, "SubagentStart", "test-runner started", "a-sync-tests"),
    ],
  }

  // Each item's source is the last PreToolUse/Stop in its session (what the daemon's
  // `source_seq` points at), so later activity like s-pos-sync's SubagentStart isn't it.
  for (const it of items) {
    const source = [...(timelines[it.sessionId] ?? [])]
      .reverse()
      .find((e) => e.hook === "PreToolUse" || e.hook === "Stop")
    const current = extras[it.id]
    if (source !== undefined && current !== undefined) {
      extras[it.id] = { ...current, sourceSeq: source.seq }
    }
  }

  // Approval-preview variety (U-031), appended so the mockup's items keep their order.
  const pv = makePreviewFixtures(now)
  return {
    projects,
    sessions: [...sessions, ...pv.sessions],
    agents: [...agents, ...pv.agents],
    items: [...items, ...pv.items],
    extras: { ...extras, ...pv.extras },
    timelines: { ...timelines, ...pv.timelines },
  }
}
