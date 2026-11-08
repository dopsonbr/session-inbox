/**
 * Fixture loader + replayer. A fixture is JSONL: hook lines `{event, payload, env}`
 * (the recorder's format; `sentAt` optional) and, in synthetic files only, control
 * lines `{"$": "advance"|"tick"|"decide"|"answer"|"snooze", ...}`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Answer, Decision } from "@session-inbox/contracts"
import type { Harness } from "./fakes.ts"

export const FIXTURES = resolve(import.meta.dir, "../../../fixtures")

export type Step =
  | { kind: "hook"; event: string; payload: unknown; env: unknown }
  | { kind: "advance"; ms: number }
  | { kind: "tick" }
  | { kind: "decide"; decision: Decision }
  | { kind: "answer"; answers: Answer[] }
  | { kind: "snooze"; ms: number }

export interface Fixture {
  name: string
  file: string
  steps: Step[]
}

export const loadFixtures = (sub: "synthetic" | "recorded"): Fixture[] => {
  const dir = join(FIXTURES, sub)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => {
      const file = join(dir, f)
      const steps = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l): Step => {
          const o = JSON.parse(l) as Record<string, unknown>
          if (typeof o.$ === "string") return { ...o, kind: o.$ } as unknown as Step
          return {
            kind: "hook",
            event: String(o.event),
            payload: o.payload,
            env: o.env ?? { entrypoint: null, hostSessionId: null, claudePid: null },
          }
        })
      return { name: f.replace(/\.jsonl$/, ""), file, steps }
    })
}

export interface ReplayResult {
  requestIds: string[]
  seqs: number[]
}

export const replay = async (h: Harness, fixture: Fixture): Promise<ReplayResult> => {
  const out: ReplayResult = { requestIds: [], seqs: [] }
  const { engine, clock } = h
  const latest = (
    pred: (r: { id: string; live: boolean; state: string; kind: string }) => boolean,
  ) => {
    const items = engine.snapshot().items.filter(pred)
    const it = items[items.length - 1]
    if (!it) throw new Error(`${fixture.name}: no matching item for control step`)
    return it.id
  }
  let n = 0
  for (const s of fixture.steps) {
    n++
    switch (s.kind) {
      case "hook": {
        const r = await engine.ingest(s.event, {
          event: s.event,
          payload: s.payload,
          env: s.env,
          sentAt: clock.now(),
        })
        out.seqs.push(r.seq)
        if (r.requestId) out.requestIds.push(r.requestId)
        clock.advance(100)
        break
      }
      case "advance":
        clock.advance(s.ms)
        break
      case "tick":
        engine.tick()
        break
      case "decide":
        engine.decide(
          latest((i) => i.live),
          s.decision,
          `fx:${fixture.name}:${n}`,
        )
        break
      case "answer":
        engine.answers(
          latest((i) => i.kind === "question" && i.state === "open"),
          `fx:${fixture.name}:${n}`,
          s.answers,
        )
        break
      case "snooze":
        engine.snooze(
          latest((i) => i.state === "open"),
          clock.now() + s.ms,
        )
        break
    }
    await engine.idle()
  }
  return out
}
