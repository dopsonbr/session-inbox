/**
 * Renders the Markdown AST from `markdown.ts` as Foldkit elements (U-033). Text always goes
 * in as text nodes; there is no innerHTML anywhere. Links open in a new tab only for
 * http(s)/mailto, and the target stays visible next to the label.
 */
import type { Html, HtmlBuilder } from "foldkit/html"
import {
  type Block,
  type Inline,
  inlineText,
  type List,
  parseInlineLine,
  parseMarkdown,
} from "../markdown.ts"
import type { Message } from "../message.ts"

type H = HtmlBuilder<Message>

/** `full`: clickable links. `plain`: no interactive elements (inside cards and links). */
export type InlineMode = "full" | "plain"

const codeSpan = (h: H, text: string): Html => h.code([h.Class("md-code")], [text])

const linkView = (
  h: H,
  node: Extract<Inline, { _tag: "link" }>,
  mode: InlineMode,
): ReadonlyArray<Html | string> => {
  const label = inlineText(node.children)
  const isBare = label === node.target
  if (node.href === null) {
    // Relative paths, file:, javascript: …: never a link; show the target as a path.
    return isBare
      ? [codeSpan(h, node.target)]
      : [...inlinesView(h, node.children, "plain"), " ", codeSpan(h, node.target)]
  }
  if (mode === "plain") {
    return isBare ? [node.target] : inlinesView(h, node.children, "plain")
  }
  return [
    h.a(
      [h.Href(node.href), h.Target("_blank"), h.Rel("noopener noreferrer"), h.Class("md-link")],
      isBare ? [node.target] : inlinesView(h, node.children, "plain"),
    ),
    ...(isBare ? [] : [h.span([h.Class("md-url")], [` (${node.target})`])]),
  ]
}

export const inlinesView = (
  h: H,
  inlines: ReadonlyArray<Inline>,
  mode: InlineMode = "full",
): ReadonlyArray<Html | string> => inlines.flatMap((node) => inlineView(h, node, mode))

const inlineView = (h: H, node: Inline, mode: InlineMode): ReadonlyArray<Html | string> => {
  switch (node._tag) {
    case "text":
      return [node.text]
    case "code":
      return [codeSpan(h, node.text)]
    case "strong":
      return [h.strong([h.Class("font-semibold")], inlinesView(h, node.children, mode))]
    case "em":
      return [h.em([], inlinesView(h, node.children, mode))]
    case "link":
      return linkView(h, node, mode)
  }
}

/** One-line summary (queue cards, popover rows): inline subset, never interactive. */
export const inlineLineView = (h: H, text: string): ReadonlyArray<Html | string> =>
  inlinesView(h, parseInlineLine(text), "plain")

const listView = (h: H, list: List): Html => {
  const items = list.items.map((item) =>
    h.li(
      [],
      [
        ...inlinesView(h, item.inlines),
        item.sublist === null ? h.empty : listView(h, item.sublist),
      ],
    ),
  )
  return list.ordered
    ? h.ol([h.Class("md-list md-ol"), ...(list.start === 1 ? [] : [h.Start(list.start)])], items)
    : h.ul([h.Class("md-list md-ul")], items)
}

const blockView = (h: H, block: Block): Html => {
  switch (block._tag) {
    case "paragraph":
      return h.p(
        [h.Class("md-p")],
        block.lines.flatMap((line, i) => [...(i === 0 ? [] : [h.br([])]), ...inlinesView(h, line)]),
      )
    case "heading":
      // Bold lines, not document headings: the pane already has its own h1/h2.
      return h.p([h.Class("md-heading")], inlinesView(h, block.inlines))
    case "list":
      return listView(h, block.list)
    case "code":
      return h.pre(
        [h.Class("md-pre"), ...(block.lang === "" ? [] : [h.DataAttribute("lang", block.lang)])],
        [h.code([], [block.text])],
      )
    case "preformatted":
      return h.pre([h.Class("md-pre")], [block.text])
    case "rule":
      return h.hr([h.Class("md-rule")])
  }
}

export const markdownBlocksView = (h: H, blocks: ReadonlyArray<Block>): ReadonlyArray<Html> =>
  blocks.map((block) => blockView(h, block))

export const markdownView = (h: H, source: string): ReadonlyArray<Html> =>
  markdownBlocksView(h, parseMarkdown(source))
