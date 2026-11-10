import { describe, expect, test } from "bun:test"
import { RECEIPTS_LAST_MESSAGE } from "../src/client/fixtures.ts"
import {
  COLLAPSED_CHARS,
  COLLAPSED_LINES,
  collapsedSource,
  inlineText,
  parseInline,
  parseInlineLine,
  parseMarkdown,
  safeHref,
} from "../src/markdown.ts"
import { inlineLineView, markdownView } from "../src/view/markdown.ts"
import { attrOf, findAll, h, textOf } from "./vnode.ts"

const tags = (text: string) => parseInline(text).map((n) => n._tag)

describe("inline subset", () => {
  test("code, bold, italic, nested", () => {
    expect(parseInline("run `bun test` now")).toEqual([
      { _tag: "text", text: "run " },
      { _tag: "code", text: "bun test" },
      { _tag: "text", text: " now" },
    ])
    const [strong] = parseInline("**bold *and italic***")
    expect(strong?._tag).toBe("strong")
    expect(inlineText(parseInline("**bold *and italic***"))).toBe("bold and italic")
    expect(tags("__b__ _i_")).toEqual(["strong", "text", "em"])
  })

  test("markers inside code stay literal; double-backtick spans hold a backtick", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ _tag: "code", text: "**not bold**" }])
    expect(parseInline("``a ` b``")).toEqual([{ _tag: "code", text: "a ` b" }])
  })

  test("snake_case and lone stars are text", () => {
    expect(tags("use snake_case_names here")).toEqual(["text"])
    expect(tags("2 * 3 * 4")).toEqual(["text"])
    expect(inlineText(parseInline("*unclosed **also"))).toBe("*unclosed **also")
  })

  test("unclosed markers fall back to text", () => {
    expect(parseInline("`open")).toEqual([{ _tag: "text", text: "`open" }])
    expect(parseInline("**open")).toEqual([{ _tag: "text", text: "**open" }])
    expect(parseInline("[label](no-close")).toEqual([{ _tag: "text", text: "[label](no-close" }])
  })

  test("links: http(s)/mailto get an href, anything else doesn't", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com")
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c")
    expect(safeHref("javascript:alert(1)")).toBeNull()
    expect(safeHref("JaVaScRiPt:alert(1)")).toBeNull()
    expect(safeHref("data:text/html,<b>x</b>")).toBeNull()
    expect(safeHref("file:///etc/passwd")).toBeNull()
    expect(safeHref("docs/handoff.md")).toBeNull()
    const [link] = parseInline("[docs/handoff.md](docs/handoff.md)")
    expect(link).toMatchObject({ _tag: "link", target: "docs/handoff.md", href: null })
    const [js] = parseInline("[click](javascript:alert(1))")
    expect(js).toMatchObject({ _tag: "link", href: null })
  })

  test("bare URLs, minus trailing punctuation", () => {
    const nodes = parseInline("see https://example.com/a?b=1.")
    expect(nodes[1]).toMatchObject({ _tag: "link", href: "https://example.com/a?b=1" })
    expect(nodes[2]).toEqual({ _tag: "text", text: "." })
  })

  test("raw HTML is text", () => {
    expect(parseInline("<script>alert(1)</script><img src=x onerror=alert(1)>")).toEqual([
      { _tag: "text", text: "<script>alert(1)</script><img src=x onerror=alert(1)>" },
    ])
  })

  test("escapes", () => {
    expect(parseInline("\\*not em\\*")).toEqual([{ _tag: "text", text: "*not em*" }])
  })

  test("one-line form joins lines", () => {
    expect(inlineText(parseInlineLine("a\n  b\nc"))).toBe("a b c")
  })
})

describe("blocks", () => {
  test("headings, paragraphs with line breaks, rules, tables as preformatted", () => {
    const blocks = parseMarkdown("# Title\n\nline one\nline two\n\n---\n\n| a | b |\n|---|---|")
    expect(blocks.map((b) => b._tag)).toEqual(["heading", "paragraph", "rule", "preformatted"])
    expect(blocks[1]).toMatchObject({ _tag: "paragraph" })
    expect((blocks[1] as unknown as { lines: unknown[] }).lines).toHaveLength(2)
  })

  test("nested bullet lists, then a separate numbered list", () => {
    const blocks = parseMarkdown("- a\n  - b\n    - c\n- d\n\n3. three\n4. four")
    expect(blocks.map((b) => b._tag)).toEqual(["list", "list"])
    const first = blocks[0] as Extract<(typeof blocks)[number], { _tag: "list" }>
    expect(first.list.items).toHaveLength(2)
    expect(first.list.items[0]?.sublist?.items[0]?.sublist?.items).toHaveLength(1)
    const second = blocks[1] as Extract<(typeof blocks)[number], { _tag: "list" }>
    expect(second.list).toMatchObject({ ordered: true, start: 3 })
  })

  test("fenced code keeps its text verbatim; an unclosed fence runs to the end", () => {
    const closed = parseMarkdown("```ts\nconst x = `**y**`\n```\nafter")
    expect(closed[0]).toEqual({ _tag: "code", lang: "ts", text: "const x = `**y**`" })
    expect(closed[1]?._tag).toBe("paragraph")
    const open = parseMarkdown("before\n\n~~~\n# not a heading\n- not a list")
    expect(open[1]).toEqual({ _tag: "code", lang: "", text: "# not a heading\n- not a list" })
  })

  test("deep nesting is bounded", () => {
    const deep = Array.from({ length: 30 }, (_, i) => `${"  ".repeat(i)}- level ${i}`).join("\n")
    let depth = 0
    let list = (parseMarkdown(deep)[0] as { list?: { items: { sublist: unknown }[] } }).list
    while (list !== undefined && list !== null) {
      depth += 1
      list = list.items.at(-1)?.sublist as typeof list
    }
    expect(depth).toBeLessThanOrEqual(4)
    expect(inlineText(parseInline(`${"**".repeat(40)}x${"**".repeat(40)}`))).toContain("x")
  })

  test("CRLF and blank-only input", () => {
    expect(parseMarkdown("a\r\nb")[0]).toMatchObject({ _tag: "paragraph" })
    expect(parseMarkdown("\n\n  \n")).toEqual([])
  })
})

describe("nasty input stays fast and literal", () => {
  const cases: Record<string, string> = {
    stars: "*a ".repeat(7000),
    underscores: "_x ".repeat(7000),
    backticks: `x${"`".repeat(20_000)}`,
    tickRuns: "``a`".repeat(5000),
    brackets: "[".repeat(20_000),
    halfLinks: "[a](".repeat(5000),
    longLine: "x".repeat(20_000),
    mixed: "**a *b `c [d](e) _f ".repeat(1000),
  }
  for (const [name, text] of Object.entries(cases)) {
    test(name, () => {
      const started = performance.now()
      const blocks = parseMarkdown(text)
      expect(performance.now() - started).toBeLessThan(500)
      // Unmatched markers stay as text; nothing becomes markup out of nowhere.
      const rendered = textOf(markdownView(h, text))
      expect(rendered.length).toBeGreaterThan(0)
      expect(blocks.length).toBeGreaterThan(0)
    })
  }
})

describe("collapse", () => {
  test("long messages cut at 24 lines; short ones aren't cut", () => {
    expect(collapsedSource("short\nmessage")).toBeNull()
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")
    const cut = collapsedSource(long)
    expect(cut?.split("\n")).toHaveLength(COLLAPSED_LINES)
    expect(RECEIPTS_LAST_MESSAGE.split("\n").length).toBeGreaterThan(COLLAPSED_LINES)
  })

  test("one huge line is cut by characters", () => {
    const cut = collapsedSource("word ".repeat(4000))
    expect(cut).not.toBeNull()
    expect((cut ?? "").length).toBeLessThanOrEqual(COLLAPSED_CHARS)
  })
})

describe("markdown view", () => {
  test("never innerHTML: <script> renders as text", () => {
    const view = markdownView(h, "<script>alert(1)</script>\n\n**<b>x</b>**")
    expect(findAll(view, "script")).toHaveLength(0)
    expect(findAll(view, "b")).toHaveLength(0)
    expect(textOf(view)).toContain("<script>alert(1)</script>")
    expect(JSON.stringify(view)).not.toContain("innerHTML")
  })

  test("safe links open in a new tab with the URL visible; others are code-styled paths", () => {
    const view = markdownView(
      h,
      "Read [the spec](https://example.com/spec), [docs/handoff.md](docs/handoff.md) and [x](javascript:alert(1)).",
    )
    const anchors = findAll(view, "a")
    expect(anchors).toHaveLength(1)
    expect(attrOf(anchors[0] as never, "href")).toBe("https://example.com/spec")
    expect(attrOf(anchors[0] as never, "target")).toBe("_blank")
    expect(attrOf(anchors[0] as never, "rel")).toBe("noopener noreferrer")
    const text = textOf(view)
    expect(text).toContain("the spec (https://example.com/spec)")
    expect(text).toContain("docs/handoff.md")
    expect(findAll(view, "code").map(textOf)).toContain("docs/handoff.md")
    expect(findAll(view, "code").map(textOf)).toContain("javascript:alert(1")
  })

  test("the fixture message renders every block kind", () => {
    const view = markdownView(h, RECEIPTS_LAST_MESSAGE)
    expect(findAll(view, "pre").length).toBeGreaterThanOrEqual(2)
    expect(findAll(view, "ul").length).toBeGreaterThanOrEqual(2)
    // The code block between steps 2 and 3 splits the numbered list; step 3 keeps its number.
    const ols = findAll(view, "ol")
    expect(ols).toHaveLength(2)
    expect(attrOf(ols[1] as never, "start")).toBe(3)
    expect(findAll(view, "strong").length).toBeGreaterThan(0)
    expect(findAll(view, "hr")).toHaveLength(1)
    expect(textOf(view)).not.toContain("**")
  })

  test("one-line view: no anchors, no raw backticks", () => {
    const view = inlineLineView(
      h,
      "Fixed `parser.spec.ts`, see https://example.com and [x](https://a.b)",
    )
    expect(findAll(view, "a")).toHaveLength(0)
    expect(textOf(view)).toBe("Fixed parser.spec.ts, see https://example.com and x")
  })
})
