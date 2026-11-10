/**
 * Approval previews (C-019, D-055..): what a held tool call would do, computed once when
 * the hold is created. Pure apart from the injected `read`, so tests pass a fake.
 */
import { isAbsolute, resolve } from "node:path"
import type { ApprovalPreview } from "@session-inbox/contracts"
import { type DiffOptions, diffText } from "./diff.ts"

/** Files bigger than this are not read for a preview (→ approximate). */
export const PREVIEW_MAX_FILE_BYTES = 1024 * 1024
/** Pretty-printed input for unknown tools is cut here. */
export const GENERIC_MAX_CHARS = 4000

export type ReadResult =
  | { readonly _tag: "ok"; readonly text: string }
  | { readonly _tag: "missing" }
  | { readonly _tag: "unreadable"; readonly reason: string }

export interface PreviewContext {
  /** Session cwd (relative tool paths resolve against it). */
  readonly cwd: string | null
  /** Display paths are relative to these when inside them, most specific first (worktree, root). */
  readonly roots: ReadonlyArray<string | null>
  /** Size-capped, synchronous read of an absolute path. */
  readonly read: (absPath: string) => ReadResult
  readonly diff?: DiffOptions
}

const str = (input: unknown, key: string): string | null => {
  const v = (input as Record<string, unknown> | null | undefined)?.[key]
  return typeof v === "string" ? v : null
}

/** `path` relative to the first base it sits inside; unchanged otherwise. */
export const displayPathFor = (path: string, bases: ReadonlyArray<string | null>): string => {
  for (const base of bases) {
    if (!base || !isAbsolute(base)) continue
    const b = base.endsWith("/") ? base.slice(0, -1) : base
    if (path === b) return "."
    if (path.startsWith(`${b}/`)) return path.slice(b.length + 1)
  }
  return path
}

const absPath = (path: string, cwd: string | null) =>
  isAbsolute(path) ? path : cwd ? resolve(cwd, path) : path

const lf = (s: string) => s.replace(/\r\n/g, "\n")

type Diff = Extract<ApprovalPreview, { _tag: "diff" }>

const diffPreview = (
  path: string,
  ctx: PreviewContext,
  before: string,
  after: string,
  flags: { isNewFile?: boolean; approximate?: boolean; label?: string },
): Diff => {
  const d = diffText(before, after, ctx.diff)
  const display = displayPathFor(path, [...ctx.roots, ctx.cwd])
  return {
    _tag: "diff",
    path,
    displayPath: flags.label ? `${display} · ${flags.label}` : display,
    isNewFile: flags.isNewFile ?? false,
    approximate: flags.approximate ?? false,
    binary: d.binary,
    hunks: d.hunks,
    added: d.added,
    removed: d.removed,
    truncated: d.truncated,
  }
}

interface EditSpec {
  readonly old: string
  readonly new: string
  readonly all: boolean
}

const editsOf = (input: unknown): EditSpec[] | null => {
  const raw = (input as { edits?: unknown } | null)?.edits
  const list = Array.isArray(raw) ? raw : [input]
  const out: EditSpec[] = []
  for (const e of list) {
    const o = str(e, "old_string")
    const n = str(e, "new_string")
    if (o === null || n === null) return null
    out.push({
      old: o,
      new: n,
      all: (e as Record<string, unknown>).replace_all === true,
    })
  }
  return out
}

/** Apply edits in order, Claude-style; null when an old string isn't there. */
export const applyEdits = (content: string, edits: ReadonlyArray<EditSpec>): string | null => {
  let text = content
  for (const e of edits) {
    const o = lf(e.old)
    const n = lf(e.new)
    if (o === "") {
      if (text !== "") return null
      text = n
      continue
    }
    const at = text.indexOf(o)
    if (at < 0) return null
    text = e.all ? text.split(o).join(n) : text.slice(0, at) + n + text.slice(at + o.length)
  }
  return text
}

const editPreview = (input: unknown, ctx: PreviewContext): Diff | null => {
  const file = str(input, "file_path")
  const edits = editsOf(input)
  if (!file || !edits || edits.length === 0) return null
  const path = absPath(file, ctx.cwd)
  const approx = () =>
    diffPreview(path, ctx, edits.map((e) => e.old).join("\n"), edits.map((e) => e.new).join("\n"), {
      approximate: true,
    })
  const r = ctx.read(path)
  if (r._tag === "missing") {
    // An empty old_string on a missing file creates it.
    const created = applyEdits("", edits)
    return created === null ? approx() : diffPreview(path, ctx, "", created, { isNewFile: true })
  }
  if (r._tag === "unreadable") return approx()
  const before = lf(r.text)
  const after = applyEdits(before, edits)
  return after === null ? approx() : diffPreview(path, ctx, before, after, {})
}

const writePreview = (input: unknown, ctx: PreviewContext): Diff | null => {
  const file = str(input, "file_path")
  const content = str(input, "content")
  if (!file || content === null) return null
  const path = absPath(file, ctx.cwd)
  const r = ctx.read(path)
  if (r._tag === "missing") return diffPreview(path, ctx, "", content, { isNewFile: true })
  if (r._tag === "unreadable") return diffPreview(path, ctx, "", content, { approximate: true })
  return diffPreview(path, ctx, r.text, content, {})
}

const cellSource = (cell: unknown): string => {
  const s = (cell as { source?: unknown } | null)?.source
  if (typeof s === "string") return s
  if (Array.isArray(s)) return s.filter((x) => typeof x === "string").join("")
  return ""
}

const notebookPreview = (input: unknown, ctx: PreviewContext): Diff | null => {
  const file = str(input, "notebook_path")
  if (!file) return null
  const path = absPath(file, ctx.cwd)
  const mode = str(input, "edit_mode") ?? "replace"
  const cellId = str(input, "cell_id")
  const next = mode === "delete" ? "" : (str(input, "new_source") ?? "")
  const label = cellId ? `cell ${cellId}` : "new cell"
  if (mode === "insert") return diffPreview(path, ctx, "", next, { label })
  const r = ctx.read(path)
  let cells: unknown[] | null = null
  if (r._tag === "ok") {
    try {
      const nb = JSON.parse(r.text) as { cells?: unknown }
      if (Array.isArray(nb.cells)) cells = nb.cells
    } catch {
      cells = null
    }
  }
  const byNumber = cellId?.match(/^cell-(\d+)$/)
  const cell =
    cells?.find((c) => (c as { id?: unknown } | null)?.id === cellId) ??
    (byNumber ? cells?.[Number(byNumber[1])] : undefined)
  if (cell === undefined) return diffPreview(path, ctx, "", next, { label, approximate: true })
  return diffPreview(path, ctx, cellSource(cell), next, { label })
}

const commandPreview = (
  input: unknown,
  ctx: PreviewContext,
): Extract<ApprovalPreview, { _tag: "command" }> | null => {
  const command = str(input, "command")
  if (command === null) return null
  const rec = input as Record<string, unknown>
  const cwd = ctx.cwd
  return {
    _tag: "command",
    command,
    description: str(input, "description"),
    cwd,
    displayCwd: cwd ? displayPathFor(cwd, ctx.roots) : null,
    ...(typeof rec.run_in_background === "boolean" ? { background: rec.run_in_background } : {}),
    ...(typeof rec.timeout === "number" ? { timeoutMs: rec.timeout } : {}),
  }
}

const genericPreview = (input: unknown): ApprovalPreview => {
  let text: string
  try {
    text = JSON.stringify(input, null, 2) ?? String(input)
  } catch {
    text = String(input)
  }
  const truncated = text.length > GENERIC_MAX_CHARS
  return {
    _tag: "generic",
    text: truncated ? `${text.slice(0, GENERIC_MAX_CHARS)}…` : text,
    truncated,
  }
}

/** The preview for a held call, or null (AskUserQuestion, or input we can't make sense of). */
export const buildPreview = (
  tool: string,
  input: unknown,
  ctx: PreviewContext,
): ApprovalPreview | null => {
  switch (tool) {
    case "AskUserQuestion":
      return null
    case "Edit":
    case "MultiEdit":
      return editPreview(input, ctx) ?? genericPreview(input)
    case "Write":
      return writePreview(input, ctx) ?? genericPreview(input)
    case "NotebookEdit":
      return notebookPreview(input, ctx) ?? genericPreview(input)
    case "Bash":
      return commandPreview(input, ctx) ?? genericPreview(input)
    case "WebFetch": {
      const url = str(input, "url")
      return url ? { _tag: "fetch", url, prompt: str(input, "prompt") } : genericPreview(input)
    }
    default:
      return genericPreview(input)
  }
}

const shortPath = (s: string, n = 60) => (s.length > n ? `…${s.slice(s.length - n + 1)}` : s)

/** Item summary for a diff preview: "Wants to edit src/foo.ts +12 −3"; null otherwise. */
export const previewSummary = (tool: string, p: ApprovalPreview | null): string | null => {
  if (p?._tag !== "diff") return null
  const verb = p.isNewFile ? "create" : tool === "Write" ? "write" : "edit"
  const path = shortPath(p.displayPath)
  return p.binary
    ? `Wants to ${verb} ${path}`
    : `Wants to ${verb} ${path} +${p.added} −${p.removed}`
}
