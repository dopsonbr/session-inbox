/** Compile inbox-hook and inboxd into dist/, and build the UI into dist/ui. Usage: bun scripts/build.ts */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const dist = join(root, "dist")

const targets = [
  { name: "inbox-hook", entry: "apps/hook/src/main.ts", flags: ["--minify", "--bytecode"] },
  { name: "inboxd", entry: "apps/daemon/src/main.ts", flags: ["--minify"] },
]

export const build = async (): Promise<string[]> => {
  mkdirSync(dist, { recursive: true })
  const built: string[] = []
  for (const t of targets) {
    if (!existsSync(join(root, t.entry))) {
      console.warn(`warning: ${t.entry} not found; skipping ${t.name}`)
      continue
    }
    const outfile = join(dist, t.name)
    const p = Bun.spawnSync(
      ["bun", "build", "--compile", ...t.flags, join(root, t.entry), "--outfile", outfile],
      { cwd: root, stdout: "inherit", stderr: "inherit" },
    )
    if (p.exitCode !== 0) throw new Error(`build failed: ${t.name}`)
    built.push(outfile)
  }
  // The UI the daemon serves (G-011). The compiled daemon can't find the repo, so ship a copy.
  if (existsSync(join(root, "apps/desktop/package.json"))) {
    const p = Bun.spawnSync(["bun", "run", "build"], {
      cwd: join(root, "apps/desktop"),
      stdout: "inherit",
      stderr: "inherit",
    })
    if (p.exitCode !== 0) throw new Error("build failed: ui")
    rmSync(join(dist, "ui"), { recursive: true, force: true })
    cpSync(join(root, "apps/desktop/dist"), join(dist, "ui"), { recursive: true })
    built.push(join(dist, "ui"))
  }
  return built
}

if (import.meta.main) {
  const out = await build()
  console.log(`built: ${out.join(", ") || "(nothing)"}`)
}
