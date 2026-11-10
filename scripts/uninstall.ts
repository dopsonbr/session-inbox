/**
 * Reverse install.ts: remove our hooks and the launchd agent (same code as
 * `session-inbox uninstall`). Binaries and data in <home> are left alone unless --purge.
 * DRY RUN by default — pass --yes to apply.
 *   --channel ga|beta (default ga; the other channel's hooks are kept)
 *   --settings <path>  --home <dir>  --no-launchd  --no-hooks
 *   --app (also remove ~/Applications/<app>)  --purge (also delete <home>, incl. the database)
 */
import { parseArgs } from "node:util"
import { defaultSettingsPath, parseChannel } from "../apps/cli/src/common.ts"
import { uninstall } from "../apps/cli/src/uninstall.ts"
import { CHANNELS } from "../packages/contracts/src/paths.ts"

const { values } = parseArgs({
  options: {
    yes: { type: "boolean", default: false },
    channel: { type: "string" },
    app: { type: "boolean", default: false },
    purge: { type: "boolean", default: false },
    settings: { type: "string" },
    home: { type: "string" },
    "no-launchd": { type: "boolean", default: false },
    "no-hooks": { type: "boolean", default: false },
  },
})
const channel = parseChannel(values.channel)
uninstall(
  {
    apply: values.yes === true,
    channel,
    home: values.home ?? CHANNELS[channel].home,
    settingsPath: values.settings ?? defaultSettingsPath(),
    launchd: !values["no-launchd"],
    hooks: !values["no-hooks"],
    app: values.app === true,
    purge: values.purge === true,
  },
  (s) => console.log(s),
)
