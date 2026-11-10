/**
 * Settings pane (U-026): its own Model / Message / update / commands, lifted into the
 * app as one Model field and one Message (`GotSettingsMessage`). The daemon validates,
 * clamps and applies every change; the pane shows what the daemon answered.
 */
import { Dialog } from "@foldkit/ui"
import {
  HOLDABLE_TOOLS,
  type HoldableTool,
  SettingsResponse,
  type UserSettingKey,
  UserSettings,
  UserSettingsPatch,
} from "@session-inbox/contracts"
import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { DaemonClient } from "./client/daemonClient.ts"

// FIELDS
//
// The pane renders from this list. A new boolean setting is one entry here (plus the
// key in contracts' UserSettings); a new group is one entry in SETTINGS_GROUPS.

export type SettingsGroupId = "approvals" | "notifications" | "sessions" | "updates"
export type FieldKind = "toggle" | "seconds" | "tools" | "list"

export type SettingsField = Readonly<{
  key: UserSettingKey
  group: SettingsGroupId
  kind: FieldKind
  label: string
  help: string
  /** Disabled while `holds.enabled` is off. */
  needsHolds?: boolean
}>

export const SETTINGS_GROUPS: ReadonlyArray<Readonly<{ id: SettingsGroupId; title: string }>> = [
  { id: "approvals", title: "Approvals" },
  { id: "notifications", title: "Notifications" },
  { id: "sessions", title: "Sessions" },
  { id: "updates", title: "Updates" },
]

export const SETTINGS_FIELDS: ReadonlyArray<SettingsField> = [
  {
    key: "holds.enabled",
    group: "approvals",
    kind: "toggle",
    label: "Hold tool calls for approval in the inbox",
    help: "When off, the inbox only observes and notifies; Claude asks in its own window.",
  },
  {
    key: "holds.tools",
    group: "approvals",
    kind: "tools",
    label: "Tools that can be held",
    help: "Only when Claude itself would ask. Questions (AskUserQuestion) always come to the inbox.",
    needsHolds: true,
  },
  {
    key: "holds.budgetMs",
    group: "approvals",
    kind: "seconds",
    label: "Wait for an answer",
    help: "Then Claude shows its own prompt. 15 to 120 seconds.",
    needsHolds: true,
  },
  {
    key: "holds.safeBashPrefixes",
    group: "approvals",
    kind: "list",
    label: "Bash commands never held",
    help: "A command matches when it is the prefix or starts with it plus a space.",
    needsHolds: true,
  },
  {
    key: "notifications.fallback",
    group: "notifications",
    kind: "toggle",
    label: "Notify even when the menu-bar app isn't running",
    help: "Posts a plain macOS notification instead.",
  },
  {
    key: "notifications.reviewGroupMs",
    group: "notifications",
    kind: "seconds",
    label: "Group finished sessions",
    help: "Sessions that finish within this window share one notification. 0 to 600 seconds.",
  },
  {
    key: "titles.generate",
    group: "sessions",
    kind: "toggle",
    label: "Generate short session titles",
    help: "Runs claude -p with Haiku once per session.",
  },
  {
    key: "updates.check",
    group: "updates",
    kind: "toggle",
    label: "Check for new versions",
    help: "Asks GitHub for the latest release every few hours. Nothing else leaves this Mac.",
  },
  {
    key: "updates.auto",
    group: "updates",
    kind: "toggle",
    label: "Install updates automatically",
    help: "Only while no tool call is held and nothing is being sent. Otherwise you get an Update now button.",
  },
]

export const fieldFor = (key: string): SettingsField | undefined =>
  SETTINGS_FIELDS.find((f) => f.key === key)

/** Status key for "Reset all to defaults". */
export const RESET_ALL = "*"

// MODEL

export const FieldStatus = defineTaggedUnion({
  Idle: {},
  Saving: {},
  Saved: {},
  Failed: { error: Schema.String },
})
export type FieldStatus = typeof FieldStatus.Type

export const Loaded = Schema.Struct({
  /** The daemon's last answer. */
  saved: SettingsResponse,
  /** What the controls show: `saved`, plus changes still in flight. */
  shown: UserSettings,
})
export type Loaded = typeof Loaded.Type

export const SettingsLoad = defineTaggedUnion({
  Idle: {},
  Loading: {},
  Loaded: { loaded: Loaded },
  Failed: { error: Schema.String },
})
export type SettingsLoad = typeof SettingsLoad.Type

export const SettingsModel = Schema.Struct({
  dialog: Dialog.Model,
  load: SettingsLoad,
  /** Text typed into seconds fields and the add-command field, by setting key. */
  drafts: Schema.Record(Schema.String, Schema.String),
  status: Schema.Record(Schema.String, FieldStatus),
  unmuting: Schema.Array(Schema.String),
})
export type SettingsModel = typeof SettingsModel.Type

export const initSettings = (): SettingsModel => ({
  dialog: Dialog.init({ id: "settings-dialog" }),
  load: SettingsLoad.Idle(),
  drafts: {},
  status: {},
  unmuting: [],
})

// MESSAGE

export const SettingsMessage = defineMessageUnion({
  RequestedOpen: {},
  GotDialogMessage: { message: Dialog.Message },
  SucceededFetchSettings: { response: SettingsResponse },
  FailedFetchSettings: { error: Schema.String },
  ToggledSetting: { key: Schema.String, value: Schema.Boolean },
  ToggledTool: { tool: Schema.String, isChecked: Schema.Boolean },
  UpdatedDraft: { key: Schema.String, value: Schema.String },
  CommittedDraft: { key: Schema.String },
  RemovedListEntry: { key: Schema.String, value: Schema.String },
  ClickedReset: { key: Schema.String },
  ClickedResetAll: {},
  SucceededSaveSettings: { key: Schema.String, response: SettingsResponse },
  FailedSaveSettings: { key: Schema.String, error: Schema.String },
  ClickedUnmute: { projectId: Schema.String },
  CompletedUnmute: { projectId: Schema.String, error: Schema.NullOr(Schema.String) },
})
export type SettingsMessage = typeof SettingsMessage.Type

// COMMAND

const describe = (error: unknown): string =>
  error !== null && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error)

export const FetchSettings = Command.define("FetchSettings", {
  messages: [SettingsMessage.SucceededFetchSettings, SettingsMessage.FailedFetchSettings],
  execute: Effect.gen(function* () {
    const client = yield* DaemonClient
    const response = yield* client.getSettings
    return SettingsMessage.SucceededFetchSettings({ response })
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(SettingsMessage.FailedFetchSettings({ error: describe(error) })),
    ),
  ),
})

export const SaveSettings = Command.define("SaveSettings", {
  args: { key: Schema.String, patch: UserSettingsPatch },
  messages: [SettingsMessage.SucceededSaveSettings, SettingsMessage.FailedSaveSettings],
  execute: ({ key, patch }) =>
    Effect.gen(function* () {
      const client = yield* DaemonClient
      const response = yield* client.putSettings(patch)
      return SettingsMessage.SucceededSaveSettings({ key, response })
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(SettingsMessage.FailedSaveSettings({ key, error: describe(error) })),
      ),
    ),
})

export const UnmuteProject = Command.define("UnmuteProject", {
  args: { projectId: Schema.String },
  messages: [SettingsMessage.CompletedUnmute],
  execute: ({ projectId }) =>
    Effect.gen(function* () {
      const client = yield* DaemonClient
      yield* client.mute(projectId, { muted: false })
      return SettingsMessage.CompletedUnmute({ projectId, error: null })
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(SettingsMessage.CompletedUnmute({ projectId, error: describe(error) })),
      ),
    ),
})

// HELPERS

/** 120000 → "120", 1500 → "1.5". */
export const msToSeconds = (ms: number): string => String(Math.round(ms / 100) / 10)

export const parseSeconds = (text: string): number | null => {
  const t = text.trim()
  if (t === "" || !/^\d+(\.\d+)?$/.test(t)) {
    return null
  }
  return Math.round(Number(t) * 1000)
}

export const isDefault = (loaded: Loaded, key: UserSettingKey): boolean =>
  JSON.stringify(loaded.shown[key]) === JSON.stringify(loaded.saved.defaults[key])

const withoutKey = <V>(record: Readonly<Record<string, V>>, key: string) =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))

// UPDATE

type SettingsReturn = Update.Return<SettingsModel, SettingsMessage, DaemonClient>
type SettingsCommands = NonNullable<SettingsReturn["commands"]>

const liftDialog = (
  model: SettingsModel,
  result: Readonly<{
    model: Dialog.Model
    commands?: ReadonlyArray<Command.Command<Dialog.Message>>
  }>,
): { model: SettingsModel; commands: SettingsCommands } => ({
  model: { ...model, dialog: result.model },
  commands: Command.mapMessages(result.commands, (message) =>
    SettingsMessage.GotDialogMessage({ message }),
  ),
})

const loadedOf = (model: SettingsModel): Loaded | null =>
  model.load._tag === "Loaded" ? model.load.loaded : null

const withLoaded = (model: SettingsModel, loaded: Loaded): SettingsModel => ({
  ...model,
  load: SettingsLoad.Loaded({ loaded }),
})

/** Show `value` now, send `{ key: value }`; the daemon's answer replaces it either way. */
const save = <K extends UserSettingKey>(
  model: SettingsModel,
  key: K,
  value: UserSettings[K],
): SettingsReturn => {
  const loaded = loadedOf(model)
  if (loaded === null) {
    return { model }
  }
  const next = withLoaded(model, { ...loaded, shown: { ...loaded.shown, [key]: value } })
  return {
    model: { ...next, status: { ...next.status, [key]: FieldStatus.Saving() } },
    commands: [SaveSettings({ key, patch: { [key]: value } })],
  }
}

const fail = (model: SettingsModel, key: string, error: string): SettingsReturn => ({
  model: { ...model, status: { ...model.status, [key]: FieldStatus.Failed({ error }) } },
})

const commitDraft = (model: SettingsModel, key: string): SettingsReturn => {
  const loaded = loadedOf(model)
  const field = fieldFor(key)
  const draft = model.drafts[key]
  if (loaded === null || field === undefined || draft === undefined) {
    return { model }
  }
  const cleared = { ...model, drafts: withoutKey(model.drafts, key) }
  if (field.kind === "seconds") {
    const ms = parseSeconds(draft)
    if (ms === null) {
      return fail(cleared, key, "Enter a number of seconds.")
    }
    return ms === loaded.shown[field.key]
      ? { model: cleared }
      : save(cleared, field.key, ms as never)
  }
  if (field.kind === "list") {
    const entry = draft.trim()
    const list = loaded.shown[field.key] as ReadonlyArray<string>
    if (entry === "" || list.includes(entry)) {
      return { model: cleared }
    }
    return save(cleared, field.key, [...list, entry] as never)
  }
  return { model: cleared }
}

/** Keys still being saved keep what the user just did; everything else takes the daemon's word. */
const merge = (model: SettingsModel, response: SettingsResponse, settledKey: string): Loaded => {
  const loaded = loadedOf(model)
  const shown: Record<string, unknown> = { ...response.settings }
  if (loaded !== null) {
    for (const [key, status] of Object.entries(model.status)) {
      if (key !== settledKey && status._tag === "Saving" && key in loaded.shown) {
        shown[key] = loaded.shown[key as UserSettingKey]
      }
    }
  }
  return { saved: response, shown: shown as UserSettings }
}

export const updateSettings = (model: SettingsModel, message: SettingsMessage): SettingsReturn =>
  SettingsMessage.match<SettingsReturn>(message, {
    RequestedOpen: () => {
      const opened = liftDialog(model, Dialog.open(model.dialog))
      return {
        model: {
          ...opened.model,
          load: model.load._tag === "Loaded" ? model.load : SettingsLoad.Loading(),
          drafts: {},
          status: {},
        },
        commands: [...opened.commands, FetchSettings()],
      }
    },

    GotDialogMessage: ({ message: dialogMessage }) =>
      liftDialog(model, Dialog.update(model.dialog, dialogMessage)),

    SucceededFetchSettings: ({ response }) => ({
      model: withLoaded(model, { saved: response, shown: response.settings }),
    }),

    FailedFetchSettings: ({ error }) =>
      model.load._tag === "Loaded"
        ? { model }
        : { model: { ...model, load: SettingsLoad.Failed({ error }) } },

    ToggledSetting: ({ key, value }) =>
      fieldFor(key)?.kind === "toggle"
        ? save(model, key as UserSettingKey, value as never)
        : { model },

    ToggledTool: ({ tool, isChecked }) => {
      const loaded = loadedOf(model)
      if (loaded === null) {
        return { model }
      }
      const current = new Set<string>(loaded.shown["holds.tools"])
      if (isChecked) {
        current.add(tool)
      } else {
        current.delete(tool)
      }
      const tools = HOLDABLE_TOOLS.filter((t): t is HoldableTool => current.has(t))
      return save(model, "holds.tools", tools)
    },

    UpdatedDraft: ({ key, value }) => ({
      model: {
        ...model,
        drafts: { ...model.drafts, [key]: value },
        status: withoutKey(model.status, key),
      },
    }),

    CommittedDraft: ({ key }) => commitDraft(model, key),

    RemovedListEntry: ({ key, value }) => {
      const loaded = loadedOf(model)
      const field = fieldFor(key)
      if (loaded === null || field?.kind !== "list") {
        return { model }
      }
      const list = loaded.shown[field.key] as ReadonlyArray<string>
      return save(model, field.key, list.filter((v) => v !== value) as never)
    },

    ClickedReset: ({ key }) => {
      const loaded = loadedOf(model)
      const field = fieldFor(key)
      if (loaded === null || field === undefined) {
        return { model }
      }
      const next = withLoaded(model, {
        ...loaded,
        shown: { ...loaded.shown, [field.key]: loaded.saved.defaults[field.key] },
      })
      return {
        model: {
          ...next,
          drafts: withoutKey(next.drafts, key),
          status: { ...next.status, [key]: FieldStatus.Saving() },
        },
        commands: [SaveSettings({ key, patch: { [field.key]: null } })],
      }
    },

    ClickedResetAll: () => {
      const loaded = loadedOf(model)
      if (loaded === null) {
        return { model }
      }
      const patch = Object.fromEntries(SETTINGS_FIELDS.map((f) => [f.key, null]))
      return {
        model: {
          ...withLoaded(model, { ...loaded, shown: loaded.saved.defaults }),
          drafts: {},
          status: { [RESET_ALL]: FieldStatus.Saving() },
        },
        commands: [SaveSettings({ key: RESET_ALL, patch })],
      }
    },

    SucceededSaveSettings: ({ key, response }) => ({
      model: {
        ...withLoaded(model, merge(model, response, key)),
        status: { ...model.status, [key]: FieldStatus.Saved() },
      },
    }),

    FailedSaveSettings: ({ key, error }) => {
      const loaded = loadedOf(model)
      if (loaded === null) {
        return { model }
      }
      // Put the control back to what the daemon last said.
      const keys = key === RESET_ALL ? SETTINGS_FIELDS.map((f) => f.key) : [key as UserSettingKey]
      const shown: Record<string, unknown> = { ...loaded.shown }
      for (const k of keys) {
        shown[k] = loaded.saved.settings[k]
      }
      return {
        model: {
          ...withLoaded(model, { ...loaded, shown: shown as UserSettings }),
          status: { ...model.status, [key]: FieldStatus.Failed({ error }) },
        },
      }
    },

    ClickedUnmute: ({ projectId }) =>
      model.unmuting.includes(projectId)
        ? { model }
        : {
            model: { ...model, unmuting: [...model.unmuting, projectId] },
            commands: [UnmuteProject({ projectId })],
          },

    CompletedUnmute: ({ projectId, error }) => {
      const next = { ...model, unmuting: model.unmuting.filter((id) => id !== projectId) }
      return error === null ? { model: next } : fail(next, `mute:${projectId}`, error)
    },
  })
