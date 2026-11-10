/**
 * Install Session Inbox from this checkout: build a payload (hook, daemon, CLI, UI), then
 * run the same install code as `session-inbox install` (H-019).
 * DRY RUN by default — pass --yes to change anything.
 *   --channel ga|beta  which install (default ga). Beta lives beside GA with its own home,
 *                      launchd label, port and app (H-014); build it from your working checkout.
 *   --settings <path>  target Claude settings file (default ~/.claude/settings.json)
 *   --home <dir>       Session Inbox home (default per channel, under Application Support)
 *   --holds            hold hooks even if another channel's hooks are installed (H-016)
 *   --app              also build the menu-bar app and install it in ~/Applications (slow)
 *   --no-launchd       skip plist + launchctl
 *   --no-hooks         skip settings.json
 *   --no-path          don't link ~/.local/bin/session-inbox[-beta]
 */
import { join } from "node:path"
import { parseArgs } from "node:util"
import { defaultSettingsPath, parseChannel } from "../apps/cli/src/common.ts"
import { install } from "../apps/cli/src/install.ts"
import { CHANNELS } from "../packages/contracts/src/paths.ts"
import { fileVersion } from "./build.ts"
import { buildPayload, buildShell } from "./release.ts"

const { values } = parseArgs({
  options: {
    yes: { type: "boolean", default: false },
    channel: { type: "string" },
    settings: { type: "string" },
    home: { type: "string" },
    holds: { type: "boolean", default: false },
    app: { type: "boolean", default: false },
    "no-launchd": { type: "boolean", default: false },
    "no-hooks": { type: "boolean", default: false },
    "no-path": { type: "boolean", default: false },
  },
})

const apply = values.yes === true
const channel = parseChannel(values.channel)
const root = join(import.meta.dir, "..")
const payload = join(root, "dist", `payload-${channel}`)
const say = (s: string) => console.log(s)

// A dry run builds nothing.
if (apply) await buildPayload({ dir: payload, version: fileVersion() })
else say(`would build ${payload} from this checkout`)
const appBundle = apply && values.app ? buildShell(channel) : null
if (!apply && values.app) say(`would build the ${channel} menu-bar app`)

await install(
  {
    payload,
    apply,
    channel,
    home: values.home ?? CHANNELS[channel].home,
    settingsPath: values.settings ?? defaultSettingsPath(),
    holds: values.holds === true,
    launchd: !values["no-launchd"],
    hooks: !values["no-hooks"],
    app: values.app === true,
    appBundle,
    pathLink: !values["no-path"],
    source: "source",
    updating: false,
  },
  say,
)
