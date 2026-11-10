/** Bump the root VERSION file and print the new version. Usage: bun scripts/bump.ts patch|minor|major */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Bump, bumpVersion } from "../apps/cli/src/semver.ts"
import { fileVersion } from "./build.ts"

const bump = process.argv[2]
if (bump !== "patch" && bump !== "minor" && bump !== "major") {
  console.error("usage: bun scripts/bump.ts patch|minor|major")
  process.exit(2)
}
const next = bumpVersion(fileVersion(), bump as Bump)
writeFileSync(join(import.meta.dir, "..", "VERSION"), `${next}\n`)
console.log(next)
