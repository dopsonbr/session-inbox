/**
 * GA and beta side by side (H-014, H-016); same code as `session-inbox status|holds|open`.
 *   bun scripts/channels.ts                   status of both channels
 *   bun scripts/channels.ts holds <ga|beta>   that channel holds hooks; the other observes
 *   bun scripts/channels.ts open <ga|beta>    open that channel's inbox in the browser
 */
import { openInbox, setHolds, status } from "../apps/cli/src/status.ts"
import { isChannel } from "../packages/contracts/src/paths.ts"

const [cmd = "status", arg] = process.argv.slice(2)
const say = (s: string) => console.log(s)

if (cmd === "status") await status(say)
else if (cmd === "holds" && isChannel(arg)) setHolds(arg, say)
else if (cmd === "open" && isChannel(arg)) openInbox(arg)
else {
  console.error("usage: bun scripts/channels.ts [status | holds <ga|beta> | open <ga|beta>]")
  process.exit(1)
}
