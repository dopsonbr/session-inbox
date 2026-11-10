import { describe, expect, test } from "bun:test"
import type { DiffHunk } from "@session-inbox/contracts"
import { Effect, Option } from "effect"
import { makeFakeClient } from "../src/client/fake.ts"
import { Message } from "../src/message.ts"
import type { Model } from "../src/model.ts"
import { initialModel, type UpdateReturn, update } from "../src/update.ts"
import { COLLAPSED_LINES, diffLineCount, visibleHunks } from "../src/view/preview.ts"

const NOW = 1_800_000_000_000
const client = () => makeFakeClient({ now: () => NOW, simulate: false, delayScale: 0 })
const run = (start: Model, ...messages: ReadonlyArray<Message>): UpdateReturn =>
  messages.reduce<UpdateReturn>((acc, m) => update(acc.model, m), { model: start })
const loaded = (): Model =>
  update(
    initialModel({ view: "full", now: NOW, maybeInitialItemId: Option.none() }),
    Message.SucceededFetchSnapshot({ snapshot: Effect.runSync(client().snapshot) }),
  ).model

describe("preview expand toggle", () => {
  test("toggles, survives a detail refresh, resets when the selection changes", () => {
    const detail = Effect.runSync(client().itemDetail("i-pv-long"))
    const opened = run(
      loaded(),
      Message.ClickedItem({ itemId: "i-pv-long" }),
      Message.SucceededFetchItemDetail({ detail }),
    ).model
    expect(opened.isPreviewExpanded).toBe(false)
    const expanded = update(opened, Message.ToggledPreviewExpanded()).model
    expect(expanded.isPreviewExpanded).toBe(true)
    // A delta-driven refetch of the same item keeps it open; so does re-clicking it.
    expect(
      run(
        expanded,
        Message.SucceededFetchItemDetail({ detail }),
        Message.ClickedItem({ itemId: "i-pv-long" }),
      ).model.isPreviewExpanded,
    ).toBe(true)
    expect(update(expanded, Message.ToggledPreviewExpanded()).model.isPreviewExpanded).toBe(false)
    const other = update(expanded, Message.ClickedItem({ itemId: "i-pv-edit" })).model
    expect(other.isPreviewExpanded).toBe(false)
  })
})

describe("visibleHunks", () => {
  const hunk = (start: number, n: number): DiffHunk => ({
    oldStart: start,
    oldLines: n,
    newStart: start,
    newLines: n,
    lines: Array.from({ length: n }, (_, i) => ({ kind: "context" as const, text: `l${i}` })),
  })

  test("cuts across hunks at the limit, keeping hunk starts", () => {
    const hunks = [hunk(1, 30), hunk(50, 30)]
    expect(diffLineCount(hunks)).toBe(60)
    const shown = visibleHunks(hunks, COLLAPSED_LINES)
    expect(shown.map((h) => h.lines.length)).toEqual([30, 10])
    expect(shown[1]?.oldStart).toBe(50)
    expect(visibleHunks(hunks, 30)).toHaveLength(1)
    expect(visibleHunks(hunks, 100)).toEqual(hunks)
  })

  test("the long fixture starts collapsed", () => {
    const detail = Effect.runSync(client().itemDetail("i-pv-long"))
    const p = detail.approval?.preview
    expect(p?._tag).toBe("diff")
    if (p?._tag === "diff") expect(diffLineCount(p.hunks)).toBeGreaterThan(COLLAPSED_LINES)
  })
})
