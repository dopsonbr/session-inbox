/**
 * In-memory DaemonClient for `bun run dev:mock` and tests. It plays the daemon:
 * it owns state, computes queues and counts, and emits `delta`s on its stream.
 * This is the only place in the UI package where that logic exists, and it
 * exists only to fake the daemon (U-004).
 */
import type {
  ActionResponse,
  Counts,
  Item,
  ItemDetail,
  OutboxEntry,
  Snapshot,
  StreamMessage,
  TimelineEntry,
} from "@session-inbox/contracts"
import { Effect, Queue, Stream } from "effect"
import { DaemonClient, type DaemonClientShape, DaemonError } from "./daemonClient.ts"
import { type Fixtures, makeFixtures } from "./fixtures.ts"

type Delta = Extract<StreamMessage, { _tag: "delta" }>

export type FakeOptions = Readonly<{
  now?: () => number
  /** Run the background "sessions doing work" simulation (off in tests). */
  simulate?: boolean
  /** Multiplier for simulated delays (outbox delivery, activity); tests use 0. */
  delayScale?: number
}>

export type FakeDaemon = DaemonClientShape &
  Readonly<{
    /** Test hooks. */
    state: () => Fixtures & { seq: number }
    emitted: () => ReadonlyArray<StreamMessage>
  }>

export const makeFakeClient = (options: FakeOptions = {}): FakeDaemon => {
  const now = options.now ?? (() => Date.now())
  const delayScale = options.delayScale ?? 1
  const db = makeFixtures(now())
  let seq = 100
  const log: Array<StreamMessage> = []
  const listeners = new Set<(message: StreamMessage) => void>()
  let simulationStarted = false

  const counts = (): Counts => ({
    needsYou: db.items.filter((i) => i.queue === "needs-you").length,
    working: db.sessions.filter((s) => s.state === "running").length,
    review: db.items.filter((i) => i.queue === "review").length,
    snoozed: db.items.filter((i) => i.queue === "snoozed").length,
  })

  const broadcast = (message: StreamMessage) => {
    log.push(message)
    for (const listener of listeners) {
      listener(message)
    }
  }

  const emitDelta = (changed: {
    items?: ReadonlyArray<string>
    sessions?: ReadonlyArray<string>
    agents?: ReadonlyArray<string>
    projects?: ReadonlyArray<string>
  }) => {
    seq += 1
    const delta: Delta = {
      _tag: "delta",
      seq,
      projects: db.projects.filter((p) => changed.projects?.includes(p.id)),
      sessions: db.sessions.filter((s) => changed.sessions?.includes(s.id)),
      agents: db.agents.filter((a) => changed.agents?.includes(a.id)),
      items: db.items.filter((i) => changed.items?.includes(i.id)),
      counts: counts(),
    }
    broadcast(delta)
  }

  const later = (ms: number, f: () => void) => {
    if (delayScale === 0) {
      f()
    } else {
      setTimeout(f, ms * delayScale)
    }
  }

  const findItem = (itemId: string): Effect.Effect<Item, DaemonError> => {
    const found = db.items.find((i) => i.id === itemId)
    return found === undefined
      ? Effect.fail(new DaemonError({ message: `No item ${itemId}`, status: 404 }))
      : Effect.succeed(found)
  }

  const patchItem = (itemId: string, patch: Partial<Item>): Item => {
    const index = db.items.findIndex((i) => i.id === itemId)
    const next = { ...(db.items[index] as Item), ...patch, updatedAt: now() }
    db.items[index] = next
    return next
  }

  const patchSession = (sessionId: string, patch: Partial<(typeof db.sessions)[number]>) => {
    const index = db.sessions.findIndex((s) => s.id === sessionId)
    if (index >= 0) {
      db.sessions[index] = { ...(db.sessions[index] as (typeof db.sessions)[number]), ...patch }
    }
  }

  const addTimeline = (sessionId: string, text: string, hook = "PostToolUse") => {
    seq += 1
    const entry: TimelineEntry = { seq, at: now(), hook, agentId: null, text }
    db.timelines[sessionId] = [...(db.timelines[sessionId] ?? []), entry]
  }

  const patchExtras = (itemId: string, patch: Partial<Fixtures["extras"][string]>) => {
    const current = db.extras[itemId] ?? {
      questions: [],
      approval: null,
      outbox: [],
      draft: null,
      openUrl: null,
    }
    db.extras[itemId] = { ...current, ...patch }
  }

  /** Queue a reply in the outbox and walk it through sending → delivered. */
  const sendThroughOutbox = (item: Item, body: string, idempotencyKey: string) => {
    const existing = (db.extras[item.id]?.outbox ?? []).find((o) => o.id === idempotencyKey)
    if (existing !== undefined) {
      return
    }
    const entry: OutboxEntry = {
      id: idempotencyKey,
      body,
      state: "queued",
      attempts: 0,
      lastError: null,
      createdAt: now(),
    }
    patchExtras(item.id, { outbox: [...(db.extras[item.id]?.outbox ?? []), entry] })
    const setState = (state: OutboxEntry["state"], attempts: number) => {
      patchExtras(item.id, {
        outbox: (db.extras[item.id]?.outbox ?? []).map((o) =>
          o.id === idempotencyKey ? { ...o, state, attempts } : o,
        ),
      })
    }
    later(900, () => {
      setState("sending", 1)
      patchItem(item.id, {})
      emitDelta({ items: [item.id] })
    })
    later(2400, () => {
      setState("delivered", 1)
      patchItem(item.id, { state: "resolved" })
      patchSession(item.sessionId, { state: "running", lastEventAt: now() })
      addTimeline(item.sessionId, "Reply delivered — session resumed", "UserPromptSubmit")
      emitDelta({ items: [item.id], sessions: [item.sessionId] })
    })
  }

  const closeItem = (itemId: string, state: Item["state"]) => {
    const item = patchItem(itemId, { state, queue: "done", live: false, unread: false })
    emitDelta({ items: [itemId], sessions: [item.sessionId] })
    return item
  }

  const ok = (item: Item | null): ActionResponse => ({ ok: true, item })

  const startSimulation = () => {
    if (simulationStarted || options.simulate === false) {
      return
    }
    simulationStarted = true
    const activity = [
      ["s-delivery", "Edited src/delivery/window.ts"],
      ["s-pos-sync", "Ran bun test — 64 passed"],
      ["s-ravelo-dash", "Wrote src/cache/tiles.ts"],
      ["s-pos-bench", "Benchmark: 4.1k writes/s with batch=50"],
    ] as const
    let tick = 0
    setInterval(() => {
      const [sessionId, text] = activity[tick % activity.length] as (typeof activity)[number]
      tick += 1
      patchSession(sessionId, { lastEventAt: now() })
      addTimeline(sessionId, text)
      emitDelta({ sessions: [sessionId] })
    }, 7000)
    setTimeout(() => {
      // A running session finishes its turn: it moves to idle and a review item appears.
      patchSession("s-delivery", { state: "idle", lastEventAt: now() })
      addTimeline("s-delivery", "Finished: window logic split into 3 modules", "Stop")
      db.items.push({
        id: "i-delivery-review",
        sessionId: "s-delivery",
        agentId: "a-delivery-main",
        kind: "review",
        state: "open",
        queue: "review",
        summary: "Window logic split into 3 modules · 9 files changed",
        unconfirmed: false,
        live: false,
        unread: true,
        snoozeUntil: null,
        createdAt: now(),
        updatedAt: now(),
      })
      patchExtras("i-delivery-review", { openUrl: null })
      emitDelta({ items: ["i-delivery-review"], sessions: ["s-delivery"] })
    }, 15000)
  }

  const snapshot = (): Snapshot => ({
    seq,
    projects: [...db.projects],
    sessions: [...db.sessions],
    agents: [...db.agents],
    items: [...db.items],
    counts: counts(),
  })

  const client: DaemonClientShape = {
    snapshot: Effect.sync(snapshot),

    stream: (since) =>
      Stream.callback<StreamMessage, DaemonError>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listener = (message: StreamMessage) => {
              Queue.offerUnsafe(queue, message)
            }
            Queue.offerUnsafe(queue, { _tag: "hello", seq })
            const replay = since === null ? [] : log.filter((m) => m.seq > since)
            for (const message of replay) {
              Queue.offerUnsafe(queue, message)
            }
            listeners.add(listener)
            startSimulation()
            return listener
          }),
          (listener) => Effect.sync(() => listeners.delete(listener)),
        ).pipe(Effect.flatMap(() => Effect.never)),
      ),

    itemDetail: (itemId) =>
      findItem(itemId).pipe(
        Effect.flatMap((item) => {
          const session = db.sessions.find((s) => s.id === item.sessionId)
          const project = db.projects.find((p) => p.id === session?.projectId)
          if (session === undefined || project === undefined) {
            return Effect.fail(new DaemonError({ message: "broken fixture", status: 500 }))
          }
          const extras = db.extras[itemId]
          const detail: ItemDetail = {
            item,
            session,
            project,
            questions: extras?.questions ?? [],
            approval: extras?.approval ?? null,
            timeline: [...(db.timelines[session.id] ?? [])]
              .sort((a, b) => b.seq - a.seq)
              .map((e) => (e.seq === extras?.sourceSeq ? { ...e, isSource: true } : e)),
            outbox: extras?.outbox ?? [],
            draft: extras?.draft ?? null,
            openUrl: extras?.openUrl ?? null,
          }
          return Effect.succeed(detail)
        }),
      ),

    answers: (itemId, body) =>
      findItem(itemId).pipe(
        Effect.map((item) => {
          const extras = db.extras[itemId]
          patchExtras(itemId, {
            questions: (extras?.questions ?? []).map((q) => ({
              ...q,
              answer: body.answers.find((a) => a.idx === q.idx) ?? null,
            })),
          })
          const text = body.answers
            .map((a) => [...a.selected, ...(a.other ? [a.other] : [])].join(", "))
            .join("\n")
          const next = closeItem(itemId, "answered")
          if (item.live) {
            patchSession(item.sessionId, { state: "running" })
            addTimeline(item.sessionId, "Answered from the inbox", "PreToolUse")
            emitDelta({ sessions: [item.sessionId] })
          } else {
            sendThroughOutbox(next, text, body.idempotencyKey)
          }
          return ok(db.items.find((i) => i.id === itemId) ?? next)
        }),
      ),

    decision: (itemId, body) =>
      findItem(itemId).pipe(
        Effect.map((item) => {
          const approval = db.extras[itemId]?.approval ?? null
          if (approval !== null) {
            patchExtras(itemId, {
              approval: { ...approval, decision: body.decision, decidedAt: now() },
            })
          }
          const next = closeItem(itemId, "answered")
          patchSession(item.sessionId, { state: "running", lastEventAt: now() })
          addTimeline(
            item.sessionId,
            body.decision === "deny" ? "You denied the command" : "You allowed the command",
            "PreToolUse",
          )
          emitDelta({ sessions: [item.sessionId] })
          return ok(next)
        }),
      ),

    reply: (itemId, body) =>
      findItem(itemId).pipe(
        Effect.map(() => {
          const next = closeItem(itemId, "answered")
          sendThroughOutbox(next, body.body, body.idempotencyKey)
          return ok(next)
        }),
      ),

    snooze: (itemId, body) =>
      findItem(itemId).pipe(
        Effect.map((item) => {
          const next = patchItem(itemId, {
            state: "snoozed",
            queue: "snoozed",
            snoozeUntil: body.until,
          })
          emitDelta({ items: [itemId], sessions: [item.sessionId] })
          return ok(next)
        }),
      ),

    dismiss: (itemId) =>
      findItem(itemId).pipe(Effect.map(() => ok(closeItem(itemId, "dismissed")))),

    draft: (itemId, body) =>
      Effect.sync(() => {
        patchExtras(itemId, { draft: body.body })
      }),

    read: (itemId) =>
      findItem(itemId).pipe(
        Effect.map((item) => {
          if (item.unread) {
            patchItem(itemId, { unread: false })
            emitDelta({ items: [itemId] })
          }
          return undefined
        }),
      ),

    open: (itemId) =>
      findItem(itemId).pipe(Effect.map(() => ({ url: db.extras[itemId]?.openUrl ?? null }))),

    mute: (projectId, body) =>
      Effect.sync(() => {
        const index = db.projects.findIndex((p) => p.id === projectId)
        if (index >= 0) {
          db.projects[index] = {
            ...(db.projects[index] as (typeof db.projects)[number]),
            muted: body.muted,
          }
          emitDelta({ projects: [projectId] })
        }
      }),
  }

  return {
    ...client,
    state: () => ({ ...db, seq }),
    emitted: () => log,
  }
}

export const fakeClientService = (options?: FakeOptions) => DaemonClient.of(makeFakeClient(options))
