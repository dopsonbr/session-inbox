import { describe, expect, test } from "bun:test"
import type { DiffHunk } from "@session-inbox/contracts"
import { diffText, splitLines } from "../src/domain/diff.ts"

const lines = (n: number, f = (i: number) => `line ${i}`) =>
  `${Array.from({ length: n }, (_, i) => f(i + 1)).join("\n")}\n`

/** Hunks as unified-diff text, for readable expectations. */
const unified = (hunks: readonly DiffHunk[]) =>
  hunks
    .map(
      (h) =>
        `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines
          .map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`)
          .join("\n")}`,
    )
    .join("\n")

/** Apply hunks to `before` and check we get `after` back (round trip). */
const apply = (before: string, hunks: readonly DiffHunk[]) => {
  const a = splitLines(before).map((l) => l.replace("\u0000", ""))
  const out: string[] = []
  let at = 0
  for (const h of hunks) {
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1
    while (at < start) out.push(a[at++] as string)
    for (const l of h.lines) {
      if (l.kind === "add") out.push(l.text)
      else {
        expect(a[at]).toBe(l.text)
        at++
        if (l.kind === "context") out.push(l.text)
      }
    }
  }
  while (at < a.length) out.push(a[at++] as string)
  return out
}

describe("diffText", () => {
  test("identical inputs: no hunks", () => {
    const d = diffText("a\nb\n", "a\nb\n")
    expect(d).toEqual({ hunks: [], added: 0, removed: 0, truncated: false, binary: false })
    expect(diffText("", "").hunks).toEqual([])
  })

  test("insert in the middle, with 3 lines of context", () => {
    const before = lines(10)
    const after = before.replace("line 5\n", "line 5\nnew\n")
    const d = diffText(before, after)
    expect(unified(d.hunks)).toBe(
      [
        "@@ -3,6 +3,7 @@",
        " line 3",
        " line 4",
        " line 5",
        "+new",
        " line 6",
        " line 7",
        " line 8",
      ].join("\n"),
    )
    expect([d.added, d.removed]).toEqual([1, 0])
  })

  test("delete at the top", () => {
    const d = diffText(lines(5), lines(5).replace("line 1\n", ""))
    expect(unified(d.hunks)).toBe(
      ["@@ -1,4 +1,3 @@", "-line 1", " line 2", " line 3", " line 4"].join("\n"),
    )
  })

  test("replacement at the end", () => {
    const d = diffText(lines(5), lines(5).replace("line 5", "LINE 5"))
    expect(unified(d.hunks)).toBe(
      ["@@ -2,4 +2,4 @@", " line 2", " line 3", " line 4", "-line 5", "+LINE 5"].join("\n"),
    )
    expect([d.added, d.removed]).toEqual([1, 1])
  })

  test("far-apart changes make separate hunks; close ones merge", () => {
    const before = lines(40)
    const far = before.replace("line 5\n", "five\n").replace("line 30\n", "thirty\n")
    const df = diffText(before, far)
    expect(df.hunks).toHaveLength(2)
    expect(df.hunks[1]?.oldStart).toBe(27)
    expect(apply(before, df.hunks)).toEqual(splitLines(far))
    // 6 equal lines between changes (= 2 × context) still merge into one hunk.
    const near = before.replace("line 5\n", "five\n").replace("line 12\n", "twelve\n")
    const dn = diffText(before, near)
    expect(dn.hunks).toHaveLength(1)
    expect(dn.hunks[0]?.lines).toHaveLength(3 + 1 + 1 + 6 + 1 + 1 + 3)
    // 7 apart → two hunks.
    const apart = before.replace("line 5\n", "five\n").replace("line 13\n", "thirteen\n")
    expect(diffText(before, apart).hunks).toHaveLength(2)
  })

  test("interleaved edits round-trip", () => {
    const before = lines(60, (i) => `v${i % 7} ${i}`)
    const after = lines(60, (i) => (i % 9 === 0 ? `changed ${i}` : `v${i % 7} ${i}`)).replace(
      "v3 10\n",
      "v3 10\ninserted\n",
    )
    const d = diffText(before, after)
    expect(apply(before, d.hunks)).toEqual(splitLines(after))
    expect(d.added).toBe(7)
    expect(d.removed).toBe(6)
  })

  test("empty ↔ non-empty", () => {
    const add = diffText("", "a\nb\n")
    expect(unified(add.hunks)).toBe(["@@ -0,0 +1,2 @@", "+a", "+b"].join("\n"))
    const del = diffText("a\nb\n", "")
    expect(unified(del.hunks)).toBe(["@@ -1,2 +0,0 @@", "-a", "-b"].join("\n"))
    expect([del.added, del.removed]).toEqual([0, 2])
  })

  test("CRLF is normalised: same text with other line endings is no change", () => {
    expect(diffText("a\r\nb\r\n", "a\nb\n").hunks).toEqual([])
    const d = diffText("a\r\nb\r\nc\r\n", "a\nB\nc\n")
    expect(unified(d.hunks)).toBe(["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"].join("\n"))
  })

  test("missing trailing newline is a change, flagged noEol", () => {
    const d = diffText("a\nb", "a\nb\n")
    expect(d.hunks[0]?.lines).toEqual([
      { kind: "context", text: "a" },
      { kind: "del", text: "b", noEol: true },
      { kind: "add", text: "b" },
    ])
    const same = diffText("x\ny", "x\ny")
    expect(same.hunks).toEqual([])
  })

  test("binary-looking content: no hunks", () => {
    const d = diffText("PNG\u0000\u0001", "text\n")
    expect(d.binary).toBe(true)
    expect(d.hunks).toEqual([])
  })

  test("line cap truncates but counts stay whole", () => {
    const d = diffText("", lines(1000))
    expect(d.truncated).toBe(true)
    expect(d.added).toBe(1000)
    expect(d.hunks.flatMap((h) => h.lines)).toHaveLength(400)
    expect(d.hunks[0]?.newLines).toBe(400)
    const small = diffText("", lines(30), { maxLines: 10 })
    expect(small.hunks[0]?.lines).toHaveLength(10)
  })

  test("text cap and long lines", () => {
    const long = `${"x".repeat(5000)}\n`
    const d = diffText("", long)
    expect(d.truncated).toBe(true)
    expect(d.hunks[0]?.lines[0]?.text.length).toBe(1001)
    const chars = diffText(
      "",
      lines(300, () => "y".repeat(900)),
    )
    expect(chars.truncated).toBe(true)
    const total = chars.hunks.flatMap((h) => h.lines).reduce((n, l) => n + l.text.length, 0)
    expect(total).toBeLessThanOrEqual(64 * 1024)
  })

  test("a cut stops mid-way through later hunks", () => {
    const before = lines(200)
    let after = before
    for (let i = 10; i <= 190; i += 20) after = after.replace(`line ${i}\n`, `L${i}\n`)
    const d = diffText(before, after, { maxLines: 20 })
    expect(d.truncated).toBe(true)
    expect(d.hunks.flatMap((h) => h.lines)).toHaveLength(20)
    expect(d.added).toBe(10)
  })

  test("huge rewrites degrade to one replace hunk quickly", () => {
    const a = lines(15_000, (i) => `a${i}`)
    const b = lines(15_000, (i) => `b${i}`)
    const t = performance.now()
    const d = diffText(a, b)
    expect(performance.now() - t).toBeLessThan(500)
    expect([d.added, d.removed]).toEqual([15_000, 15_000])
    expect(d.truncated).toBe(true)
    expect(d.hunks[0]?.lines.every((l) => l.kind === "del")).toBe(true)
  })

  test("past the edit-distance cap the middle is replaced, still correct", () => {
    const a = lines(50, (i) => `a${i}`)
    const b = lines(50, (i) => `b${i}`)
    const d = diffText(a, b, { maxEditDistance: 5 })
    expect([d.added, d.removed]).toEqual([50, 50])
    expect(apply(a, d.hunks)).toEqual(splitLines(b))
  })
})
