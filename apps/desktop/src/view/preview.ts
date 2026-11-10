/**
 * Approval previews (U-031): renders the daemon's `approval.preview` as given — a diff with
 * line-number gutters, a command block, a fetch, or pretty-printed input. The only local
 * decision is how many lines to show before "Show all".
 */
import type { Approval, ApprovalPreview, DiffHunk, DiffLine } from "@session-inbox/contracts"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "../message.ts"

type H = HtmlBuilder<Message>
type Diff = Extract<ApprovalPreview, { _tag: "diff" }>

/** Diffs longer than this start collapsed. */
export const COLLAPSED_LINES = 40

export const diffLineCount = (hunks: ReadonlyArray<DiffHunk>): number =>
  hunks.reduce((n, hk) => n + hk.lines.length, 0)

/** The first `limit` lines of `hunks`, cut mid-hunk if needed (headers keep their starts). */
export const visibleHunks = (
  hunks: ReadonlyArray<DiffHunk>,
  limit: number,
): ReadonlyArray<DiffHunk> => {
  const out: DiffHunk[] = []
  let left = limit
  for (const hk of hunks) {
    if (left <= 0) break
    out.push(hk.lines.length <= left ? hk : { ...hk, lines: hk.lines.slice(0, left) })
    left -= hk.lines.length
  }
  return out
}

const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "−", context: " " }
const ROW: Record<DiffLine["kind"], string> = {
  add: "diff-add",
  del: "diff-del",
  context: "",
}

const badge = (h: H, text: string, title: string, tone = "text-muted-foreground"): Html =>
  h.span(
    [
      h.Class(
        `inline-flex items-center rounded-full border border-border px-2 text-[11px] font-semibold ${tone}`,
      ),
      h.Title(title),
    ],
    [text],
  )

const hunkRows = (h: H, hk: DiffHunk): ReadonlyArray<Html> => {
  let oldNo = hk.oldStart
  let newNo = hk.newStart
  const rows: Html[] = [
    h.tr(
      [h.Class("diff-hunk")],
      [
        h.td(
          [h.Colspan(4)],
          [`@@ −${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@`],
        ),
      ],
    ),
  ]
  for (const line of hk.lines) {
    const o = line.kind === "add" ? "" : String(oldNo++)
    const n = line.kind === "del" ? "" : String(newNo++)
    rows.push(
      h.tr(
        [h.Class(ROW[line.kind])],
        [
          h.td([h.Class("diff-num"), h.AriaHidden(true)], [o]),
          h.td([h.Class("diff-num"), h.AriaHidden(true)], [n]),
          h.td(
            [h.Class("diff-sign")],
            [
              line.kind === "context"
                ? h.empty
                : h.span(
                    [h.AriaLabel(line.kind === "add" ? "added" : "removed")],
                    [SIGN[line.kind]],
                  ),
            ],
          ),
          h.td(
            [h.Class("diff-text")],
            [
              line.text,
              line.noEol === true
                ? h.span([h.Class("diff-noeol")], [" (no newline at end of file)"])
                : h.empty,
            ],
          ),
        ],
      ),
    )
  }
  return rows
}

const diffView = (h: H, p: Diff, expanded: boolean): Html => {
  const total = diffLineCount(p.hunks)
  const collapsible = total > COLLAPSED_LINES
  const shown = collapsible && !expanded ? visibleHunks(p.hunks, COLLAPSED_LINES) : p.hunks
  return h.div(
    [h.Class("flex flex-col gap-2")],
    [
      h.div(
        [h.Class("flex flex-wrap items-center gap-2 text-[13px]")],
        [
          h.span(
            [h.Class("min-w-0 font-mono font-semibold break-all text-foreground"), h.Title(p.path)],
            [p.displayPath],
          ),
          p.binary
            ? h.empty
            : h.span(
                [
                  h.Class("font-mono text-xs"),
                  h.AriaLabel(`${p.added} added, ${p.removed} removed`),
                ],
                [
                  h.span([h.Class("text-ready")], [`+${p.added}`]),
                  " ",
                  h.span([h.Class("text-failed")], [`−${p.removed}`]),
                ],
              ),
          p.isNewFile ? badge(h, "new file", "This file doesn't exist yet", "text-ready") : h.empty,
          p.binary ? badge(h, "binary", "Binary content: no line diff") : h.empty,
          p.approximate
            ? badge(
                h,
                "approximate",
                "Couldn't match this against the file on disk: showing the edit's old and new text, with line numbers from 1",
                "text-needs",
              )
            : h.empty,
          p.truncated
            ? badge(h, "truncated", "Too long to show in full: the inbox kept the first part")
            : h.empty,
        ],
      ),
      p.binary || p.hunks.length === 0
        ? h.p(
            [h.Class("text-[13px] text-muted-foreground")],
            [p.binary ? "Binary file — no preview." : "No changes to the file's text."],
          )
        : h.div(
            [h.Class("diff-scroll")],
            [
              h.table(
                [h.Class("diff"), h.AriaLabel(`Changes to ${p.displayPath}`)],
                [
                  h.tbody(
                    [],
                    shown.flatMap((hk) => hunkRows(h, hk)),
                  ),
                ],
              ),
            ],
          ),
      collapsible
        ? h.button(
            [
              h.Type("button"),
              h.Class("btn self-start"),
              h.DataAttribute("variant", "ghost"),
              h.DataAttribute("size", "sm"),
              h.AriaExpanded(expanded),
              h.OnClick(Message.ToggledPreviewExpanded()),
            ],
            [expanded ? "Show fewer lines" : `Show all ${total} lines`],
          )
        : h.empty,
      p.truncated
        ? h.p(
            [h.Class("text-xs text-subtle-foreground")],
            [`The full change is +${p.added} −${p.removed}; open it in Claude to see the rest.`],
          )
        : h.empty,
    ],
  )
}

const codeBlock = (h: H, text: string, wrap: boolean): Html =>
  h.pre(
    [
      h.Class(
        `m-0 overflow-x-auto rounded-lg bg-code px-3 py-2 font-mono text-[13px] ${wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`,
      ),
    ],
    [h.code([], [text])],
  )

const seconds = (ms: number) =>
  ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`

const commandView = (h: H, p: Extract<ApprovalPreview, { _tag: "command" }>): Html =>
  h.div(
    [h.Class("flex flex-col gap-2")],
    [
      p.description === null
        ? h.empty
        : h.p([h.Class("text-[13px] text-foreground")], [p.description]),
      codeBlock(h, p.command, true),
      h.p(
        [h.Class("flex flex-wrap gap-x-3 text-xs text-muted-foreground")],
        [
          p.cwd === null
            ? h.empty
            : h.span(
                [h.Title(p.cwd)],
                ["in ", h.span([h.Class("font-mono")], [p.displayCwd ?? p.cwd])],
              ),
          p.timeoutMs === undefined ? h.empty : h.span([], [`timeout ${seconds(p.timeoutMs)}`]),
          p.background === true ? h.span([], ["runs in the background"]) : h.empty,
        ],
      ),
    ],
  )

const fetchView = (h: H, p: Extract<ApprovalPreview, { _tag: "fetch" }>): Html =>
  h.div(
    [h.Class("flex flex-col gap-2")],
    [
      codeBlock(h, p.url, true),
      p.prompt === null
        ? h.empty
        : h.p(
            [h.Class("text-[13px] text-foreground")],
            [h.span([h.Class("text-muted-foreground")], ["Asks: "]), p.prompt],
          ),
    ],
  )

const genericView = (h: H, p: Extract<ApprovalPreview, { _tag: "generic" }>): Html =>
  h.div(
    [h.Class("flex flex-col gap-2")],
    [
      h.div([h.Class("max-h-80 overflow-y-auto rounded-lg")], [codeBlock(h, p.text, false)]),
      p.truncated
        ? h.p([h.Class("text-xs text-subtle-foreground")], ["Input truncated."])
        : h.empty,
    ],
  )

/** "Claude: …" — what Claude said just before asking. */
export const contextLine = (h: H, approval: Approval): Html =>
  approval.context === undefined
    ? h.empty
    : h.blockquote(
        [h.Class("m-0 border-l-2 border-rail pl-3 text-[13px] text-muted-foreground")],
        [h.span([h.Class("font-semibold")], ["Claude: "]), approval.context],
      )

/** The preview body, or null when the daemon sent none (older rows): the caller falls back. */
export const previewView = (h: H, approval: Approval, expanded: boolean): Html | null => {
  const p = approval.preview
  if (p === undefined) return null
  switch (p._tag) {
    case "diff":
      return diffView(h, p, expanded)
    case "command":
      return commandView(h, p)
    case "fetch":
      return fetchView(h, p)
    case "generic":
      return genericView(h, p)
  }
}
