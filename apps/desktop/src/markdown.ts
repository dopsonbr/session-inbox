/**
 * A deliberately small Markdown subset for what Claude says (C-023, U-033). Pure: text in,
 * a plain AST out; `view/markdown.ts` turns it into Foldkit elements. Nothing here ever
 * produces HTML strings, and raw HTML in the input is just text.
 *
 * Blocks: paragraphs (line breaks kept), `#` headings, bullet / numbered lists (nested by
 * indentation), fenced code (``` or ~~~; an unclosed fence runs to the end), `---` rules,
 * and `|` table lines kept as preformatted text. Inline: `code`, **bold**, *italic*,
 * [links](url), and bare http(s) URLs. Anything else is literal text.
 */

export type Inline =
  | Readonly<{ _tag: "text"; text: string }>
  | Readonly<{ _tag: "code"; text: string }>
  | Readonly<{ _tag: "strong"; children: ReadonlyArray<Inline> }>
  | Readonly<{ _tag: "em"; children: ReadonlyArray<Inline> }>
  /** `href` is set only for http(s)/mailto; otherwise the target is shown as a path. A bare
   *  URL is a link whose only child is its own text. */
  | Readonly<{
      _tag: "link"
      children: ReadonlyArray<Inline>
      target: string
      href: string | null
    }>

export type ListItem = Readonly<{ inlines: ReadonlyArray<Inline>; sublist: List | null }>
export type List = Readonly<{ ordered: boolean; start: number; items: ReadonlyArray<ListItem> }>

export type Block =
  | Readonly<{ _tag: "paragraph"; lines: ReadonlyArray<ReadonlyArray<Inline>> }>
  | Readonly<{ _tag: "heading"; level: number; inlines: ReadonlyArray<Inline> }>
  | Readonly<{ _tag: "list"; list: List }>
  | Readonly<{ _tag: "code"; lang: string; text: string }>
  | Readonly<{ _tag: "preformatted"; text: string }>
  | Readonly<{ _tag: "rule" }>

/** Nesting deeper than this renders as text (inline) or flattens (lists). */
const MAX_INLINE_DEPTH = 4
const MAX_LIST_DEPTH = 4
const MAX_CLOSER_ATTEMPTS = 32

// INLINE

const SAFE_HREF = /^(https?:\/\/|mailto:)/i

/** http(s) and mailto only; everything else (relative paths, javascript:, file:) isn't a link. */
export const safeHref = (url: string): string | null => (SAFE_HREF.test(url) ? url : null)

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch)
const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch)

const BARE_URL = /^https?:\/\/[^\s<>"'`]+/i
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/

type Scan = {
  readonly text: string
  /** Positions after which a delimiter is known not to occur again (keeps scanning linear). */
  readonly noneAfter: Map<string, number>
}

const findFrom = (scan: Scan, needle: string, from: number): number => {
  const known = scan.noneAfter.get(needle)
  if (known !== undefined && from >= known) {
    return -1
  }
  const at = scan.text.indexOf(needle, from)
  if (at === -1) {
    scan.noneAfter.set(needle, Math.min(from, known ?? from))
  }
  return at
}

const pushText = (out: Inline[], text: string) => {
  if (text === "") return
  const last = out[out.length - 1]
  if (last?._tag === "text") {
    out[out.length - 1] = { _tag: "text", text: last.text + text }
  } else {
    out.push({ _tag: "text", text })
  }
}

/** A closing `delim` after `from` whose content isn't empty or space-padded, or -1. */
const findClosing = (scan: Scan, delim: string, from: number, end: number): number => {
  const { text } = scan
  const isSingle = delim.length === 1
  // Bounded: a run of would-be closers (`*a *a *a …`) can't make this quadratic.
  let attempts = 0
  let at = findFrom(scan, delim, from)
  while (at !== -1 && at < end && attempts < MAX_CLOSER_ATTEMPTS) {
    attempts += 1
    const before = text[at - 1]
    const after = text[at + delim.length]
    const ok =
      at > from &&
      !isSpace(text[from]) &&
      !isSpace(before) &&
      // `*a**` shouldn't close a single `*` on either star of a double.
      !(isSingle && (after === delim || before === delim)) &&
      !(delim[0] === "_" && isWordChar(after))
    if (ok) return at
    at = findFrom(scan, delim, at + 1)
  }
  return -1
}

const parseRange = (
  scan: Scan,
  start: number,
  end: number,
  depth: number,
  inLabel: boolean,
): ReadonlyArray<Inline> => {
  const { text } = scan
  const out: Inline[] = []
  let i = start
  let plain = start
  const flush = (to: number) => {
    pushText(out, text.slice(plain, to))
  }
  while (i < end) {
    const ch = text[i] as string
    // Backslash escape of punctuation.
    if (ch === "\\" && i + 1 < end && /[!-/:-@[-`{-~]/.test(text[i + 1] as string)) {
      flush(i)
      pushText(out, text[i + 1] as string)
      i += 2
      plain = i
      continue
    }
    if (ch === "`") {
      let run = 1
      while (text[i + run] === "`") run++
      const fence = "`".repeat(run)
      let close = findFrom(scan, fence, i + run)
      // The closing run must be exactly as long.
      while (close !== -1 && close < end && text[close + run] === "`") {
        let skip = close
        while (text[skip] === "`") skip++
        close = findFrom(scan, fence, skip)
      }
      if (close !== -1 && close + run <= end) {
        flush(i)
        let body = text.slice(i + run, close).replace(/\n/g, " ")
        if (body.length > 2 && body.startsWith(" ") && body.endsWith(" ")) {
          body = body.slice(1, -1)
        }
        out.push({ _tag: "code", text: body })
        i = close + run
        plain = i
        continue
      }
      i += run
      continue
    }
    if (depth < MAX_INLINE_DEPTH && (ch === "*" || ch === "_")) {
      const isDouble = text[i + 1] === ch
      const delim = isDouble ? ch + ch : ch
      const opensWord = ch === "_" ? !isWordChar(text[i - 1]) : true
      if (opensWord && !isSpace(text[i + delim.length])) {
        const close = findClosing(scan, delim, i + delim.length, end)
        if (close !== -1) {
          flush(i)
          const children = parseRange(scan, i + delim.length, close, depth + 1, inLabel)
          out.push(isDouble ? { _tag: "strong", children } : { _tag: "em", children })
          i = close + delim.length
          plain = i
          continue
        }
      }
      i += delim.length
      continue
    }
    if (ch === "[" && !inLabel && depth < MAX_INLINE_DEPTH) {
      const closeLabel = findFrom(scan, "]", i + 1)
      if (closeLabel !== -1 && closeLabel < end && text[closeLabel + 1] === "(") {
        const closeUrl = findFrom(scan, ")", closeLabel + 2)
        const rawTarget = closeUrl === -1 ? "" : text.slice(closeLabel + 2, closeUrl).trim()
        const target = rawTarget.replace(/^<(.*)>$/, "$1")
        if (
          closeUrl !== -1 &&
          closeUrl < end &&
          target !== "" &&
          !/\s/.test(target) &&
          closeLabel > i + 1
        ) {
          flush(i)
          // Links inside a link label are text.
          const children = parseRange(scan, i + 1, closeLabel, depth + 1, true)
          out.push({ _tag: "link", children, target, href: safeHref(target) })
          i = closeUrl + 1
          plain = i
          continue
        }
      }
      i += 1
      continue
    }
    if (!inLabel && (ch === "h" || ch === "H") && !isWordChar(text[i - 1])) {
      const match = BARE_URL.exec(text.slice(i, Math.min(end, i + 2048)))
      if (match !== null) {
        const url = match[0].replace(TRAILING_PUNCT, "")
        if (url.length > "https://".length) {
          flush(i)
          out.push({
            _tag: "link",
            children: [{ _tag: "text", text: url }],
            target: url,
            href: url,
          })
          i += url.length
          plain = i
          continue
        }
      }
    }
    i += 1
  }
  flush(end)
  return out
}

/** Inline Markdown in one line or paragraph. */
export const parseInline = (text: string): ReadonlyArray<Inline> =>
  parseRange({ text, noneAfter: new Map() }, 0, text.length, 0, false)

/** Card summaries and one-line contexts: newlines become spaces. */
export const parseInlineLine = (text: string): ReadonlyArray<Inline> =>
  parseInline(text.replace(/\s*\n\s*/g, " "))

/** The text an inline tree reads as (tests, titles). */
export const inlineText = (inlines: ReadonlyArray<Inline>): string =>
  inlines
    .map((node) =>
      node._tag === "text" || node._tag === "code" ? node.text : inlineText(node.children),
    )
    .join("")

// BLOCKS

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/
const BULLET = /^(\s*)([-*+])\s+(.*)$/
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const TABLE = /^\s*\|/

const indentOf = (raw: string): number => raw.replace(/\t/g, "    ").length

type RawItem = { indent: number; ordered: boolean; number: number; text: string }

const listItemOf = (line: string): RawItem | null => {
  const bullet = BULLET.exec(line)
  if (bullet !== null) {
    return {
      indent: indentOf(bullet[1] ?? ""),
      ordered: false,
      number: 1,
      text: bullet[3] ?? "",
    }
  }
  const ordered = ORDERED.exec(line)
  if (ordered !== null) {
    return {
      indent: indentOf(ordered[1] ?? ""),
      ordered: true,
      number: Number(ordered[2]),
      text: ordered[3] ?? "",
    }
  }
  return null
}

type MutableList = { ordered: boolean; start: number; items: MutableItem[] }
type MutableItem = { text: string; sublist: MutableList | null }

/** Nest items by indentation: deeper than the current level starts a sublist of the last item. */
const buildList = (raw: ReadonlyArray<RawItem>): List => {
  const first = raw[0] as RawItem
  const root: MutableList = { ordered: first.ordered, start: first.number, items: [] }
  const stack: Array<{ indent: number; list: MutableList }> = [{ indent: first.indent, list: root }]
  for (const item of raw) {
    while (
      stack.length > 1 &&
      item.indent < (stack[stack.length - 1] as { indent: number }).indent
    ) {
      stack.pop()
    }
    const top = stack[stack.length - 1] as { indent: number; list: MutableList }
    const parent = top.list.items[top.list.items.length - 1]
    if (item.indent >= top.indent + 2 && parent !== undefined && stack.length < MAX_LIST_DEPTH) {
      const sub: MutableList = { ordered: item.ordered, start: item.number, items: [] }
      parent.sublist = sub
      sub.items.push({ text: item.text, sublist: null })
      stack.push({ indent: item.indent, list: sub })
    } else {
      top.list.items.push({ text: item.text, sublist: null })
    }
  }
  const freeze = (list: MutableList): List => ({
    ordered: list.ordered,
    start: list.start,
    items: list.items.map((it) => ({
      inlines: parseInline(it.text),
      sublist: it.sublist === null ? null : freeze(it.sublist),
    })),
  })
  return freeze(root)
}

const isBlockStart = (line: string): boolean =>
  FENCE.test(line) ||
  HEADING.test(line) ||
  RULE.test(line) ||
  listItemOf(line) !== null ||
  TABLE.test(line)

export const parseMarkdown = (source: string): ReadonlyArray<Block> => {
  const lines = source.replace(/\r\n?/g, "\n").split("\n")
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    if (line.trim() === "") {
      i += 1
      continue
    }
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const marker = (fence[1] as string)[0] as string
      const length = (fence[1] as string).length
      const body: string[] = []
      i += 1
      while (i < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i] as string)
        if (
          close !== null &&
          (close[1] as string)[0] === marker &&
          (close[1] as string).length >= length
        ) {
          i += 1
          break
        }
        body.push(lines[i] as string)
        i += 1
      }
      blocks.push({ _tag: "code", lang: fence[2] ?? "", text: body.join("\n") })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      blocks.push({
        _tag: "heading",
        level: (heading[1] as string).length,
        inlines: parseInline(heading[2] ?? ""),
      })
      i += 1
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ _tag: "rule" })
      i += 1
      continue
    }
    if (TABLE.test(line)) {
      const rows: string[] = []
      while (i < lines.length && TABLE.test(lines[i] as string)) {
        rows.push((lines[i] as string).trim())
        i += 1
      }
      blocks.push({ _tag: "preformatted", text: rows.join("\n") })
      continue
    }
    if (listItemOf(line) !== null) {
      const raw: RawItem[] = []
      while (i < lines.length) {
        const current = lines[i] as string
        const item = listItemOf(current)
        const first = raw[0]
        // A top-level switch between bullets and numbers starts a new list.
        if (
          item !== null &&
          first !== undefined &&
          item.indent <= first.indent &&
          item.ordered !== first.ordered
        ) {
          break
        }
        if (item !== null) {
          raw.push(item)
          i += 1
          continue
        }
        if (current.trim() === "") {
          // A blank line between items keeps the list going.
          const next = lines[i + 1]
          if (next !== undefined && listItemOf(next) !== null) {
            i += 1
            continue
          }
          break
        }
        // An indented line continues the previous item.
        const last = raw[raw.length - 1]
        if (last !== undefined && /^\s+\S/.test(current) && !isBlockStart(current)) {
          last.text = `${last.text} ${current.trim()}`
          i += 1
          continue
        }
        break
      }
      blocks.push({ _tag: "list", list: buildList(raw) })
      continue
    }
    const paragraph: string[] = []
    while (i < lines.length) {
      const current = lines[i] as string
      if (current.trim() === "" || (paragraph.length > 0 && isBlockStart(current))) {
        break
      }
      paragraph.push(current.trim())
      i += 1
    }
    blocks.push({ _tag: "paragraph", lines: paragraph.map((l) => parseInline(l)) })
  }
  return blocks
}

// COLLAPSE

export const COLLAPSED_LINES = 24
export const COLLAPSED_CHARS = 2400

/**
 * The part of a long message shown before "Show all": the first COLLAPSED_LINES lines,
 * also cut at COLLAPSED_CHARS (on a space when there is one). `null` when nothing is cut.
 */
export const collapsedSource = (source: string): string | null => {
  const lines = source.replace(/\r\n?/g, "\n").split("\n")
  let cut = lines.length > COLLAPSED_LINES ? lines.slice(0, COLLAPSED_LINES).join("\n") : source
  if (cut.length > COLLAPSED_CHARS) {
    const space = cut.lastIndexOf(" ", COLLAPSED_CHARS)
    cut = cut.slice(0, space > COLLAPSED_CHARS / 2 ? space : COLLAPSED_CHARS)
  }
  return cut === source ? null : cut.trimEnd()
}

export const lineCount = (source: string): number => source.split(/\r\n?|\n/).length
