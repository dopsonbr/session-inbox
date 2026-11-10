import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildSite,
  checkOutput,
  parseDecisions,
  parseFrontMatter,
  renderDecisions,
  toMeta,
} from "../../scripts/build-site.ts"

const TEMPLATE = join(import.meta.dir, "..", "template.html")
const FRONT = (order: number, title = "T") =>
  `---\ntitle: ${title}\ndescription: A page.\norder: ${order}\nsection: Guides\n---\n`

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "si-site-"))
  mkdirSync(join(dir, "content"), { recursive: true })
  // The template links these three; stubs keep the link check honest.
  mkdirSync(join(dir, "assets"), { recursive: true })
  for (const f of ["site.css", "site.js", "favicon.svg"]) writeFileSync(join(dir, "assets", f), "")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const page = (name: string, body: string) => writeFileSync(join(dir, "content", name), body)
const build = (extra: Partial<Parameters<typeof buildSite>[0]> = {}) =>
  buildSite({
    siteDir: dir,
    outDir: join(dir, "dist"),
    templatePath: TEMPLATE,
    date: new Date("2026-01-02T03:04:05Z"),
    ...extra,
  })
const read = (file: string) => readFileSync(join(dir, "dist", file), "utf8")

describe("front-matter", () => {
  test("parses keys, strips quotes and returns the body", () => {
    const p = parseFrontMatter('---\ntitle: "Quoted: title"\norder: 3\n---\n# Hi\n')
    expect(p.hasFrontMatter).toBe(true)
    expect(p.data).toEqual({ title: "Quoted: title", order: "3" })
    expect(p.body).toBe("# Hi\n")
  })

  test("a file without front-matter is reported", () => {
    const parsed = parseFrontMatter("# Just a heading\n")
    const checked = toMeta(parsed, "x.md")
    expect(checked.meta).toBeNull()
    expect(checked.errors[0]).toContain("missing front-matter")
  })

  test("each required key is reported, and order must be a number", () => {
    const missing = toMeta(parseFrontMatter("---\ntitle: T\n---\n"), "x.md")
    expect(missing.errors.join("\n")).toContain('missing "description"')
    expect(missing.errors.join("\n")).toContain('missing "order"')
    expect(missing.errors.join("\n")).toContain('missing "section"')
    const bad = toMeta(
      parseFrontMatter("---\ntitle: T\ndescription: D\norder: first\nsection: S\n---\n"),
      "x.md",
    )
    expect(bad.errors.join("\n")).toContain("must be a number")
  })

  test("a page with no front-matter fails the build with a problem and is not published", () => {
    page("index.md", `${FRONT(0)}# Home\n`)
    page("broken.md", "# No front-matter\n")
    const r = build()
    expect(r.problems.some((p) => p.includes("broken.md") && p.includes("front-matter"))).toBe(true)
    expect(existsSync(join(dir, "dist", "broken.html"))).toBe(false)
  })
})

describe("links", () => {
  test("Markdown links are rewritten to relative .html links", () => {
    page("index.md", `${FRONT(0)}# Home\n\nSee [two](two.md) and [a section](two.md#part).\n`)
    page("two.md", `${FRONT(1)}# Two\n\n## Part\n\nText.\n`)
    const r = build()
    expect(r.problems).toEqual([])
    const html = read("index.html")
    expect(html).toContain('href="two.html"')
    expect(html).toContain('href="two.html#part"')
    expect(html).not.toMatch(/href="\//)
  })

  test("external links keep their address and get rel=noopener", () => {
    page("index.md", `${FRONT(0)}# Home\n\n[GitHub](https://github.com/dopsonbr/session-inbox)\n`)
    const r = build()
    expect(r.problems).toEqual([])
    expect(read("index.html")).toContain(
      'href="https://github.com/dopsonbr/session-inbox" rel="noopener noreferrer"',
    )
  })

  test("a broken page link and a broken anchor are caught", () => {
    page("index.md", `${FRONT(0)}# Home\n\n[gone](missing.md) and [nowhere](two.md#nope)\n`)
    page("two.md", `${FRONT(1)}# Two\n\n## Real\n\nText.\n`)
    const r = build()
    expect(r.problems.some((p) => p.includes("broken link") && p.includes("missing.html"))).toBe(
      true,
    )
    expect(r.problems.some((p) => p.includes("broken anchor") && p.includes("#nope"))).toBe(true)
  })

  test("absolute links and external resources are caught", () => {
    page(
      "index.md",
      `${FRONT(0)}# Home\n\n[abs](/install.html)\n\n![x](https://example.com/a.png)\n`,
    )
    const r = build()
    expect(r.problems.some((p) => p.includes("absolute link"))).toBe(true)
    expect(r.problems.some((p) => p.includes("external resource"))).toBe(true)
  })

  test("checkOutput works on any built folder", () => {
    page("index.md", `${FRONT(0)}# Home\n`)
    build()
    expect(checkOutput(join(dir, "dist"))).toEqual([])
    writeFileSync(
      join(dir, "dist", "extra.html"),
      '<title>x</title><meta name="description" content="x"><h1>x</h1><a href="nope.html">n</a>',
    )
    expect(checkOutput(join(dir, "dist")).join("\n")).toContain('broken link "nope.html"')
  })
})

describe("page chrome", () => {
  test("headings get anchors, a page list, and code blocks get a copy button", () => {
    page(
      "index.md",
      `${FRONT(0)}# Home\n\n## First part\n\ntext\n\n### Sub part\n\n\`\`\`bash\necho hi\n\`\`\`\n`,
    )
    build()
    const html = read("index.html")
    expect(html).toContain('<h2 id="first-part">First part<a class="anchor" href="#first-part"')
    expect(html).toContain('<nav class="toc" aria-label="On this page">')
    expect(html).toContain('<button class="copy"')
    expect(html).toContain('<code data-lang="bash">echo hi\n</code>')
  })

  test("the nav marks the current page and pages link to previous and next", () => {
    page("index.md", `${FRONT(0, "Home")}# Home\n`)
    page("a.md", `${FRONT(1, "Alpha")}# Alpha\n`)
    page("b.md", `${FRONT(2, "Beta")}# Beta\n`)
    build()
    const a = read("a.html")
    expect(a).toContain('<a href="a.html" aria-current="page">Alpha</a>')
    expect(a).toContain('rel="prev" href="index.html"')
    expect(a).toContain('rel="next" href="b.html"')
    expect(read("index.html")).not.toContain('rel="prev"')
  })

  test("the footer shows the version and build date, or no version when there is none", () => {
    page("index.md", `${FRONT(0)}# Home\n`)
    build({ version: "0.2.0" })
    expect(read("index.html")).toContain("Session Inbox v0.2.0")
    expect(read("index.html")).toContain("Docs built 2026-01-02")
    build({ version: null })
    expect(read("index.html")).not.toContain("Session Inbox v")
    expect(read("index.html")).toContain("Docs built 2026-01-02")
  })

  test("tables are wrapped so they scroll inside themselves", () => {
    page("index.md", `${FRONT(0)}# Home\n\n| a | b |\n| - | - |\n| 1 | 2 |\n`)
    build()
    expect(read("index.html")).toContain('<div class="table-wrap"><table>')
  })
})

describe("screenshots", () => {
  test("a missing screenshot renders a placeholder and is listed, without failing the build", () => {
    page("index.md", `${FRONT(0)}# Home\n\n[[screenshot popover.png 420x560 The popover.]]\n`)
    const r = build()
    expect(r.problems).toEqual([])
    expect(r.missingScreenshots).toEqual(["assets/screenshots/popover.png"])
    const html = read("index.html")
    expect(html).toContain("shot-missing")
    expect(html).toContain("aspect-ratio:420/560")
    expect(html).not.toContain("<img")
  })

  test("a present screenshot renders an image with dimensions and alt text", () => {
    mkdirSync(join(dir, "assets", "screenshots"), { recursive: true })
    writeFileSync(join(dir, "assets", "screenshots", "popover.png"), "png")
    page("index.md", `${FRONT(0)}# Home\n\n[[screenshot popover.png 420x560 The popover.]]\n`)
    const r = build()
    expect(r.problems).toEqual([])
    expect(r.missingScreenshots).toEqual([])
    expect(read("index.html")).toContain(
      '<img src="assets/screenshots/popover.png" alt="The popover." width="420" height="560"',
    )
  })

  test("a light and dark pair uses a picture element when both exist", () => {
    mkdirSync(join(dir, "assets", "screenshots"), { recursive: true })
    writeFileSync(join(dir, "assets", "screenshots", "a-light.png"), "png")
    writeFileSync(join(dir, "assets", "screenshots", "a-dark.png"), "png")
    page("index.md", `${FRONT(0)}# Home\n\n[[screenshot a-light.png,a-dark.png 100x50 Alt.]]\n`)
    build()
    const html = read("index.html")
    expect(html).toContain('<source srcset="assets/screenshots/a-dark.png"')
    expect(html).toContain("prefers-color-scheme: dark")
  })
})

describe("decisions", () => {
  const SRC = [
    "# Decisions",
    "",
    "## General",
    "",
    "- G-001 — Scope is local. Why.",
    "- G-002 — The daemon decides, see G-001 and `G-001`. Why.",
    "",
    "## Hook & Ops",
    "",
    "- H-001 — Fail open.",
    "",
  ].join("\n")

  test("sections and entries are parsed", () => {
    const s = parseDecisions(SRC)
    expect(s.map((x) => x.name)).toEqual(["General", "Hook & Ops"])
    expect(s[0]?.entries.map((e) => e.id)).toEqual(["G-001", "G-002"])
  })

  test("each decision gets an anchor and ids in the text become links", () => {
    const html = renderDecisions(SRC)
    expect(html).toContain('id="G-002"')
    expect(html).toContain('<a href="#G-001">G-001</a>')
    expect(html).toContain("<code>G-001</code>")
    expect(html).toContain('<h2 id="hook-ops">Hook &amp; Ops</h2>')
  })

  test("a page can deep-link to a decision and the build checks it", () => {
    writeFileSync(join(dir, "DECISIONS.md"), SRC)
    page("index.md", `${FRONT(0)}# Home\n\n[one](decisions.md#G-001) [two](decisions.md#Z-999)\n`)
    page("decisions.md", `${FRONT(1)}# Decisions\n\n[[decisions]]\n`)
    const r = build({ decisionsPath: join(dir, "DECISIONS.md") })
    expect(read("decisions.html")).toContain('<div class="decision" id="G-001">')
    expect(r.problems.some((p) => p.includes("#Z-999"))).toBe(true)
    expect(r.problems.some((p) => p.includes("#G-001"))).toBe(false)
  })
})

describe("the real site", () => {
  test("builds cleanly from the repository sources", () => {
    const repo = join(import.meta.dir, "..", "..")
    const out = mkdtempSync(join(tmpdir(), "si-site-real-"))
    try {
      const r = buildSite({
        siteDir: join(repo, "site"),
        outDir: out,
        decisionsPath: join(repo, "DECISIONS.md"),
      })
      expect(r.problems).toEqual([])
      expect(r.pages.length).toBeGreaterThan(8)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})
