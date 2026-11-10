# Docs site

The documentation at <https://dopsonbr.github.io/session-inbox/> is built from this folder by `scripts/build-site.ts`. It is plain Bun: Markdown goes through `Bun.markdown`, and the output is static HTML with relative links, so it works under `/session-inbox/` and when opened from `file://`. No framework, no web fonts, no external requests.

## Docs

### Layout

| Path | What |
| --- | --- |
| `content/*.md` | One file per page. The file name is the page address: `install.md` becomes `install.html`. |
| `template.html` | The one HTML template every page uses. |
| `assets/site.css`, `assets/site.js` | The stylesheet (tokens plus a dark-mode block) and the small script for the mobile menu and copy buttons. |
| `assets/screenshots/` | Screenshot files. Missing ones render a placeholder. |
| `partials/*.html` | Hand-written HTML that a page pulls in with `[[include name]]` (the install box and the flow diagram). |
| `dist/` | The build output. It's git-ignored. |

### Add or edit a page

Create `content/<name>.md` and start it with front-matter. All four keys are required, and the build fails without them:

```text
---
title: Page title
description: One sentence for search results and link previews.
order: 7
section: Guides
---
```

`order` sets the position in the sidebar and in the previous and next links. `section` groups pages in the sidebar, in the order sections first appear. Optional keys are `nav` (a shorter sidebar label), `toc: false` (no "On this page" list) and `source` (the repository path the "Edit this page" link points to).

Then write Markdown with one `# Heading` at the top. Link to other pages by their Markdown name and the build turns it into the right address:

```text
See [Settings](settings.md) or [a section](settings.md#approvals).
```

Heading anchors, the "On this page" list, copy buttons on code blocks and the navigation are added for you. Put each command in its own fenced code block so it can be copied on its own. Start a paragraph with `**Note**`, `**Tip**` or `**Warning**` inside a blockquote for a callout.

### Screenshots

Put a screenshot on a page with a line of its own:

```text
[[screenshot popover.png 420x560 Alt text describing what the screenshot shows.]]
```

The file goes in `assets/screenshots/`. The numbers are the image's width and height in pixels, and they reserve the space before it loads. For a light and dark pair, give both file names separated by a comma and the page shows the one that matches the reader's theme:

```text
[[screenshot inbox-light.png,inbox-dark.png 1440x900 Alt text.]]
```

If the file isn't there yet, the page shows a placeholder and the build lists the missing file. Slots in use: `inbox-light.png` and `inbox-dark.png` (Home, 1440×900), `popover.png` (Using it, 380×520), `approval-diff.png` (Using it, 1440×900), `settings.png` (Settings, 1440×900) and `setup.png` (Troubleshooting, 1440×900). The files are twice that size in pixels, for high-density screens.

The screenshots are generated, not taken by hand. Build the UI once, then run the script. It starts the seeded demo daemon (`scripts/demo.ts`) and renders each view in headless Chrome (Chrome, Chromium or Edge in `/Applications`, no screen-recording permission), writing the six files to `assets/screenshots/`:

```bash
bun run --cwd apps/desktop build
```

```bash
bun scripts/screenshots.ts
```

When a view changes, re-run it and re-check each slot's alt text.

### Keep it true

When behaviour changes, update the matching page in `content/` in the same change. Don't write a flag, default, label or behaviour on a page unless you can find it in the code, and quote UI labels exactly. Claims that no person has checked yet go in the "Not yet verified by a person" list at the bottom of `content/troubleshooting.md`; remove a line when someone has.

Two notes are written to be deleted once the first release is published: the blocks between `<!-- REMOVE AFTER FIRST RELEASE -->` and `<!-- /REMOVE AFTER FIRST RELEASE -->` in `index.md`, `install.md` and `changelog.md`.

### The Decisions page

`content/decisions.md` has a line that says `[[decisions]]`. At build time that line is replaced with the contents of the repository's `DECISIONS.md`, with an anchor for every decision id (`decisions.html#G-014`). Don't copy decisions into the site; add them to `DECISIONS.md`. Other pages can link straight to one: `[G-014](decisions.md#G-014)`.

### Version and build date

The footer shows the version from the `VERSION` file at the repository root, if it exists, and the date the site was built.

### Preview

```bash
bun scripts/build-site.ts --serve
```

This builds the site and serves `site/dist` on a random localhost port, and prints the address. Rebuild by stopping it and running it again. You can also run a plain `bun scripts/build-site.ts` and open `site/dist/index.html` directly.

### Check links

```bash
bun scripts/build-site.ts --check
```

This builds the site, then exits with an error if any internal link or `#anchor` points nowhere, a page is missing front-matter, a link is absolute (starts with `/`), a page loads an external resource, or a page doesn't have exactly one `<h1>`. CI runs it before every deploy.

### Deploy

`.github/workflows/pages.yml` builds and deploys the site when `site/**`, the builder, `README.md`, `DECISIONS.md` or `VERSION` change on `main`. In the repository settings, Pages needs its source set to **GitHub Actions** once.

### Tests

The builder is covered by `site/test/build-site.test.ts`, which runs with the rest of `bun test`.
