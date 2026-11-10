/**
 * Approval-preview variety for the fake client (U-031): an Edit diff, a new-file Write, a
 * long truncated diff and a WebFetch, each on its own waiting session. The Bash case is
 * the mockup's `i-ravelo-migrate`, which gets `bashPreview` below.
 */
import type {
  Agent,
  ApprovalPreview,
  DiffHunk,
  DiffLine,
  Item,
  Session,
  TimelineEntry,
} from "@session-inbox/contracts"
import type { ItemExtras } from "./fixtures.ts"

const MIN = 60_000

const ctx = (text: string): DiffLine => ({ kind: "context", text })
const add = (text: string): DiffLine => ({ kind: "add", text })
const del = (text: string): DiffLine => ({ kind: "del", text })

const hunk = (oldStart: number, newStart: number, lines: DiffLine[]): DiffHunk => ({
  oldStart,
  oldLines: lines.filter((l) => l.kind !== "add").length,
  newStart,
  newLines: lines.filter((l) => l.kind !== "del").length,
  lines,
})

export const bashPreview: ApprovalPreview = {
  _tag: "command",
  command: "bun run migrate",
  description: "Apply 3 pending migrations to the local dev database",
  cwd: "/Users/dev/code/ravelo-insights",
  displayCwd: ".",
  timeoutMs: 120_000,
}

const editPreview: ApprovalPreview = {
  _tag: "diff",
  path: "/Users/dev/code/order-up-api/src/delivery/window.ts",
  displayPath: "src/delivery/window.ts",
  isNewFile: false,
  approximate: false,
  binary: false,
  added: 6,
  removed: 2,
  truncated: false,
  hunks: [
    hunk(12, 12, [
      ctx("export const deliveryWindow = (order: Order, now: Date): Window => {"),
      ctx("  const start = addMinutes(now, order.prepMinutes)"),
      del("  const end = addMinutes(start, 30)"),
      del("  return { start, end }"),
      add("  const end = addMinutes(start, order.windowMinutes ?? DEFAULT_WINDOW_MINUTES)"),
      add("  if (isAfter(start, end)) {"),
      add('    throw new WindowError("window ends before it starts", { orderId: order.id })'),
      add("  }"),
      add("  return { start, end, timezone: order.store.timezone }"),
      ctx("}"),
      ctx(""),
    ]),
    hunk(41, 45, [
      ctx("export const DEFAULT_PREP_MINUTES = 15"),
      add("export const DEFAULT_WINDOW_MINUTES = 30"),
      ctx(""),
      ctx("// Kept for the v1 webhook payloads; remove after the April cut-over."),
    ]),
  ],
}

const writePreview: ApprovalPreview = {
  _tag: "diff",
  path: "/Users/dev/code/agent-kit/scripts/changelog.ts",
  displayPath: "scripts/changelog.ts",
  isNewFile: true,
  approximate: false,
  binary: false,
  added: 9,
  removed: 0,
  truncated: false,
  hunks: [
    hunk(0, 1, [
      add('import { $ } from "bun"'),
      add(""),
      add("/** Conventional-commit subjects since the last tag, grouped by type. */"),
      add("const tag = (await $`git describe --tags --abbrev=0`.text()).trim()"),
      add("const log = await $`git log --format=%s -n 200`.text()"),
      add(
        "const groups = Object.groupBy(log.split('\\n').filter(Boolean), (s) => s.split(':')[0])",
      ),
      add("for (const [type, subjects] of Object.entries(groups))"),
      add('  console.log("## " + type + "\\n" + subjects?.map((s) => "- " + s).join("\\n"))'),
      { kind: "add", text: "", noEol: true },
    ]),
  ],
}

const longPreview = (): ApprovalPreview => {
  const fields = Array.from({ length: 70 }, (_, i) => `field${String(i + 1).padStart(2, "0")}`)
  const lines: DiffLine[] = [ctx("export interface StoreRecord {")]
  for (const f of fields) {
    lines.push(del(`  ${f}: string`))
    lines.push(add(`  ${f.replace("field", "store_field_")}: string | null`))
  }
  lines.push(ctx("}"))
  return {
    _tag: "diff",
    path: "/Users/dev/code/simple-offline-pos/src/db/records.ts",
    displayPath: "src/db/records.ts",
    isNewFile: false,
    approximate: false,
    binary: false,
    added: 214,
    removed: 214,
    truncated: true,
    hunks: [hunk(3, 3, lines)],
  }
}

const fetchPreview: ApprovalPreview = {
  _tag: "fetch",
  url: "https://developer.squareup.com/reference/square/orders-api/search-orders",
  prompt: "How does cursor pagination work for SearchOrders, and what is the max page size?",
}

export const makePreviewFixtures = (now: number) => {
  const ago = (minutes: number) => now - minutes * MIN
  const session = (id: string, projectId: string, project: string, title: string): Session => ({
    id,
    projectId,
    title,
    runtime: "cli",
    cwd: `/Users/dev/code/${project}`,
    branch: "main",
    worktree: null,
    hostSessionId: null,
    state: "waiting",
    lastEventAt: ago(1),
  })
  const sessions: Session[] = [
    session("s-pv-edit", "p-orderup", "order-up-api", "Validate delivery windows"),
    session("s-pv-write", "p-agentkit", "agent-kit", "Changelog script"),
    session("s-pv-long", "p-pos", "simple-offline-pos", "Rename store record fields"),
    session("s-pv-fetch", "p-ravelo", "ravelo-insights", "Square orders pagination"),
  ]
  const agents: Agent[] = sessions.map((s) => ({
    id: `a-${s.id}`,
    sessionId: s.id,
    parentAgentId: null,
    name: "main",
    state: "waiting",
    startedAt: ago(9),
    endedAt: null,
  }))
  const item = (id: string, sessionId: string, summary: string, minutesAgo: number): Item => ({
    id,
    sessionId,
    agentId: `a-${sessionId}`,
    kind: "permission",
    state: "open",
    queue: "needs-you",
    summary,
    unconfirmed: false,
    live: true,
    unread: true,
    snoozeUntil: null,
    createdAt: ago(minutesAgo),
    updatedAt: ago(minutesAgo),
  })
  const items: Item[] = [
    item("i-pv-edit", "s-pv-edit", "Wants to edit src/delivery/window.ts +6 −2", 1),
    item("i-pv-write", "s-pv-write", "Wants to create scripts/changelog.ts +9 −0", 3),
    item("i-pv-long", "s-pv-long", "Wants to edit src/db/records.ts +214 −214", 5),
    item("i-pv-fetch", "s-pv-fetch", "Wants to fetch https://developer.squareup.com/…", 6),
  ]
  const approval = (
    tool: string,
    input: unknown,
    preview: ApprovalPreview,
    context?: string,
  ): ItemExtras => ({
    questions: [],
    outbox: [],
    draft: null,
    openUrl: null,
    approval: {
      tool,
      input,
      decision: null,
      decidedAt: null,
      expiresAt: now + 100_000,
      preview,
      ...(context ? { context } : {}),
    },
  })
  const extras: Record<string, ItemExtras> = {
    "i-pv-edit": approval(
      "Edit",
      { file_path: editPreview._tag === "diff" ? editPreview.path : "" },
      editPreview,
      "The window end is hard-coded to 30 minutes, so stores with longer prep times get windows that end before they start. I'll make it configurable and fail loudly on inverted windows.",
    ),
    "i-pv-write": approval(
      "Write",
      { file_path: "/Users/dev/code/agent-kit/scripts/changelog.ts" },
      writePreview,
      "I'll add a small Bun script that groups commit subjects since the last tag.",
    ),
    "i-pv-long": approval(
      "MultiEdit",
      { file_path: "/Users/dev/code/simple-offline-pos/src/db/records.ts" },
      longPreview(),
    ),
    "i-pv-fetch": approval(
      "WebFetch",
      { url: fetchPreview._tag === "fetch" ? fetchPreview.url : "" },
      fetchPreview,
      "Let me check Square's docs before changing the paging loop.",
    ),
  }
  const timelines: Record<string, TimelineEntry[]> = {}
  let seq = 900
  for (const it of items) {
    seq += 1
    timelines[it.sessionId] = [
      { seq, at: it.createdAt, hook: "PreToolUse", agentId: null, text: it.summary ?? "" },
    ]
    const current = extras[it.id]
    if (current) extras[it.id] = { ...current, sourceSeq: seq }
  }
  return { sessions, agents, items, extras, timelines }
}
