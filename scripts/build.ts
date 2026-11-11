/**
 * Compile inbox-hook, inboxd and the session-inbox CLI, and build the UI.
 *   bun scripts/build.ts                 → dist/<binaries>, dist/ui
 * `build({ binDir, uiDir, version })` is what scripts/release.ts and scripts/install.ts use.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const dist = join(root, "dist")

export const BINARIES = ["inbox-hook", "inboxd", "session-inbox"] as const

/**
 * The daemon and the CLI reach GitHub, so they trust the macOS keychain as well as Bun's own CA
 * list (H-055): a TLS-inspecting proxy's root lives only there, and launchd passes none of the
 * shell's NODE_EXTRA_CA_CERTS. The hook talks only to the local daemon, so it stays lean.
 */
const SYSTEM_CA = "--compile-exec-argv=--use-system-ca"

export const targets = [
  { name: "inbox-hook", entry: "apps/hook/src/main.ts", flags: ["--minify", "--bytecode"] },
  { name: "inboxd", entry: "apps/daemon/src/main.ts", flags: ["--minify", SYSTEM_CA] },
  { name: "session-inbox", entry: "apps/cli/src/main.ts", flags: ["--minify", SYSTEM_CA] },
]

/** The version in the root VERSION file. */
export const fileVersion = (): string => readFileSync(join(root, "VERSION"), "utf8").trim()

/** "<short sha>[-dirty]" of the checkout, so two installed channels can be told apart. */
export const buildStamp = (): string => {
  const git = (...a: string[]) =>
    Bun.spawnSync(["git", ...a], { cwd: root })
      .stdout.toString()
      .trim()
  const sha = git("rev-parse", "--short", "HEAD") || "unknown"
  return git("status", "--porcelain") ? `${sha}-dirty` : sha
}

export type BuildOptions = {
  binDir?: string
  uiDir?: string
  version?: string
  stamp?: string
  /** Echo bun's output (default true); tests pass false to keep logs short. */
  verbose?: boolean
}

export const build = async (opts: BuildOptions = {}): Promise<string[]> => {
  const binDir = opts.binDir ?? dist
  const uiDir = opts.uiDir ?? join(dist, "ui")
  const io = opts.verbose === false ? "ignore" : "inherit"
  mkdirSync(binDir, { recursive: true })
  const define = [
    "--define",
    `SESSION_INBOX_BUILD=${JSON.stringify(opts.stamp ?? buildStamp())}`,
    "--define",
    `SESSION_INBOX_VERSION=${JSON.stringify(opts.version ?? fileVersion())}`,
  ]
  const built: string[] = []
  for (const t of targets) {
    const outfile = join(binDir, t.name)
    const p = Bun.spawnSync(
      [
        "bun",
        "build",
        "--compile",
        ...t.flags,
        ...define,
        join(root, t.entry),
        "--outfile",
        outfile,
      ],
      { cwd: root, stdout: io, stderr: "inherit" },
    )
    if (p.exitCode !== 0) throw new Error(`build failed: ${t.name}`)
    built.push(outfile)
  }
  // The UI the daemon serves (G-011). The compiled daemon can't find the repo, so ship a copy.
  if (existsSync(join(root, "apps/desktop/package.json"))) {
    const p = Bun.spawnSync(["bun", "run", "build"], {
      cwd: join(root, "apps/desktop"),
      stdout: io,
      stderr: "inherit",
    })
    if (p.exitCode !== 0) throw new Error("build failed: ui")
    rmSync(uiDir, { recursive: true, force: true })
    cpSync(join(root, "apps/desktop/dist"), uiDir, { recursive: true })
    built.push(uiDir)
  }
  return built
}

if (import.meta.main) {
  const out = await build()
  console.log(`built: ${out.join(", ") || "(nothing)"}`)
}
