/**
 * DaemonClient over HTTP + SSE, same-origin (G-011). Every request is a
 * relative `/v1/...` URL with `Authorization: Bearer <token>`; the token comes
 * from the `<meta name="session-inbox-token">` the daemon injects. In dev the
 * Vite proxy adds the header instead, so an empty token is fine there.
 */
import {
  ActionResponse,
  ItemDetail,
  OpenResponse,
  Routes,
  Snapshot,
  StreamMessage,
} from "@session-inbox/contracts"
import { Effect, Queue, Schema, Stream } from "effect"
import { DaemonClient, type DaemonClientShape, DaemonError } from "./daemonClient.ts"
import { feed, initialSseState, type SseState } from "./sse.ts"

export const TOKEN_META_NAME = "session-inbox-token"

export const readTokenFromDocument = (doc: Document): string =>
  doc.querySelector(`meta[name="${TOKEN_META_NAME}"]`)?.getAttribute("content") ?? ""

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type HttpClientConfig = Readonly<{
  token: string
  fetch?: FetchLike
  /** Prefix for every route; "" keeps URLs relative (the default and the norm). */
  baseUrl?: string
}>

const toDaemonError = (error: unknown): DaemonError =>
  error instanceof DaemonError
    ? error
    : new DaemonError({
        message: error instanceof Error ? error.message : String(error),
        status: null,
      })

export const makeHttpClient = (config: HttpClientConfig): DaemonClientShape => {
  const doFetch: FetchLike = config.fetch ?? ((input, init) => fetch(input, init))
  const base = config.baseUrl ?? ""
  const headers = (extra: Record<string, string> = {}): Record<string, string> =>
    config.token === "" ? extra : { ...extra, authorization: `Bearer ${config.token}` }

  const request = (method: string, path: string, body?: unknown): Effect.Effect<unknown, DaemonError> =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await doFetch(`${base}${path}`, {
          method,
          signal,
          headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const text = await response.text()
        const json: unknown = text === "" ? null : JSON.parse(text)
        if (!response.ok) {
          const message =
            json !== null && typeof json === "object" && "message" in json
              ? String((json as { message: unknown }).message)
              : `${response.status} ${response.statusText}`
          throw new DaemonError({ message, status: response.status })
        }
        return json
      },
      catch: toDaemonError,
    })

  const decoded =
    <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
    (effect: Effect.Effect<unknown, DaemonError>): Effect.Effect<S["Type"], DaemonError> =>
      effect.pipe(
        Effect.flatMap((json) =>
          Schema.decodeUnknownEffect(schema)(json).pipe(
            Effect.mapError(
              (issue) => new DaemonError({ message: `Bad response: ${issue.message}`, status: null }),
            ),
          ),
        ),
      )

  const decodeStreamMessage = Schema.decodeUnknownOption(StreamMessage)

  const stream = (since: number | null): Stream.Stream<StreamMessage, DaemonError> =>
    Stream.callback<StreamMessage, DaemonError>((queue) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await doFetch(`${base}${Routes.stream(since, "ui")}`, {
            method: "GET",
            signal,
            headers: headers({ accept: "text/event-stream" }),
          })
          if (!response.ok || response.body === null) {
            throw new DaemonError({
              message: `stream: ${response.status} ${response.statusText}`,
              status: response.status,
            })
          }
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let state: SseState = initialSseState
          for (;;) {
            const { done, value } = await reader.read()
            if (done) {
              break
            }
            const result = feed(state, decoder.decode(value, { stream: true }))
            state = result.state
            for (const event of result.events) {
              try {
                const message = decodeStreamMessage(JSON.parse(event.data))
                if (message._tag === "Some") {
                  Queue.offerUnsafe(queue, message.value)
                }
              } catch {
                // Malformed frame: skip it; the next delta or a reset will resync.
              }
            }
          }
          Queue.endUnsafe(queue)
        },
        catch: toDaemonError,
      }),
    )

  return {
    snapshot: decoded(Snapshot)(request("GET", Routes.snapshot)),
    stream,
    itemDetail: (itemId) => decoded(ItemDetail)(request("GET", Routes.item(itemId))),
    answers: (itemId, body) =>
      decoded(ActionResponse)(request("POST", Routes.answers(itemId), body)),
    decision: (itemId, body) =>
      decoded(ActionResponse)(request("POST", Routes.decision(itemId), body)),
    reply: (itemId, body) => decoded(ActionResponse)(request("POST", Routes.reply(itemId), body)),
    snooze: (itemId, body) =>
      decoded(ActionResponse)(request("POST", Routes.snooze(itemId), body)),
    dismiss: (itemId) => decoded(ActionResponse)(request("POST", Routes.dismiss(itemId), {})),
    draft: (itemId, body) => Effect.asVoid(request("PUT", Routes.draft(itemId), body)),
    read: (itemId) => Effect.asVoid(request("POST", Routes.read(itemId), {})),
    open: (itemId) => decoded(OpenResponse)(request("POST", Routes.openInClaude(itemId), {})),
    mute: (projectId, body) => Effect.asVoid(request("POST", Routes.projectMute(projectId), body)),
  }
}

export const httpClientService = (config: HttpClientConfig) =>
  DaemonClient.of(makeHttpClient(config))
