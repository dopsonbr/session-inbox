// Build the Tauri shell as an ad-hoc signed .app bundle and print its path.
//   bun scripts/build-shell.ts
import { existsSync } from "node:fs"
import { join } from "node:path"

const tauriDir = join(import.meta.dir, "..", "apps", "desktop", "src-tauri")
const proc = Bun.spawn(["bunx", "@tauri-apps/cli@2.12.4", "build", "--bundles", "app"], {
  cwd: tauriDir,
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
})
if ((await proc.exited) !== 0) process.exit(1)

const app = join(tauriDir, "target", "release", "bundle", "macos", "Session Inbox.app")
if (!existsSync(app)) {
  console.error(`build finished but ${app} is missing`)
  process.exit(1)
}
console.log(app)
