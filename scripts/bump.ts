/**
 * Bump the root VERSION file and print the new version.
 * Usage: bun scripts/bump.ts none|patch|minor|major   (none prints VERSION as it stands)
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Bump, bumpVersion } from "../apps/cli/src/semver.ts"
import { fileVersion } from "./build.ts"

const bump = process.argv[2]
if (bump !== "none" && bump !== "patch" && bump !== "minor" && bump !== "major") {
  console.error("usage: bun scripts/bump.ts none|patch|minor|major")
  process.exit(2)
}
if (bump === "none") {
  console.log(fileVersion())
} else {
  const next = bumpVersion(fileVersion(), bump as Bump)
  writeFileSync(join(import.meta.dir, "..", "VERSION"), `${next}\n`)
  console.log(next)
}
