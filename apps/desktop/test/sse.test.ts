import { describe, expect, test } from "bun:test"
import { feed, initialSseState, type SseEvent, type SseState } from "../src/client/sse.ts"

const feedAll = (chunks: ReadonlyArray<string>): { state: SseState; events: Array<SseEvent> } =>
  chunks.reduce<{ state: SseState; events: Array<SseEvent> }>(
    (acc, chunk) => {
      const result = feed(acc.state, chunk)
      return { state: result.state, events: [...acc.events, ...result.events] }
    },
    { state: initialSseState, events: [] },
  )

describe("SSE parser", () => {
  test("parses a complete event with id", () => {
    const { events } = feedAll(['id: 7\ndata: {"_tag":"hello","seq":7}\n\n'])
    expect(events).toEqual([{ event: "message", data: '{"_tag":"hello","seq":7}', id: "7" }])
  })

  test("handles chunk boundaries anywhere, including inside CRLF", () => {
    const whole = 'id: 12\r\ndata: {"a":1}\r\n\r\nid: 13\r\ndata: {"b":2}\r\n\r\n'
    const expected = feedAll([whole]).events
    for (let cut = 1; cut < whole.length; cut++) {
      const split = feedAll([whole.slice(0, cut), whole.slice(cut)]).events
      expect(split).toEqual(expected)
    }
    const charByChar = feedAll(whole.split("")).events
    expect(charByChar).toEqual(expected)
    expect(expected.map((e) => e.id)).toEqual(["12", "13"])
  })

  test("ignores heartbeat comments and keeps the last id sticky", () => {
    const { events, state } = feedAll([
      ": heartbeat\n\n",
      "id: 3\ndata: x\n\n",
      ": ping\n",
      "data: y\n\n",
    ])
    expect(events.map((e) => [e.data, e.id])).toEqual([
      ["x", "3"],
      ["y", "3"],
    ])
    expect(state.lastId).toBe("3")
  })

  test("joins multi-line data and honours event and retry fields", () => {
    const { events, state } = feedAll(["event: delta\ndata: line1\ndata:line2\nretry: 2500\n\n"])
    expect(events).toEqual([{ event: "delta", data: "line1\nline2", id: null }])
    expect(state.retryMs).toBe(2500)
  })

  test("an event without data is not dispatched; an unterminated event waits", () => {
    const first = feedAll(["event: nothing\n\n", "data: pending"])
    expect(first.events).toEqual([])
    expect(feed(first.state, "\n\n").events).toEqual([
      { event: "message", data: "pending", id: null },
    ])
  })
})
