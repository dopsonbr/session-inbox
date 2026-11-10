// Build the Tauri shell as an ad-hoc signed .app bundle and print its path.
//   bun scripts/build-shell.ts [--channel ga|beta]
// The beta channel builds "Session Inbox Beta.app", which runs beside the ga app
// (own bundle id, URL scheme, launchd label, data home and shortcut; see src/channel.rs).
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

export type Channel = "ga" | "beta"

/** Product name for a channel; also the .app bundle name. */
export const productName = (channel: Channel): string =>
  channel === "beta" ? "Session Inbox Beta" : "Session Inbox"

/** Version to stamp: repo-root VERSION if present, else the Cargo package version. */
export function readVersion(root: string): string {
  const file = join(root, "VERSION")
  if (existsSync(file)) {
    const v = readFileSync(file, "utf8").trim()
    if (v) return v
  }
  const cargo = readFileSync(join(root, "apps", "desktop", "src-tauri", "Cargo.toml"), "utf8")
  const m = cargo.match(/^version\s*=\s*"([^"]+)"/m)
  if (!m) throw new Error("no version in VERSION or Cargo.toml")
  return m[1]
}

/** Inline `tauri build --config` override: always the version; beta adds its identity. */
export function configOverride(channel: Channel, version: string): Record<string, unknown> {
  if (channel !== "beta") return { version }
  return {
    version,
    productName: productName("beta"),
    identifier: "com.sessioninbox.app.beta",
    plugins: { "deep-link": { desktop: { schemes: ["sessioninbox-beta"] } } },
  }
}

export function parseChannel(argv: string[]): Channel {
  const i = argv.indexOf("--channel")
  const value = i >= 0 ? argv[i + 1] : undefined
  if (value === undefined && i < 0) return "ga"
  if (value === "ga" || value === "beta") return value
  throw new Error(`--channel must be ga or beta (got ${value ?? "nothing"})`)
}

if (import.meta.main) {
  let channel: Channel
  try {
    channel = parseChannel(process.argv.slice(2))
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  const root = join(import.meta.dir, "..")
  const tauriDir = join(root, "apps", "desktop", "src-tauri")
  const override = configOverride(channel, readVersion(root))
  const args = ["bunx", "@tauri-apps/cli@2.12.4", "build", "--bundles", "app"]
  args.push("--config", JSON.stringify(override))

  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `/opt/homebrew/bin:${process.env.PATH}`,
  }
  if (channel === "beta") env.SESSION_INBOX_CHANNEL = "beta"
  else delete env.SESSION_INBOX_CHANNEL

  const proc = Bun.spawn(args, { cwd: tauriDir, stdout: "inherit", stderr: "inherit", env })
  if ((await proc.exited) !== 0) process.exit(1)

  const bundleDir = join(tauriDir, "target", "release", "bundle")
  const built = join(bundleDir, "macos", `${productName(channel)}.app`)
  if (!existsSync(built)) {
    console.error(`build finished but ${built} is missing`)
    process.exit(1)
  }
  // Per-channel copy so a later build of the other channel never touches this bundle.
  const app = join(bundleDir, channel, `${productName(channel)}.app`)
  rmSync(app, { recursive: true, force: true })
  const copy = Bun.spawnSync(["ditto", built, app], { stdout: "inherit", stderr: "inherit" })
  if (copy.exitCode !== 0) process.exit(1)
  console.log(app)
}
