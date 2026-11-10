import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { makeFakeClient } from "../src/client/fake.ts"

const NOW = 1_800_000_000_000
const fake = () => makeFakeClient({ now: () => NOW, simulate: false, delayScale: 0 })

describe("fake DaemonClient", () => {
  test("snapshot matches the mockup counts", async () => {
    const snapshot = await Effect.runPromise(fake().snapshot)
    // The mockup's 3 needs-you items plus 4 approval-preview fixtures (U-031).
    expect(snapshot.counts).toEqual({ needsYou: 7, working: 4, review: 3, snoozed: 1 })
    expect(snapshot.projects.map((p) => p.name)).toEqual([
      "order-up-api",
      "ravelo-insights",
      "agent-kit",
      "simple-offline-pos",
    ])
  })

  test("item detail carries questions / approval", async () => {
    const client = fake()
    const questions = await Effect.runPromise(client.itemDetail("i-retry-questions"))
    expect(questions.questions).toHaveLength(2)
    const permission = await Effect.runPromise(client.itemDetail("i-ravelo-migrate"))
    expect(permission.approval?.input).toMatchObject({ command: "bun run migrate" })
    expect(permission.approval?.preview?._tag).toBe("command")
    const edit = await Effect.runPromise(client.itemDetail("i-pv-edit"))
    expect(edit.approval?.preview?._tag).toBe("diff")
  })

  test("decision closes the item and emits a delta with new counts", async () => {
    const client = fake()
    const response = await Effect.runPromise(
      client.decision("i-ravelo-migrate", { idempotencyKey: "k1", decision: "allow" }),
    )
    expect(response.item?.queue).toBe("done")
    const deltas = client.emitted().filter((m) => m._tag === "delta")
    expect(deltas.at(-1)?._tag === "delta" && deltas.at(-1)).toMatchObject({
      counts: { needsYou: 6 },
    })
  })

  test("a reply walks the outbox to delivered", async () => {
    const client = fake()
    await Effect.runPromise(
      client.reply("i-receipts-review", { idempotencyKey: "r1", body: "ship it" }),
    )
    const detail = await Effect.runPromise(client.itemDetail("i-receipts-review"))
    expect(detail.outbox.map((o) => o.state)).toEqual(["delivered"])
  })

  test("stream says hello, then replays deltas after `since`", async () => {
    const client = fake()
    const before = (await Effect.runPromise(client.snapshot)).seq
    await Effect.runPromise(client.dismiss("i-hooks-failed"))
    const messages = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(client.stream(before), 2)),
        )
        return yield* Fiber.join(fiber)
      }),
    )
    expect(Array.from(messages).map((m) => m._tag)).toEqual(["hello", "delta"])
  })
})
