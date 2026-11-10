/**
 * Stream fan-out with a replay ring. `delta`/`badge` go into the ring (resume
 * with `since`); `notify` is live-only and goes to shell clients (pending
 * notifications are re-sent from the DB when a shell connects).
 */
import type { StreamMessage } from "@session-inbox/contracts"

export type ClientKind = "ui" | "shell"

export interface StreamClient {
  readonly kind: ClientKind
  readonly send: (frame: string) => void
}

export const RING_SIZE = 1000

export const sseFrame = (msg: StreamMessage, withId = true): string =>
  `${withId ? `id: ${msg.seq}\n` : ""}data: ${JSON.stringify(msg)}\n\n`

export class StreamHub {
  private ring: StreamMessage[] = []
  /** Every message with seq > floor is in the ring. */
  private floor: number
  private readonly clients = new Set<StreamClient>()
  onShellChange: ((connected: boolean) => void) | null = null
  /** Sent in every `hello` so a page can tell which daemon build it talks to (C-014). */
  info: { version?: string; build?: string } = {}
  /** Live-only messages sent to each new client after hello/replay (update status, C-013). */
  greeting: (() => StreamMessage | null) | null = null
  /** Sent to each new client after the greeting: every shortcut's key press (C-029). */
  shortcutsGreeting: (() => StreamMessage) | null = null
  /** Sent to each new UI client after the greeting: the current setup-check attention (C-021). */
  doctorGreeting: (() => StreamMessage | null) | null = null

  constructor(startSeq: number) {
    this.floor = startSeq
  }

  get shellConnected(): boolean {
    for (const c of this.clients) if (c.kind === "shell") return true
    return false
  }

  get clientCount(): number {
    return this.clients.size
  }

  publish(msg: StreamMessage): void {
    if (msg._tag === "notify" || msg._tag === "unnotify") {
      const frame = sseFrame(msg, false)
      for (const c of this.clients) if (c.kind === "shell") this.safeSend(c, frame)
      return
    }
    if (msg._tag === "update" || msg._tag === "shortcuts") {
      // Live-only, every client: each (re)connect gets the current status as a greeting.
      const frame = sseFrame(msg, false)
      for (const c of this.clients) this.safeSend(c, frame)
      return
    }
    if (msg._tag === "doctor") {
      // Live-only, pages only: "refetch the setup check" (C-021).
      const frame = sseFrame(msg, false)
      for (const c of this.clients) if (c.kind === "ui") this.safeSend(c, frame)
      return
    }
    this.ring.push(msg)
    if (this.ring.length > RING_SIZE) {
      const dropped = this.ring.splice(0, this.ring.length - RING_SIZE)
      const last = dropped[dropped.length - 1]
      if (last) this.floor = Math.max(this.floor, last.seq)
      // Messages sharing the dropped seq can no longer be replayed completely.
      this.ring = this.ring.filter((m) => m.seq > this.floor)
    }
    const frame = sseFrame(msg)
    for (const c of this.clients) this.safeSend(c, frame)
  }

  /**
   * Attach a client. Sends `hello`, then either the replay since `since` or a
   * `reset` when the ring can't cover it.
   */
  subscribe(client: StreamClient, since: number | null, currentSeq: number): () => void {
    client.send(sseFrame({ _tag: "hello", seq: currentSeq, ...this.info }))
    if (since !== null) {
      if (since < this.floor || since > currentSeq) {
        client.send(sseFrame({ _tag: "reset", seq: currentSeq }))
      } else {
        for (const m of this.ring) if (m.seq > since) client.send(sseFrame(m))
      }
    }
    const greeting = this.greeting?.()
    if (greeting) client.send(sseFrame(greeting, false))
    const shortcuts = this.shortcutsGreeting?.()
    if (shortcuts) client.send(sseFrame(shortcuts, false))
    const doctor = client.kind === "ui" ? this.doctorGreeting?.() : null
    if (doctor) client.send(sseFrame(doctor, false))
    const wasShell = this.shellConnected
    this.clients.add(client)
    if (client.kind === "shell" && !wasShell) this.onShellChange?.(true)
    return () => {
      this.clients.delete(client)
      if (client.kind === "shell" && !this.shellConnected) this.onShellChange?.(false)
    }
  }

  heartbeat(): void {
    for (const c of this.clients) this.safeSend(c, ": hb\n\n")
  }

  private safeSend(c: StreamClient, frame: string) {
    try {
      c.send(frame)
    } catch {
      this.clients.delete(c)
    }
  }
}
