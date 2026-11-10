/**
 * Finished items for the fake client's History (U-052): every kind and outcome, from today
 * back over nine days. The ones older than a day sit on ended sessions, so they are only in
 * History, not in the snapshot, as with the daemon's 24-hour working set (D-025).
 */
import type { Approval, Item, OutboxEntry, Session, TimelineEntry } from "@session-inbox/contracts"
import type { ItemExtras } from "./fixtures.ts"

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const none: ItemExtras = { questions: [], approval: null, outbox: [], draft: null, openUrl: null }

const approval = (
  tool: string,
  input: Record<string, unknown>,
  decision: Approval["decision"],
  decidedAt: number | null,
): Approval => ({ tool, input, decision, decidedAt, expiresAt: decidedAt ?? 0 })

const delivered = (id: string, body: string, at: number): OutboxEntry => ({
  id,
  body,
  state: "delivered",
  attempts: 1,
  lastError: null,
  createdAt: at,
})

export const makeHistoryFixtures = (now: number) => {
  const ago = (ms: number) => now - ms

  const ended = (
    id: string,
    projectId: string,
    projectName: string,
    title: string,
    lastEventAgo: number,
    branch: string,
  ): Session => ({
    id,
    projectId,
    title,
    runtime: "cli",
    cwd: `/Users/dev/code/${projectName}`,
    branch,
    worktree: null,
    hostSessionId: null,
    state: "ended",
    lastEventAt: ago(lastEventAgo),
  })

  const sessions: Array<Session> = [
    ended(
      "s-h-passkeys",
      "p-orderup",
      "order-up-api",
      "Migrate auth to passkeys",
      2 * DAY,
      "auth-passkeys",
    ),
    ended("s-h-flaky", "p-agentkit", "agent-kit", "Flaky e2e on CI", 3 * DAY, "fix-e2e"),
    ended("s-h-tiles", "p-ravelo", "ravelo-insights", "Tile cache eviction", 4 * DAY, "tile-lru"),
    ended("s-h-csv", "p-pos", "simple-offline-pos", "Inventory CSV import", 6 * DAY, "csv-import"),
    ended("s-h-release", "p-pos", "simple-offline-pos", "Release checklist", 8 * DAY, "main"),
    ended("s-h-docs", "p-agentkit", "agent-kit", "Docs pass", 9 * DAY, "docs"),
  ]

  const done = (
    id: string,
    sessionId: string,
    kind: Item["kind"],
    state: Item["state"],
    summary: string,
    endedAgo: number,
    extra: Partial<Item> = {},
  ): Item => ({
    id,
    sessionId,
    agentId: null,
    kind,
    state,
    queue: "done",
    summary,
    unconfirmed: false,
    live: false,
    unread: false,
    snoozeUntil: null,
    createdAt: ago(endedAgo + 4 * MIN),
    updatedAt: ago(endedAgo),
    ...extra,
  })

  const items: Array<Item> = [
    done(
      "h-retry-tests",
      "s-retry",
      "permission",
      "answered",
      "Wants to run bun test src/clients",
      35 * MIN,
    ),
    done(
      "h-delivery-split",
      "s-delivery",
      "question",
      "answered",
      "How to split the window module",
      90 * MIN,
      { questionCount: 2 },
    ),
    done(
      "h-ravelo-csv",
      "s-ravelo",
      "permission",
      "answered",
      "Wants to edit src/export/csv.ts",
      3 * HOUR,
    ),
    done(
      "h-hooks-rm",
      "s-hooks",
      "permission",
      "answered",
      "Wants to run rm -rf fixtures/recorded",
      5 * HOUR,
    ),
    // A watch run that never returned: flagged after 5 minutes, ended 20 minutes in (C-030).
    done("h-hooks-watch", "s-hooks", "stuck", "resolved", "Running bun test --watch", 2 * HOUR, {
      createdAt: ago(2 * HOUR + 15 * MIN),
    }),
    done(
      "h-receipts-queue",
      "s-pos-receipts",
      "review",
      "answered",
      "Print queue fallback done · 3 files changed",
      26 * HOUR,
    ),
    done(
      "h-passkeys-lib",
      "s-h-passkeys",
      "question",
      "resolved",
      "Which WebAuthn library to use",
      2 * DAY,
      { questionCount: 1 },
    ),
    done(
      "h-passkeys-fetch",
      "s-h-passkeys",
      "permission",
      "expired",
      "Wants to fetch the WebAuthn spec",
      2 * DAY + 20 * MIN,
    ),
    done(
      "h-flaky-timeout",
      "s-h-flaky",
      "failed",
      "resolved",
      "Playwright timed out in `checkout.spec.ts`",
      3 * DAY,
    ),
    done(
      "h-flaky-retry",
      "s-h-flaky",
      "failed",
      "answered",
      "2 e2e tests failing after the retry change",
      3 * DAY + 2 * HOUR,
    ),
    done(
      "h-tiles-review",
      "s-h-tiles",
      "review",
      "dismissed",
      "LRU eviction for map tiles · 5 files changed",
      4 * DAY,
    ),
    done(
      "h-csv-write",
      "s-h-csv",
      "permission",
      "answered",
      "Wants to create src/import/csv.ts",
      6 * DAY,
    ),
    done(
      "h-csv-columns",
      "s-h-csv",
      "question",
      "answered",
      "Which columns the importer should require",
      6 * DAY + HOUR,
      { questionCount: 1 },
    ),
    done(
      "h-release-push",
      "s-h-release",
      "permission",
      "resolved",
      "Wants to run git push origin main",
      8 * DAY,
    ),
    done(
      "h-docs-review",
      "s-h-docs",
      "review",
      "resolved",
      "Hook reference rewritten · 2 files changed",
      9 * DAY,
    ),
  ]

  const at = (id: string) => items.find((i) => i.id === id)?.updatedAt ?? now

  const extras: Record<string, ItemExtras> = {
    "h-retry-tests": {
      ...none,
      outcome: "allowed",
      approval: approval(
        "Bash",
        { command: "bun test src/clients", description: "Run the client tests" },
        "allow",
        at("h-retry-tests"),
      ),
    },
    "h-delivery-split": {
      ...none,
      outcome: "answered",
      questions: [
        {
          idx: 0,
          header: "Split",
          text: "How should I split src/delivery/window.ts?",
          options: [{ label: "By concern (3 modules)" }, { label: "Keep one file" }],
          multi: false,
          answer: { selected: ["By concern (3 modules)"] },
        },
        {
          idx: 1,
          header: "Exports",
          text: "Keep the old exports as re-exports for a release?",
          options: [{ label: "Yes" }, { label: "No" }],
          multi: false,
          answer: { selected: [], other: "Only for deliveryWindow, drop the rest" },
        },
      ],
    },
    "h-ravelo-csv": {
      ...none,
      outcome: "always-allowed",
      approval: approval(
        "Edit",
        { file_path: "/Users/dev/code/ravelo-insights/src/export/csv.ts" },
        "allow-always",
        at("h-ravelo-csv"),
      ),
    },
    "h-hooks-rm": {
      ...none,
      outcome: "denied",
      denyReason: "Keep the recorded fixtures; regenerate only the synthetic ones.",
      approval: approval(
        "Bash",
        { command: "rm -rf fixtures/recorded", description: "Remove stale recorded fixtures" },
        "deny",
        at("h-hooks-rm"),
      ),
    },
    "h-hooks-watch": {
      ...none,
      outcome: "moved-on",
      running: {
        tool: "Bash",
        since: ago(2 * HOUR + 20 * MIN),
        preview: {
          _tag: "command",
          command: "bun test --watch",
          description: "Run the parser tests in watch mode",
          cwd: "/Users/dev/code/agent-kit",
          displayCwd: ".",
        },
      },
    },
    "h-receipts-queue": {
      ...none,
      outcome: "replied",
      lastMessage: "The print queue now falls back to the system queue when USB is busy.",
      outbox: [delivered("o-receipts", "Looks good, open the PR", at("h-receipts-queue"))],
    },
    "h-passkeys-lib": {
      ...none,
      outcome: "in-claude",
      questions: [
        {
          idx: 0,
          text: "Which WebAuthn library should the server use?",
          options: [{ label: "@simplewebauthn/server" }, { label: "fido2-lib" }],
          multi: false,
          answer: null,
        },
      ],
    },
    "h-passkeys-fetch": {
      ...none,
      outcome: "expired",
      approval: approval("WebFetch", { url: "https://www.w3.org/TR/webauthn-3/" }, null, null),
    },
    "h-flaky-timeout": {
      ...none,
      outcome: "moved-on",
      lastMessage: "Playwright timed out waiting for the pay button in `checkout.spec.ts`.",
    },
    "h-flaky-retry": {
      ...none,
      outcome: "replied",
      outbox: [
        delivered(
          "o-flaky",
          "Retry with --workers=1 and tell me if it still fails",
          at("h-flaky-retry"),
        ),
      ],
    },
    "h-tiles-review": { ...none, outcome: "dismissed" },
    "h-csv-write": {
      ...none,
      outcome: "allowed",
      approval: approval(
        "Write",
        { file_path: "/Users/dev/code/simple-offline-pos/src/import/csv.ts" },
        "allow",
        at("h-csv-write"),
      ),
    },
    "h-csv-columns": {
      ...none,
      outcome: "answered",
      questions: [
        {
          idx: 0,
          text: "Which columns must every row have?",
          options: [{ label: "sku" }, { label: "name" }, { label: "price" }, { label: "stock" }],
          multi: true,
          answer: { selected: ["sku", "price"] },
        },
      ],
    },
    "h-release-push": {
      ...none,
      outcome: "in-claude",
      approval: approval("Bash", { command: "git push origin main" }, null, null),
    },
    "h-docs-review": { ...none, outcome: "moved-on" },
  }

  const timelines: Record<string, Array<TimelineEntry>> = Object.fromEntries(
    sessions.map((s, n) => [
      s.id,
      [
        {
          seq: 9000 + n * 3,
          at: s.lastEventAt - 30 * MIN,
          hook: "SessionStart",
          agentId: null,
          text: "Session started",
        },
        {
          seq: 9001 + n * 3,
          at: s.lastEventAt - 5 * MIN,
          hook: "PreToolUse",
          agentId: null,
          text: "Asked for your input",
        },
        {
          seq: 9002 + n * 3,
          at: s.lastEventAt,
          hook: "SessionEnd",
          agentId: null,
          text: "Session ended",
        },
      ],
    ]),
  )

  return { sessions, items, extras, timelines }
}
