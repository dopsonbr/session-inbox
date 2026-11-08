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

const MIN = 60_000

export type ItemExtras = {
  questions: ReadonlyArray<Question>
  approval: Approval | null
  outbox: ReadonlyArray<OutboxEntry>
  draft: unknown
  openUrl: string | null
}

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
      { live: true },
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
      "3 tests failing in parser.spec.ts",
      41,
      { unread: false },
    ),
    item(
      "i-receipts-review",
      "s-pos-receipts",
      "a-receipts-main",
      "review",
      "review",
      "ESC/POS driver done · 7 files changed",
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
      { snoozeUntil: now + 45 * MIN, unread: false },
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
      },
    },
    "i-hooks-failed": { ...none, openUrl: null },
    "i-receipts-review": { ...none, openUrl: null },
    "i-docs-review": { ...none, openUrl: "claude://code/session/local_s-agentkit-docs" },
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

  return { projects, sessions, agents, items, extras, timelines }
}
