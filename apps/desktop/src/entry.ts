import "./styles.css"
import { Effect, Layer, Option } from "effect"
import { Runtime } from "foldkit"
import { DaemonClient, type DaemonClientShape } from "./client/daemonClient.ts"
import { addressWithoutToken, makeHttpClient, readTokenFromDocument } from "./client/http.ts"
import { Message } from "./message.ts"
import { Model } from "./model.ts"
import { routeFromHash } from "./selectors.ts"
import { subscriptions } from "./subscriptions.ts"
import { type Flags, Flags as FlagsSchema, init, update } from "./update.ts"
import { view } from "./view/index.ts"

declare const __SESSION_INBOX_DEFAULT_CLIENT__: "http" | "fake"

const params = new URLSearchParams(window.location.search)

/** `?client=fake|http` overrides the build-time default (U-004). */
const clientKind = params.get("client") ?? __SESSION_INBOX_DEFAULT_CLIENT__

const loadClient = async (): Promise<DaemonClientShape> => {
  if (clientKind === "fake") {
    const { makeFakeClient } = await import("./client/fake.ts")
    return makeFakeClient({
      update: params.get("update") ?? "idle",
      setup: params.get("setup"),
      reply: params.get("reply"),
      needs: params.get("needs"),
      // Small pages by default, so dev:mock shows "Load more" (`?historyPage=50` for the real size).
      historyPageSize: Number(params.get("historyPage") ?? 8) || 8,
    })
  }
  return makeHttpClient({ token: readTokenFromDocument(document) })
}

const flags: Effect.Effect<Flags> = Effect.sync(() => {
  const isCompact = params.get("view") === "compact"
  const route = routeFromHash(window.location.hash)
  return {
    view: isCompact ? "compact" : "full",
    now: Date.now(),
    // The popover opened on `#/item/<id>` marks that row (U-090); it has no History.
    maybeInitialItemId:
      route._tag === "item" || (!isCompact && route._tag === "history")
        ? Option.fromNullishOr(route.itemId)
        : Option.none(),
    initialRoute: isCompact || route._tag === "item" ? "inbox" : route._tag,
  }
})

const client = await loadClient()

// The token is in the page now (and in the cookie for reloads): keep it out of the address bar.
const stripped = addressWithoutToken(window.location.href)
if (stripped !== null) window.history.replaceState(window.history.state, "", stripped)

const application = Runtime.makeApplication({
  Model,
  Flags: FlagsSchema,
  init,
  update,
  view,
  subscriptions,
  resources: Layer.succeed(DaemonClient, client),
  container: document.getElementById("root") as HTMLElement,
  devTools: { Message },
})

Runtime.run(application, { flags })
