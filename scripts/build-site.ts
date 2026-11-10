/**
 * Build the documentation site: Markdown in site/content/*.md → static HTML in site/dist/.
 *
 *   bun scripts/build-site.ts            build site/dist
 *   bun scripts/build-site.ts --check    build, then fail on broken internal links/anchors,
 *                                        missing front-matter, absolute links, external resources
 *   bun scripts/build-site.ts --serve    build, then serve site/dist on a random localhost port
 *
 * Bun only: Markdown goes through Bun.markdown, everything else is plain string work. Every
 * link in the output is relative, so the site works under /session-inbox/ and from file://.
 * See site/README.md for how to add a page.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, extname, join, normalize, posix, relative } from "node:path"
import { parseArgs } from "node:util"

const REPO_URL = "https://github.com/dopsonbr/session-inbox"
const SCREENSHOT_DIR = "assets/screenshots"

export interface Meta {
  title: string
  description: string
  order: number
  section: string
  /** Sidebar label when it differs from the title. */
  nav?: string
  /** Repo path the page is generated from or edited at, for the "Edit this page" link. */
  source?: string
  /** `toc: false` hides the "On this page" list. */
  toc?: boolean
}

export interface Heading {
  level: number
  id: string
  text: string
}

export interface Page {
  /** Output file name, e.g. `install.html`. */
  file: string
  /** Content file name, e.g. `install.md`. */
  src: string
  meta: Meta
  /** Rendered article HTML. */
  html: string
  headings: Heading[]
}

export interface BuildOptions {
  /** Directory holding content/, assets/, partials/ and template.html. */
  siteDir: string
  outDir?: string
  templatePath?: string
  /** DECISIONS.md, rendered where a page says `[[decisions]]`. */
  decisionsPath?: string | null
  /** Shown in the footer when set. */
  version?: string | null
  date?: Date
  log?: (line: string) => void
}

export interface BuildResult {
  pages: Page[]
  problems: string[]
  missingScreenshots: string[]
  outDir: string
}

// ---------------------------------------------------------------------------------------------
// Small helpers

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, "")

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

/** A URL that points at another site or protocol (http:, https:, mailto:, ...) */
const isExternal = (url: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")

// ---------------------------------------------------------------------------------------------
// Front-matter

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export interface ParsedSource {
  data: Record<string, string>
  body: string
  hasFrontMatter: boolean
}

/** Tiny front-matter: `key: value` lines between two `---` lines. No nesting, no lists. */
export const parseFrontMatter = (src: string): ParsedSource => {
  const m = FRONT_MATTER.exec(src)
  if (!m) return { data: {}, body: src, hasFrontMatter: false }
  const data: Record<string, string> = {}
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue
    const i = line.indexOf(":")
    if (i < 1) continue
    const key = line.slice(0, i).trim()
    let value = line.slice(i + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    data[key] = value
  }
  return { data, body: src.slice(m[0].length), hasFrontMatter: true }
}

/** Validate parsed front-matter. Returns the Meta or a list of problems. */
export const toMeta = (
  parsed: ParsedSource,
  name: string,
): { meta: Meta; errors: [] } | { meta: null; errors: string[] } => {
  const errors: string[] = []
  if (!parsed.hasFrontMatter) {
    return {
      meta: null,
      errors: [`${name}: missing front-matter (--- title, description, order, section ---)`],
    }
  }
  for (const key of ["title", "description", "order", "section"]) {
    if (!parsed.data[key]) errors.push(`${name}: front-matter is missing "${key}"`)
  }
  const order = Number(parsed.data.order)
  if (parsed.data.order && !Number.isFinite(order)) {
    errors.push(`${name}: front-matter "order" must be a number, got "${parsed.data.order}"`)
  }
  if (errors.length > 0) return { meta: null, errors }
  const meta: Meta = {
    title: parsed.data.title as string,
    description: parsed.data.description as string,
    order,
    section: parsed.data.section as string,
  }
  if (parsed.data.nav) meta.nav = parsed.data.nav
  if (parsed.data.source) meta.source = parsed.data.source
  if (parsed.data.toc === "false") meta.toc = false
  return { meta, errors: [] }
}

// ---------------------------------------------------------------------------------------------
// Markdown → HTML

interface RenderContext {
  siteDir: string
  /** Does a file exist in the published assets (path relative to the site root)? */
  hasAsset: (path: string) => boolean
  missingScreenshots: Set<string>
  problems: string[]
  pageName: string
  decisionsHtml: string | null
}

/** Run `fn` on every line that is outside a fenced code block. */
const mapOutsideFences = (md: string, fn: (line: string) => string): string => {
  let fence: string | null = null
  return md
    .split("\n")
    .map((line) => {
      const m = /^\s*(`{3,}|~{3,})/.exec(line)
      if (m) {
        const marker = (m[1] as string)[0] as string
        if (fence === null) fence = marker
        else if (fence === marker) fence = null
        return line
      }
      return fence === null ? fn(line) : line
    })
    .join("\n")
}

/**
 * `[[screenshot a.png 1280x800 alt text]]` or, for a light/dark pair,
 * `[[screenshot a-light.png,a-dark.png 1280x800 alt text]]`. Files live in
 * site/assets/screenshots/. A missing file renders a placeholder and is reported.
 */
const renderScreenshot = (spec: string, ctx: RenderContext): string => {
  const m = /^(\S+)\s+(\d+)x(\d+)\s+(.+)$/.exec(spec.trim())
  if (!m) {
    ctx.problems.push(`${ctx.pageName}: bad screenshot directive "[[screenshot ${spec}]]"`)
    return ""
  }
  const names = (m[1] as string).split(",")
  const [w, h, alt] = [m[2] as string, m[3] as string, escapeHtml(m[4] as string)]
  const light = `${SCREENSHOT_DIR}/${names[0]}`
  const dark = names[1] ? `${SCREENSHOT_DIR}/${names[1]}` : null
  const lightOk = ctx.hasAsset(light)
  if (!lightOk) ctx.missingScreenshots.add(light)
  if (dark && !ctx.hasAsset(dark)) ctx.missingScreenshots.add(dark)
  if (!lightOk) {
    return [
      `<figure class="shot">`,
      `<div class="shot-missing" role="img" aria-label="Screenshot not added yet: ${alt}" style="aspect-ratio:${w}/${h};max-width:${w}px">`,
      `<span>Screenshot coming soon</span><code>${escapeHtml(names[0] as string)}</code>`,
      `</div>`,
      `</figure>`,
    ].join("\n")
  }
  const img = `<img src="${light}" alt="${alt}" width="${w}" height="${h}" loading="lazy" decoding="async">`
  if (dark && ctx.hasAsset(dark)) {
    return `<figure class="shot"><picture><source srcset="${dark}" media="(prefers-color-scheme: dark)">${img}</picture></figure>`
  }
  return `<figure class="shot">${img}</figure>`
}

/** `[[include name]]` inlines site/partials/<name>.html with blank lines removed. */
const renderInclude = (name: string, ctx: RenderContext): string => {
  const path = join(ctx.siteDir, "partials", `${name.trim()}.html`)
  if (!existsSync(path)) {
    ctx.problems.push(`${ctx.pageName}: [[include ${name}]] has no site/partials/${name}.html`)
    return ""
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .join("\n")
}

const applyDirectives = (md: string, ctx: RenderContext): string =>
  mapOutsideFences(md, (line) => {
    const t = line.trim()
    let m = /^\[\[screenshot\s+(.+?)\]\]$/.exec(t)
    if (m) return `\n${renderScreenshot(m[1] as string, ctx)}\n`
    m = /^\[\[include\s+(.+?)\]\]$/.exec(t)
    if (m) return `\n${renderInclude(m[1] as string, ctx)}\n`
    if (t === "[[decisions]]") {
      if (ctx.decisionsHtml === null) {
        ctx.problems.push(`${ctx.pageName}: [[decisions]] needs DECISIONS.md, which was not found`)
        return ""
      }
      return `\n${ctx.decisionsHtml}\n`
    }
    return line
  })

const anchorHeadings = (html: string, headings: Heading[]): string =>
  html.replace(
    /<h([1-6]) id="([^"]+)">([\s\S]*?)<\/h\1>/g,
    (_all, lvl: string, id: string, inner: string) => {
      const level = Number(lvl)
      const text = stripTags(inner).trim()
      headings.push({ level, id, text })
      if (level === 1 || level > 4) return `<h${lvl} id="${id}">${inner}</h${lvl}>`
      return `<h${lvl} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="Link to this section: ${text}">#</a></h${lvl}>`
    },
  )

const rewriteLinks = (html: string): string =>
  html.replace(/<a href="([^"]*)"/g, (_all, href: string) => {
    if (isExternal(href)) return `<a href="${href}" rel="noopener noreferrer"`
    const m = /^([^#?]*)\.md((?:[#?].*)?)$/.exec(href)
    if (m && !href.startsWith("/")) return `<a href="${m[1]}.html${m[2]}"`
    return `<a href="${href}"`
  })

const wrapCode = (html: string): string =>
  html.replace(
    /<pre><code(?: class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_all, lang: string | undefined, code: string) =>
      `<div class="code copyable"><button class="copy" type="button" aria-label="Copy code to clipboard">Copy</button><pre><code${lang ? ` data-lang="${lang}"` : ""}>${code}</code></pre></div>`,
  )

const wrapTables = (html: string): string =>
  html
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, "</table></div>")

const markCallouts = (html: string): string =>
  html.replace(
    /<blockquote>\n<p><strong>(Note|Tip|Warning)\b/g,
    (_all, kind: string) =>
      `<blockquote class="callout callout-${kind.toLowerCase()}">\n<p><strong>${kind}`,
  )

export interface Rendered {
  html: string
  headings: Heading[]
}

export const renderMarkdown = (md: string, ctx: RenderContext): Rendered => {
  const headings: Heading[] = []
  let html = Bun.markdown.html(applyDirectives(md, ctx), { headings: { ids: true } })
  html = rewriteLinks(html)
  html = anchorHeadings(html, headings)
  html = wrapCode(html)
  html = wrapTables(html)
  html = markCallouts(html)
  return { html, headings }
}

// ---------------------------------------------------------------------------------------------
// DECISIONS.md → HTML with an anchor per decision id

interface DecisionSection {
  name: string
  entries: { id: string; text: string }[]
}

export const parseDecisions = (src: string): DecisionSection[] => {
  const sections: DecisionSection[] = []
  let current: DecisionSection | null = null
  for (const line of src.split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) {
      current = { name: h[1] as string, entries: [] }
      sections.push(current)
      continue
    }
    if (!current) continue
    const e = /^-\s+([A-Z]-\d{3,})\s+[—–-]\s+(.*)$/.exec(line)
    if (e) {
      current.entries.push({ id: e[1] as string, text: e[2] as string })
    } else if (/^\s+\S/.test(line) && current.entries.length > 0) {
      const last = current.entries[current.entries.length - 1]
      if (last) last.text += ` ${line.trim()}`
    }
  }
  return sections.filter((s) => s.entries.length > 0)
}

/** Link bare ids like G-014 in a decision's text, leaving code spans alone. */
const linkDecisionIds = (text: string, own: string, known: Set<string>): string =>
  text
    .split(/(`[^`]*`)/)
    .map((part) =>
      part.startsWith("`")
        ? part
        : part.replace(/\b([A-Z]-\d{3,})\b/g, (id) =>
            id !== own && known.has(id) ? `[${id}](#${id})` : id,
          ),
    )
    .join("")

export const renderDecisions = (src: string): string => {
  const sections = parseDecisions(src)
  const known = new Set(sections.flatMap((s) => s.entries.map((e) => e.id)))
  const out: string[] = []
  for (const section of sections) {
    const id = slugify(section.name)
    out.push(`<h2 id="${id}">${escapeHtml(section.name)}</h2>`)
    out.push(`<div class="decisions">`)
    for (const entry of section.entries) {
      const body = Bun.markdown
        .html(linkDecisionIds(entry.text, entry.id, known))
        .trim()
        .replace(/^<p>([\s\S]*)<\/p>$/, "$1")
      out.push(
        `<div class="decision" id="${entry.id}"><a class="decision-id" href="#${entry.id}">${entry.id}</a><p>${body}</p></div>`,
      )
    }
    out.push(`</div>`)
  }
  return out.join("\n")
}

// ---------------------------------------------------------------------------------------------
// Page chrome

const LOGO = `<svg class="logo" viewBox="0 0 32 32" width="24" height="24" aria-hidden="true" focusable="false"><rect class="logo-bg" width="32" height="32" rx="7"/><path class="logo-tray" d="M7 17h5l1.5 3h5L20 17h5v6a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z" fill="none" stroke-width="1.8" stroke-linejoin="round"/><circle cx="23" cy="9" r="3.4" fill="#ea580c"/></svg>`

const navLabel = (p: Page): string => p.meta.nav ?? p.meta.title

const renderNav = (pages: Page[], current: Page): string => {
  const sections: { name: string; pages: Page[] }[] = []
  for (const p of pages) {
    let s = sections.find((x) => x.name === p.meta.section)
    if (!s) {
      s = { name: p.meta.section, pages: [] }
      sections.push(s)
    }
    s.pages.push(p)
  }
  const groups = sections.map((s) => {
    const items = s.pages
      .map((p) => {
        const cur = p.file === current.file ? ' aria-current="page"' : ""
        return `<li><a href="${p.file}"${cur}>${escapeHtml(navLabel(p))}</a></li>`
      })
      .join("")
    return `<div class="nav-section"><p class="nav-heading">${escapeHtml(s.name)}</p><ul>${items}</ul></div>`
  })
  return `<nav id="site-nav" class="site-nav" aria-label="Documentation">${groups.join("")}</nav>`
}

const renderToc = (headings: Heading[]): { inline: string; aside: string } => {
  const items = headings.filter((h) => h.level === 2 || h.level === 3)
  if (items.length < 2) return { inline: "", aside: "" }
  const list = items
    .map((h) => `<li class="l${h.level}"><a href="#${h.id}">${h.text}</a></li>`)
    .join("")
  return {
    inline: `<details class="toc-inline"><summary>On this page</summary><ul>${list}</ul></details>`,
    aside: `<nav class="toc" aria-label="On this page"><p class="toc-title">On this page</p><ul>${list}</ul></nav>`,
  }
}

const renderPager = (prev: Page | undefined, next: Page | undefined): string => {
  if (!prev && !next) return ""
  const link = (p: Page, dir: "prev" | "next", label: string) =>
    `<a class="${dir}" rel="${dir}" href="${p.file}"><span>${label}</span>${escapeHtml(navLabel(p))}</a>`
  return `<nav class="pager" aria-label="Previous and next page">${prev ? link(prev, "prev", "Previous") : "<span></span>"}${next ? link(next, "next", "Next") : "<span></span>"}</nav>`
}

const renderFooter = (page: Page, version: string | null, date: Date): string => {
  const parts: string[] = []
  if (version)
    parts.push(`Session Inbox ${escapeHtml(/^\d/.test(version) ? `v${version}` : version)}`)
  parts.push(`Docs built ${date.toISOString().slice(0, 10)}`)
  const source = page.meta.source ?? `site/content/${page.src}`
  parts.push(
    `<a href="${REPO_URL}/blob/main/${escapeHtml(source)}" rel="noopener noreferrer">Edit this page</a>`,
  )
  parts.push(`<a href="${REPO_URL}" rel="noopener noreferrer">Source on GitHub</a>`)
  return parts.map((p) => `<span>${p}</span>`).join("")
}

const fillTemplate = (template: string, values: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (all, key: string) =>
    key in values ? (values[key] as string) : all,
  )

// ---------------------------------------------------------------------------------------------
// Checking

const walk = (dir: string): string[] => {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

/** Check the built output: relative links, anchors, absolute paths, external resources, one h1. */
export const checkOutput = (outDir: string): string[] => {
  const problems: string[] = []
  const files = new Set(walk(outDir).map((f) => relative(outDir, f).split("\\").join("/")))
  const pages = [...files].filter((f) => f.endsWith(".html"))
  const ids = new Map<string, Set<string>>()
  const html = new Map<string, string>()
  for (const f of pages) {
    const text = readFileSync(join(outDir, f), "utf8")
    html.set(f, text)
    ids.set(f, new Set([...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string)))
  }

  for (const f of pages) {
    const text = html.get(f) as string
    const h1s = (text.match(/<h1[\s>]/g) ?? []).length
    if (h1s !== 1) problems.push(`${f}: expected exactly one <h1>, found ${h1s}`)
    if (!/<title>[^<]+<\/title>/.test(text)) problems.push(`${f}: missing <title>`)
    if (!/<meta name="description" content="[^"]+"/.test(text))
      problems.push(`${f}: missing meta description`)

    for (const tag of text.matchAll(/<(a|link|img|script|source|iframe|form)\b[^>]*>/g)) {
      const name = tag[1] as string
      const attrs = [...tag[0].matchAll(/\s(href|src|srcset|action)="([^"]*)"/g)]
      for (const a of attrs) {
        const raw = (a[2] as string).replace(/&amp;/g, "&")
        const urls =
          a[1] === "srcset" ? raw.split(",").map((s) => s.trim().split(/\s+/)[0] as string) : [raw]
        for (const url of urls) {
          if (url === "") continue
          if (isExternal(url)) {
            if (name !== "a") problems.push(`${f}: external resource <${name}> ${url}`)
            continue
          }
          if (url.startsWith("/")) {
            problems.push(`${f}: absolute link "${url}" (use a relative path)`)
            continue
          }
          const [pathAndQuery = "", ...fragParts] = url.split("#")
          const fragment = fragParts.join("#")
          const path = decodeURI(pathAndQuery.split("?")[0] as string)
          const target = path === "" ? f : posix.normalize(posix.join(posix.dirname(f), path))
          if (!files.has(target)) {
            problems.push(`${f}: broken link "${url}" (no file ${target})`)
            continue
          }
          if (fragment !== "" && target.endsWith(".html")) {
            const frag = decodeURIComponent(fragment)
            if (!ids.get(target)?.has(frag)) {
              problems.push(`${f}: broken anchor "${url}" (no #${frag} in ${target})`)
            }
          }
        }
      }
    }
  }
  return problems
}

// ---------------------------------------------------------------------------------------------
// Build

export const buildSite = (opts: BuildOptions): BuildResult => {
  const log = opts.log ?? (() => {})
  const siteDir = opts.siteDir
  const outDir = opts.outDir ?? join(siteDir, "dist")
  const templatePath = opts.templatePath ?? join(siteDir, "template.html")
  const date = opts.date ?? new Date()
  const problems: string[] = []
  const missingScreenshots = new Set<string>()

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const assetsDir = join(siteDir, "assets")
  if (existsSync(assetsDir)) {
    cpSync(assetsDir, join(outDir, "assets"), {
      recursive: true,
      filter: (src) => !src.endsWith(".gitkeep"),
    })
  }
  const hasAsset = (path: string) => existsSync(join(outDir, path))

  const decisionsHtml =
    opts.decisionsPath && existsSync(opts.decisionsPath)
      ? renderDecisions(readFileSync(opts.decisionsPath, "utf8"))
      : null

  const template = readFileSync(templatePath, "utf8")
  const contentDir = join(siteDir, "content")
  const sources = existsSync(contentDir)
    ? readdirSync(contentDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
    : []

  const pages: Page[] = []
  for (const src of sources) {
    const parsed = parseFrontMatter(readFileSync(join(contentDir, src), "utf8"))
    const checked = toMeta(parsed, `site/content/${src}`)
    if (!checked.meta) {
      problems.push(...checked.errors)
      continue
    }
    const ctx: RenderContext = {
      siteDir,
      hasAsset,
      missingScreenshots,
      problems,
      pageName: `site/content/${src}`,
      decisionsHtml,
    }
    const { html, headings } = renderMarkdown(parsed.body, ctx)
    pages.push({ file: `${src.slice(0, -3)}.html`, src, meta: checked.meta, html, headings })
  }
  pages.sort((a, b) => a.meta.order - b.meta.order || a.src.localeCompare(b.src))

  for (const [i, page] of pages.entries()) {
    const toc = page.meta.toc === false ? { inline: "", aside: "" } : renderToc(page.headings)
    // The inline "On this page" list sits right after the h1, for narrow screens.
    const content = page.html.replace(/<\/h1>/, `</h1>${toc.inline}`)
    const isHome = page.file === "index.html"
    const out = fillTemplate(template, {
      pageTitle: escapeHtml(isHome ? page.meta.title : `${page.meta.title} · Session Inbox`),
      description: escapeHtml(page.meta.description),
      logo: LOGO,
      nav: renderNav(pages, page),
      toc: toc.aside,
      content,
      pager: renderPager(pages[i - 1], pages[i + 1]),
      footer: renderFooter(page, opts.version ?? null, date),
    })
    writeFileSync(join(outDir, page.file), out)
  }

  problems.push(...checkOutput(outDir))

  log(`Built ${pages.length} pages into ${relative(process.cwd(), outDir) || outDir}`)
  for (const p of pages) log(`  ${p.file.padEnd(20)} ${p.meta.title}`)
  const missing = [...missingScreenshots].sort()
  if (missing.length > 0) {
    log(`Missing screenshots (placeholders rendered, add the files to site/assets/screenshots/):`)
    for (const m of missing) log(`  ${m}`)
  }
  return { pages, problems, missingScreenshots: missing, outDir }
}

// ---------------------------------------------------------------------------------------------
// Serve

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json",
}

export const serveDir = (dir: string) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      let path = decodeURIComponent(new URL(req.url).pathname)
      if (path.endsWith("/")) path += "index.html"
      const file = normalize(join(dir, path))
      if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) {
        return new Response("Not found", { status: 404 })
      }
      return new Response(Bun.file(file), {
        headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" },
      })
    },
  })

// ---------------------------------------------------------------------------------------------
// CLI

const readVersion = (repoRoot: string): string | null => {
  const path = join(repoRoot, "VERSION")
  if (!existsSync(path)) return null
  const v = readFileSync(path, "utf8").trim()
  return v === "" ? null : v
}

const main = () => {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean", default: false },
      serve: { type: "boolean", default: false },
    },
  })
  const repoRoot = join(dirname(import.meta.path), "..")
  const result = buildSite({
    siteDir: join(repoRoot, "site"),
    decisionsPath: join(repoRoot, "DECISIONS.md"),
    version: readVersion(repoRoot),
    log: (l) => console.log(l),
  })

  if (result.problems.length > 0) {
    const label = values.check ? "error" : "warning"
    console.error(`\n${result.problems.length} problem(s):`)
    for (const p of result.problems) console.error(`  ${label}: ${p}`)
  } else if (values.check) {
    console.log("Check passed: no broken links, anchors or missing front-matter.")
  }
  if (values.check && result.problems.length > 0) process.exit(1)

  if (values.serve) {
    const server = serveDir(result.outDir)
    console.log(`\nServing ${result.outDir}\n  http://127.0.0.1:${server.port}/\nCtrl-C to stop.`)
  }
}

if (import.meta.main) main()
