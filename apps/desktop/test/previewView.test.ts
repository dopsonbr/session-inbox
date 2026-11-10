import { describe, expect, test } from "bun:test"
import type { Approval } from "@session-inbox/contracts"
import { Effect } from "effect"
import { type HtmlBuilder, inertHtml } from "foldkit/html"
import { makeFakeClient } from "../src/client/fake.ts"
import type { Message } from "../src/message.ts"
import { contextLine, previewView } from "../src/view/preview.ts"

/** All text in a rendered vnode tree, in order. */
const textOf = (node: unknown): string => {
  if (node === null || node === undefined) return ""
  if (typeof node === "string") return node
  const n = node as { text?: unknown; children?: ReadonlyArray<unknown> }
  return `${typeof n.text === "string" ? n.text : ""}${(n.children ?? []).map(textOf).join("")}`
}

// Renders vnodes without a runtime; handlers are never fired here.
const h = inertHtml as unknown as HtmlBuilder<Message>
const approvalOf = (id: string): Approval => {
  const client = makeFakeClient({ now: () => 0, simulate: false, delayScale: 0 })
  const a = Effect.runSync(client.itemDetail(id)).approval
  if (a === null) throw new Error(`${id} has no approval`)
  return a
}

describe("previewView", () => {
  test("Edit diff: path, counts, hunk header, both sides", () => {
    const t = textOf(previewView(h, approvalOf("i-pv-edit"), false))
    expect(t).toContain("src/delivery/window.ts")
    expect(t).toContain("+6")
    expect(t).toContain("−2")
    expect(t).toContain("@@ −12,")
    expect(t).toContain("const end = addMinutes(start, 30)")
    expect(t).not.toContain("Show all")
  })

  test("new-file Write is badged", () => {
    expect(textOf(previewView(h, approvalOf("i-pv-write"), false))).toContain("new file")
  })

  test("long diff collapses until expanded", () => {
    const a = approvalOf("i-pv-long")
    const collapsed = textOf(previewView(h, a, false))
    expect(collapsed).toContain("Show all 142 lines")
    expect(collapsed).toContain("truncated")
    expect(collapsed).not.toContain("field70")
    const open = textOf(previewView(h, a, true))
    expect(open).toContain("field70")
    expect(open).toContain("Show fewer lines")
  })

  test("Bash and WebFetch", () => {
    const bash = textOf(previewView(h, approvalOf("i-ravelo-migrate"), false))
    expect(bash).toContain("bun run migrate")
    expect(bash).toContain("Apply 3 pending migrations")
    expect(bash).toContain("timeout 2 min")
    const fetch = textOf(previewView(h, approvalOf("i-pv-fetch"), false))
    expect(fetch).toContain("https://developer.squareup.com/")
    expect(fetch).toContain("cursor pagination")
  })

  test("context line, and no preview → null (caller falls back)", () => {
    expect(textOf(contextLine(h, approvalOf("i-pv-edit")))).toStartWith("Claude: The window end")
    const bare = { ...approvalOf("i-pv-edit"), preview: undefined, context: undefined }
    expect(previewView(h, bare, false)).toBeNull()
    expect(contextLine(h, bare)).toBeNull()
  })
})
