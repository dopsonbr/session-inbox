/**
 * Pure line diff for approval previews (D-055): Myers O(ND) on lines after trimming the
 * common prefix/suffix, unified hunks with `context` lines, and caps on what is rendered.
 * Inputs are file-sized strings; anything too big to diff exactly degrades to one
 * "replace the middle" hunk rather than taking long.
 */
import type { DiffHunk, DiffLine } from "@session-inbox/contracts"

export interface DiffOptions {
  /** Context lines around each change. */
  readonly context?: number
  /** Max rendered lines (context + add + del) across all hunks. */
  readonly maxLines?: number
  /** Max rendered text (UTF-16 code units, roughly bytes) across all hunks. */
  readonly maxChars?: number
  /** Longer lines are cut (and the diff marked truncated). */
  readonly maxLineChars?: number
  /** Myers gives up past this edit distance... */
  readonly maxEditDistance?: number
  /** ...or when the differing middle has more lines than this; then the middle is replaced. */
  readonly maxMiddleLines?: number
}

export const DIFF_DEFAULTS = {
  context: 3,
  maxLines: 400,
  maxChars: 64 * 1024,
  maxLineChars: 1000,
  maxEditDistance: 1000,
  maxMiddleLines: 20_000,
} as const

export interface DiffResult {
  readonly hunks: DiffHunk[]
  readonly added: number
  readonly removed: number
  readonly truncated: boolean
  readonly binary: boolean
}

/** Marks a final line that has no newline, so "a" and "a\n" differ. */
const NO_EOL = "\u0000"

export const looksBinary = (s: string): boolean => s.includes("\u0000")

/** Lines of `text` (CRLF normalised to LF); the last one carries NO_EOL when unterminated. */
export const splitLines = (text: string): string[] => {
  if (text === "") return []
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  else lines[lines.length - 1] = `${lines[lines.length - 1]}${NO_EOL}`
  return lines
}

type Op = { readonly t: "eq" | "del" | "add"; readonly a: number; readonly b: number }

/** Myers shortest edit script between a and b, or null past maxD. Indices are into a/b. */
const myers = (a: readonly string[], b: readonly string[], maxD: number): Op[] | null => {
  const n = a.length
  const m = b.length
  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice(offset - d, offset + d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))
          ? (v[offset + k + 1] ?? 0)
          : (v[offset + k - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, n, m)
    }
  }
  return null
}

const backtrack = (trace: Int32Array[], n: number, m: number): Op[] => {
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const snap = trace[d] as Int32Array
    const at = (k: number) => snap[k + d] ?? 0
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : at(prevK)
    const prevY = d === 0 ? 0 : prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      ops.push({ t: "eq", a: x, b: y })
    }
    if (d > 0) {
      if (x === prevX) {
        y--
        ops.push({ t: "add", a: x, b: y })
      } else {
        x--
        ops.push({ t: "del", a: x, b: y })
      }
    }
  }
  return ops.reverse()
}

/** Edit script over whole inputs: common prefix/suffix kept as eq, the middle diffed. */
const editScript = (a: readonly string[], b: readonly string[], o: Required<DiffOptions>): Op[] => {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++
  const ma = a.slice(pre, a.length - suf)
  const mb = b.slice(pre, b.length - suf)
  const ops: Op[] = []
  for (let i = 0; i < pre; i++) ops.push({ t: "eq", a: i, b: i })
  const mid = ma.length + mb.length <= o.maxMiddleLines ? myers(ma, mb, o.maxEditDistance) : null
  if (mid) for (const op of mid) ops.push({ t: op.t, a: op.a + pre, b: op.b + pre })
  else {
    for (let i = 0; i < ma.length; i++) ops.push({ t: "del", a: pre + i, b: pre })
    for (let j = 0; j < mb.length; j++) ops.push({ t: "add", a: pre + ma.length, b: pre + j })
  }
  for (let i = 0; i < suf; i++) ops.push({ t: "eq", a: a.length - suf + i, b: b.length - suf + i })
  return ops
}

/** Unified diff of two texts. Counts cover the whole change; hunks stop at the caps. */
export const diffText = (before: string, after: string, opts: DiffOptions = {}): DiffResult => {
  const o: Required<DiffOptions> = { ...DIFF_DEFAULTS, ...opts }
  if (looksBinary(before) || looksBinary(after))
    return { hunks: [], added: 0, removed: 0, truncated: false, binary: true }
  const a = splitLines(before)
  const b = splitLines(after)
  const ops = editScript(a, b, o)

  let added = 0
  let removed = 0
  const changes: number[] = []
  ops.forEach((op, i) => {
    if (op.t === "add") added++
    if (op.t === "del") removed++
    if (op.t !== "eq") changes.push(i)
  })
  if (changes.length === 0) return { hunks: [], added, removed, truncated: false, binary: false }

  // Group change positions into [start, end] op ranges, merging gaps ≤ 2·context.
  const ranges: Array<[number, number]> = []
  for (const i of changes) {
    const last = ranges[ranges.length - 1]
    if (last && i - last[1] - 1 <= 2 * o.context) last[1] = i
    else ranges.push([i, i])
  }

  const hunks: DiffHunk[] = []
  let truncated = false
  let lines = 0
  let chars = 0
  outer: for (const [first, lastChange] of ranges) {
    const start = Math.max(0, first - o.context)
    const end = Math.min(ops.length - 1, lastChange + o.context)
    const out: DiffLine[] = []
    let oldLines = 0
    let newLines = 0
    const head = ops[start] as Op
    for (let i = start; i <= end; i++) {
      const op = ops[i] as Op
      const raw = (op.t === "add" ? b[op.b] : a[op.a]) ?? ""
      const noEol = raw.endsWith(NO_EOL)
      let text = noEol ? raw.slice(0, -1) : raw
      if (text.length > o.maxLineChars) {
        text = `${text.slice(0, o.maxLineChars)}…`
        truncated = true
      }
      if (lines + 1 > o.maxLines || chars + text.length > o.maxChars) {
        truncated = true
        if (out.length > 0) hunks.push(hunkOf(head, oldLines, newLines, out))
        break outer
      }
      lines++
      chars += text.length
      const kind = op.t === "eq" ? "context" : op.t
      out.push(noEol ? { kind, text, noEol: true } : { kind, text })
      if (op.t !== "add") oldLines++
      if (op.t !== "del") newLines++
    }
    hunks.push(hunkOf(head, oldLines, newLines, out))
  }
  return { hunks, added, removed, truncated, binary: false }
}

const hunkOf = (head: Op, oldLines: number, newLines: number, lines: DiffLine[]): DiffHunk => ({
  // Unified convention: an empty side's start is the line before the hunk (0 at the top).
  oldStart: oldLines === 0 ? head.a : head.a + 1,
  oldLines,
  newStart: newLines === 0 ? head.b : head.b + 1,
  newLines,
  lines,
})
