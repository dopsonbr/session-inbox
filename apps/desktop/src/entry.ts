import "./styles.css"
import { Effect, Layer, Option } from "effect"
import { Runtime } from "foldkit"
import { DaemonClient, type DaemonClientShape } from "./client/daemonClient.ts"
import { makeHttpClient, readTokenFromDocument } from "./client/http.ts"
import { Message } from "./message.ts"
import { Model } from "./model.ts"
import { itemIdFromHash } from "./selectors.ts"
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
    return makeFakeClient({ update: params.get("update") ?? "idle" })
  }
  return makeHttpClient({ token: readTokenFromDocument(document) })
}

const flags: Effect.Effect<Flags> = Effect.sync(() => ({
  view: params.get("view") === "compact" ? "compact" : "full",
  now: Date.now(),
  maybeInitialItemId:
    params.get("view") === "compact" ? Option.none() : itemIdFromHash(window.location.hash),
}))

const client = await loadClient()

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
