// Build the Tauri shell as an ad-hoc signed .app bundle and print its path.
//   bun scripts/build-shell.ts [--channel ga|beta]
// The beta channel builds "Session Inbox Beta.app", which runs beside the ga app
// (own bundle id, URL scheme, launchd label, data home and shortcut; see src/channel.rs).
import { existsSync } from "node:fs"
import { join } from "node:path"

export type Channel = "ga" | "beta"

/** Product name for a channel; also the .app bundle name. */
export const productName = (channel: Channel): string =>
  channel === "beta" ? "Session Inbox Beta" : "Session Inbox"

/** Inline `tauri build --config` override for a channel; null for ga (tauri.conf.json as is). */
export function configOverride(channel: Channel): Record<string, unknown> | null {
  if (channel !== "beta") return null
  return {
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

  const tauriDir = join(import.meta.dir, "..", "apps", "desktop", "src-tauri")
  const override = configOverride(channel)
  const args = ["bunx", "@tauri-apps/cli@2.12.4", "build", "--bundles", "app"]
  if (override) args.push("--config", JSON.stringify(override))

  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `/opt/homebrew/bin:${process.env.PATH}`,
  }
  if (channel === "beta") env.SESSION_INBOX_CHANNEL = "beta"
  else delete env.SESSION_INBOX_CHANNEL

  const proc = Bun.spawn(args, { cwd: tauriDir, stdout: "inherit", stderr: "inherit", env })
  if ((await proc.exited) !== 0) process.exit(1)

  const app = join(
    tauriDir,
    "target",
    "release",
    "bundle",
    "macos",
    `${productName(channel)}.app`,
  )
  if (!existsSync(app)) {
    console.error(`build finished but ${app} is missing`)
    process.exit(1)
  }
  console.log(app)
}
