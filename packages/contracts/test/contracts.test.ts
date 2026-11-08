import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  decodeHookPayload,
  HookEnvelope,
  PreToolUsePayload,
  Routes,
  StreamMessage,
} from "../src/index.ts"

describe("contracts", () => {
  test("decodeHookPayload keeps unknown fields", () => {
    const raw = {
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      brand_new_field: 42,
    }
    const decoded = decodeHookPayload(PreToolUsePayload, raw)
    expect(decoded.tool_name).toBe("Bash")
    expect(decoded.brand_new_field).toBe(42)
    expect(() => decodeHookPayload(PreToolUsePayload, { session_id: "s" })).toThrow()
  })

  test("stream messages round-trip through JSON", () => {
    const msg: StreamMessage = { _tag: "badge", seq: 7, count: 3 }
    const back = Schema.decodeUnknownSync(StreamMessage)(JSON.parse(JSON.stringify(msg)))
    expect(back).toEqual(msg)
  })

  test("envelope requires env", () => {
    expect(() => Schema.decodeUnknownSync(HookEnvelope)({ event: "Stop", payload: {} })).toThrow()
  })

  test("routes", () => {
    expect(Routes.stream(null, "shell")).toBe("/v1/stream?client=shell")
    expect(Routes.stream(5, "ui")).toBe("/v1/stream?client=ui&since=5")
  })
})
