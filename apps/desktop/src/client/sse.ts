/**
 * Incremental Server-Sent Events parser (WHATWG "event stream interpretation").
 *
 * Pure: `feed(state, chunk)` returns the next state and the events completed by
 * this chunk. Chunks may split anywhere — mid-line, mid-CRLF, mid-field. We use
 * fetch + this parser instead of EventSource because EventSource can't send an
 * Authorization header (U-003).
 */

export type SseEvent = Readonly<{
  /** `event:` field, "message" when absent. */
  event: string
  data: string
  /** Last seen `id:` (sticky across events, per spec). */
  id: string | null
}>

export type SseState = Readonly<{
  /** Unterminated tail of the previous chunk. */
  buffer: string
  /** The previous chunk ended in "\r"; a leading "\n" in the next chunk belongs to it. */
  pendingCr: boolean
  dataLines: ReadonlyArray<string>
  eventType: string
  lastId: string | null
  /** Server-requested reconnection delay (`retry:`), if any. */
  retryMs: number | null
}>

export const initialSseState: SseState = {
  buffer: "",
  pendingCr: false,
  dataLines: [],
  eventType: "",
  lastId: null,
  retryMs: null,
}

type FieldState = Omit<SseState, "buffer" | "pendingCr">

const dispatch = (
  state: FieldState,
): { readonly state: FieldState; readonly event: SseEvent | null } => {
  const reset = { ...state, dataLines: [], eventType: "" }
  if (state.dataLines.length === 0) {
    return { state: reset, event: null }
  }
  return {
    state: reset,
    event: {
      event: state.eventType === "" ? "message" : state.eventType,
      data: state.dataLines.join("\n"),
      id: state.lastId,
    },
  }
}

const applyLine = (
  state: FieldState,
  line: string,
): { readonly state: FieldState; readonly event: SseEvent | null } => {
  if (line === "") {
    return dispatch(state)
  }
  if (line.startsWith(":")) {
    // Comment — the daemon's heartbeat.
    return { state, event: null }
  }
  const colon = line.indexOf(":")
  const field = colon === -1 ? line : line.slice(0, colon)
  const rawValue = colon === -1 ? "" : line.slice(colon + 1)
  const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue
  if (field === "data") {
    return { state: { ...state, dataLines: [...state.dataLines, value] }, event: null }
  }
  if (field === "event") {
    return { state: { ...state, eventType: value }, event: null }
  }
  if (field === "id") {
    return value.includes("\u0000")
      ? { state, event: null }
      : { state: { ...state, lastId: value }, event: null }
  }
  if (field === "retry") {
    return /^\d+$/.test(value)
      ? { state: { ...state, retryMs: Number(value) }, event: null }
      : { state, event: null }
  }
  return { state, event: null }
}

export const feed = (
  state: SseState,
  chunk: string,
): { readonly state: SseState; readonly events: ReadonlyArray<SseEvent> } => {
  const input = state.pendingCr && chunk.startsWith("\n") ? chunk.slice(1) : chunk
  const text = state.buffer + input
  const lines = text.split(/\r\n|\r|\n/)
  // The last element is an unterminated line (possibly empty).
  const tail = lines.pop() ?? ""
  const endsWithCr = text.endsWith("\r")
  const { buffer: _b, pendingCr: _p, ...fields } = state
  const result = lines.reduce<{ state: FieldState; events: Array<SseEvent> }>(
    (acc, line) => {
      const next = applyLine(acc.state, line)
      return {
        state: next.state,
        events: next.event === null ? acc.events : [...acc.events, next.event],
      }
    },
    { state: fields, events: [] },
  )
  return {
    state: { ...result.state, buffer: tail, pendingCr: endsWithCr },
    events: result.events,
  }
}
