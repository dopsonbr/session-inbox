/// <reference path="./text-modules.d.ts" />
/**
 * The product version and build stamp, shared by hook, daemon and CLI (H-019).
 * Compiled binaries get both from `bun build --define` (scripts/build.ts), so a release
 * built with `--version` reports that version; source runs read the root VERSION file.
 * Node/Bun only, like `./paths`: the UI never imports this.
 */
import fileVersion from "../../../VERSION" with { type: "text" }

declare const SESSION_INBOX_VERSION: string | undefined
declare const SESSION_INBOX_BUILD: string | undefined

export const VERSION: string =
  typeof SESSION_INBOX_VERSION === "string" ? SESSION_INBOX_VERSION : fileVersion.trim()

/** "<short sha>[-dirty]" of the checkout a binary was built from; "dev" from source. */
export const BUILD: string = typeof SESSION_INBOX_BUILD === "string" ? SESSION_INBOX_BUILD : "dev"
