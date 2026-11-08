/**
 * Hook payloads (what Claude Code writes to a command hook's stdin) and the
 * envelope inbox-hook forwards to the daemon.
 *
 * Decode payloads with `decodeHookPayload` — Claude adds fields between
 * releases and we keep (and store) everything we don't understand. (Effect 4
 * has no `onExcessProperty: "preserve"`, so we overlay the typed fields onto the
 * raw object; see DECISIONS.md.)
 */
import { Schema } from "effect"

export const HookEvent = Schema.Literals([
  "SessionStart",
  "UserPromptSubmit",
  "Notification",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "SessionEnd",
])
export type HookEvent = typeof HookEvent.Type

/** Fields every hook payload carries. */
export const HookBase = Schema.Struct({
  session_id: Schema.String,
  transcript_path: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  permission_mode: Schema.optional(Schema.String),
  hook_event_name: Schema.String,
})
export type HookBase = typeof HookBase.Type

export const PreToolUsePayload = Schema.Struct({
  ...HookBase.fields,
  tool_name: Schema.String,
  tool_input: Schema.Unknown,
  tool_use_id: Schema.optional(Schema.String),
})
export type PreToolUsePayload = typeof PreToolUsePayload.Type

export const PostToolUsePayload = Schema.Struct({
  ...HookBase.fields,
  tool_name: Schema.String,
  tool_input: Schema.Unknown,
  tool_response: Schema.optional(Schema.Unknown),
  tool_use_id: Schema.optional(Schema.String),
})
export type PostToolUsePayload = typeof PostToolUsePayload.Type

export const NotificationPayload = Schema.Struct({
  ...HookBase.fields,
  message: Schema.optional(Schema.String),
  notification_type: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
})
export type NotificationPayload = typeof NotificationPayload.Type

export const UserPromptSubmitPayload = Schema.Struct({
  ...HookBase.fields,
  prompt: Schema.String,
})
export type UserPromptSubmitPayload = typeof UserPromptSubmitPayload.Type

export const SessionStartPayload = Schema.Struct({
  ...HookBase.fields,
  source: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
})
export type SessionStartPayload = typeof SessionStartPayload.Type

export const SubagentPayload = Schema.Struct({
  ...HookBase.fields,
  agent_id: Schema.optional(Schema.String),
  agent_type: Schema.optional(Schema.String),
  agent_transcript_path: Schema.optional(Schema.String),
  stop_hook_active: Schema.optional(Schema.Boolean),
})
export type SubagentPayload = typeof SubagentPayload.Type

export const StopPayload = Schema.Struct({
  ...HookBase.fields,
  stop_hook_active: Schema.optional(Schema.Boolean),
})
export type StopPayload = typeof StopPayload.Type

export const SessionEndPayload = Schema.Struct({
  ...HookBase.fields,
  reason: Schema.optional(Schema.String),
})
export type SessionEndPayload = typeof SessionEndPayload.Type

/** AskUserQuestion's tool_input. */
export const AskUserQuestionInput = Schema.Struct({
  questions: Schema.Array(
    Schema.Struct({
      question: Schema.String,
      header: Schema.optional(Schema.String),
      options: Schema.Array(
        Schema.Struct({ label: Schema.String, description: Schema.optional(Schema.String) }),
      ),
      multiSelect: Schema.optional(Schema.Boolean),
    }),
  ),
})
export type AskUserQuestionInput = typeof AskUserQuestionInput.Type

/**
 * Process facts the hook captures from its own environment, which the payload
 * does not carry (e.g. CLAUDE_CODE_ENTRYPOINT=claude-desktop).
 */
export const HookEnv = Schema.Struct({
  entrypoint: Schema.NullOr(Schema.String),
  hostSessionId: Schema.NullOr(Schema.String),
  claudePid: Schema.NullOr(Schema.Number),
})
export type HookEnv = typeof HookEnv.Type

/** POST /v1/hooks/:event body. */
export const HookEnvelope = Schema.Struct({
  event: Schema.String,
  payload: Schema.Unknown,
  env: HookEnv,
  sentAt: Schema.Number,
})
export type HookEnvelope = typeof HookEnvelope.Type

/** POST /v1/hooks/:event response. `requestId` present ⇒ the hook should long-poll. */
export const HookIngestResponse = Schema.Struct({
  seq: Schema.Number,
  requestId: Schema.NullOr(Schema.String),
})
export type HookIngestResponse = typeof HookIngestResponse.Type

/** GET /v1/hooks/decision/:requestId?wait=<s> response. */
export const HookDecision = Schema.Struct({
  decision: Schema.Literals(["allow", "deny", "ask", "pending"]),
  reason: Schema.optional(Schema.String),
  /** For AskUserQuestion answered from the inbox: the tool_input with `answers` filled. */
  updatedInput: Schema.optional(Schema.Unknown),
})
export type HookDecision = typeof HookDecision.Type

/**
 * Decode `raw` with `schema`, keeping every field the schema doesn't declare.
 * Throws a SchemaError (Effect 4) when declared fields are missing or mistyped.
 */
export const decodeHookPayload = <S extends Schema.Codec<object, unknown>>(
  schema: S,
  raw: unknown,
): S["Type"] & Record<string, unknown> => {
  const typed = Schema.decodeUnknownSync(schema as never)(raw) as object
  return { ...(raw as object), ...typed } as S["Type"] & Record<string, unknown>
}
