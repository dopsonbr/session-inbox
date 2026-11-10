/**
 * Settings pane (U-026): its own Model / Message / update / commands, lifted into the
 * app as one Model field and one Message (`GotSettingsMessage`). The daemon validates,
 * clamps and applies every change; the pane shows what the daemon answered.
 */
import { Dialog } from "@foldkit/ui"
import {
  HOLDABLE_TOOLS,
  type HoldableTool,
  SETTING_LIMITS,
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
import type { ExtraNumberSetting } from "./client/extraSettings.ts"

// FIELDS
//
// The pane renders from this list. A new boolean setting is one entry here (plus the
// key in contracts' UserSettings); a new group is one entry in SETTINGS_GROUPS.

export type SettingsGroupId = "approvals" | "notifications" | "sessions" | "storage" | "updates"
export type FieldKind = "toggle" | "seconds" | "minutes" | "days" | "tools" | "list" | "choice"

/** A contracts key, or a number setting a newer daemon may report (U-036). */
export type SettingKey = UserSettingKey | ExtraNumberSetting

export type SettingsField = Readonly<{
  key: SettingKey
  group: SettingsGroupId
  kind: FieldKind
  label: string
  help: string
  /** Disabled while `holds.enabled` is off. */
  needsHolds?: boolean
  /** `choice` fields: the values the daemon accepts, in order, with their labels. */
  options?: ReadonlyArray<Readonly<{ value: string; label: string }>>
  /** Shown only when this holds for what the controls show (U-044). */
  showWhen?: (shown: Readonly<Record<string, unknown>>) => boolean
  /** Disabled, with `disabledNote` under it, when this holds (U-044). */
  disabledWhen?: (shown: Readonly<Record<string, unknown>>) => boolean
  disabledNote?: string
}>

/** The inbox answers Claude's own prompt: the PreToolUse hold settings don't apply (D-074). */
const answersPrompt = (shown: Readonly<Record<string, unknown>>) =>
  shown["holds.via"] === "permissionRequest"
const NOT_USED_IN_PROMPT_MODE = "Not used while the inbox answers Claude's own prompt."

export const SETTINGS_GROUPS: ReadonlyArray<Readonly<{ id: SettingsGroupId; title: string }>> = [
  { id: "approvals", title: "Approvals" },
  { id: "notifications", title: "Notifications" },
  { id: "sessions", title: "Sessions" },
  { id: "storage", title: "Storage" },
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
    key: "holds.via",
    group: "approvals",
    kind: "choice",
    label: "How approvals reach the inbox",
    help: "Recommended: Claude's prompt stays visible in Claude and the inbox answers it; whichever is answered first wins, for every tool Claude asks about. Classic: the inbox holds Bash, edits and web fetches for up to two minutes before Claude shows its own prompt.",
    needsHolds: true,
    options: [
      { value: "permissionRequest", label: "Answer Claude's own prompt (recommended)" },
      { value: "preToolUse", label: "Hold the tool call before Claude asks (classic)" },
    ],
  },
  {
    key: "holds.requestBudgetMs",
    group: "approvals",
    kind: "minutes",
    label: "Wait for an answer",
    help: `Then the inbox stops answering and Claude's prompt stays open in Claude. ${SETTING_LIMITS["holds.requestBudgetMs"].min / 60_000} to ${SETTING_LIMITS["holds.requestBudgetMs"].max / 60_000} minutes.`,
    needsHolds: true,
    showWhen: answersPrompt,
  },
  {
    key: "holds.tools",
    group: "approvals",
    kind: "tools",
    label: "Tools that can be held",
    help: "Only when Claude itself would ask. Questions (AskUserQuestion) always come to the inbox.",
    needsHolds: true,
    disabledWhen: answersPrompt,
    disabledNote: NOT_USED_IN_PROMPT_MODE,
  },
  {
    key: "holds.budgetMs",
    group: "approvals",
    kind: "seconds",
    label: "Wait for an answer",
    help: "Then Claude shows its own prompt. 15 to 120 seconds.",
    needsHolds: true,
    disabledWhen: answersPrompt,
    disabledNote: NOT_USED_IN_PROMPT_MODE,
  },
  {
    key: "holds.safeBashPrefixes",
    group: "approvals",
    kind: "list",
    label: "Bash commands never held",
    help: "A command matches when it is the prefix or starts with it plus a space.",
    needsHolds: true,
    disabledWhen: answersPrompt,
    disabledNote: NOT_USED_IN_PROMPT_MODE,
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
    // Shown only when the daemon reports it (U-036).
    key: "storage.retentionDays",
    group: "storage",
    kind: "days",
    label: "Keep history for",
    help: "Finished items, sessions and their events older than this are deleted. 1 to 365 days.",
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
    help: "Only while nothing is waiting on you, nothing is being sent and sessions have been quiet for 30 seconds. Until then you get an Update now button.",
  },
]

export const fieldFor = (key: string): SettingsField | undefined =>
  SETTINGS_FIELDS.find((f) => f.key === key)

/** A setting's value by key, including keys newer than these contracts. */
export const settingValue = (settings: UserSettings, key: string): unknown =>
  (settings as Readonly<Record<string, unknown>>)[key]

/** Fields this daemon reports; one it doesn't know (an older daemon) isn't shown or sent. */
export const presentFields = (response: SettingsResponse): ReadonlyArray<SettingsField> =>
  SETTINGS_FIELDS.filter((f) => settingValue(response.settings, f.key) !== undefined)

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

/**
 * UserSettings plus whatever else the daemon reported (U-036). Message constructors validate
 * against their schema and drop unknown keys, so the plain contract would lose a newer key
 * (`storage.retentionDays`) between the HTTP client and the pane.
 */
export const OpenSettings = Schema.StructWithRest(UserSettings, [
  Schema.Record(Schema.String, Schema.Unknown),
])
export const OpenSettingsResponse = Schema.Struct({
  ...SettingsResponse.fields,
  settings: OpenSettings,
  defaults: OpenSettings,
})

export const Loaded = Schema.Struct({
  /** The daemon's last answer. */
  saved: OpenSettingsResponse,
  /** What the controls show: `saved`, plus changes still in flight. */
  shown: OpenSettings,
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
  /** The latest save sent per key; an answer to an older one is stale and ignored (U-050). */
  saveSeq: Schema.Record(Schema.String, Schema.Number),
  unmuting: Schema.Array(Schema.String),
})
export type SettingsModel = typeof SettingsModel.Type

export const initSettings = (): SettingsModel => ({
  dialog: Dialog.init({ id: "settings-dialog" }),
  load: SettingsLoad.Idle(),
  drafts: {},
  status: {},
  saveSeq: {},
  unmuting: [],
})

// MESSAGE

export const SettingsMessage = defineMessageUnion({
  RequestedOpen: {},
  /** Closed from outside the dialog (e.g. its "Setup check" link navigated away). */
  RequestedClose: {},
  GotDialogMessage: { message: Dialog.Message },
  SucceededFetchSettings: { response: OpenSettingsResponse },
  FailedFetchSettings: { error: Schema.String },
  ToggledSetting: { key: Schema.String, value: Schema.Boolean },
  ChoseSetting: { key: Schema.String, value: Schema.String },
  ToggledTool: { tool: Schema.String, isChecked: Schema.Boolean },
  UpdatedDraft: { key: Schema.String, value: Schema.String },
  CommittedDraft: { key: Schema.String },
  RemovedListEntry: { key: Schema.String, value: Schema.String },
  ClickedReset: { key: Schema.String },
  ClickedResetAll: {},
  SucceededSaveSettings: {
    key: Schema.String,
    seq: Schema.Number,
    response: OpenSettingsResponse,
  },
  FailedSaveSettings: { key: Schema.String, seq: Schema.Number, error: Schema.String },
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
  args: { key: Schema.String, seq: Schema.Number, patch: UserSettingsPatch },
  messages: [SettingsMessage.SucceededSaveSettings, SettingsMessage.FailedSaveSettings],
  execute: ({ key, seq, patch }) =>
    Effect.gen(function* () {
      const client = yield* DaemonClient
      const response = yield* client.putSettings(patch)
      return SettingsMessage.SucceededSaveSettings({ key, seq, response })
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(SettingsMessage.FailedSaveSettings({ key, seq, error: describe(error) })),
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

/** 600000 → "10", 90000 → "1.5". */
export const msToMinutes = (ms: number): string => String(Math.round(ms / 6_000) / 10)

/** Minutes as typed ("10", "1.5") → ms; anything else → null. The daemon clamps the range. */
export const parseMinutes = (text: string): number | null => {
  const t = text.trim()
  if (t === "" || !/^\d+(\.\d+)?$/.test(t)) {
    return null
  }
  return Math.round(Number(t) * 60_000)
}

/** Whole days, as typed: "30" → 30; anything else → null. The daemon clamps the range. */
export const parseDays = (text: string): number | null => {
  const t = text.trim()
  return /^\d{1,4}$/.test(t) ? Number(t) : null
}

export const isDefault = (loaded: Loaded, key: string): boolean =>
  JSON.stringify(settingValue(loaded.shown, key)) ===
  JSON.stringify(settingValue(loaded.saved.defaults, key))

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

/** Number this save of `key` and mark it Saving; returns the model and the command. */
const sendSave = (model: SettingsModel, key: string, patch: UserSettingsPatch): SettingsReturn => {
  const seq = (model.saveSeq[key] ?? 0) + 1
  return {
    model: {
      ...model,
      status: { ...model.status, [key]: FieldStatus.Saving() },
      saveSeq: { ...model.saveSeq, [key]: seq },
    },
    commands: [SaveSettings({ key, seq, patch })],
  }
}

/** An answer to a save of `key` older than the latest one sent: ignore it (U-050). */
const isStale = (model: SettingsModel, key: string, seq: number): boolean =>
  seq < (model.saveSeq[key] ?? 0)

/** Show `value` now, send `{ key: value }`; the daemon's answer replaces it either way. */
const save = (model: SettingsModel, key: SettingKey, value: unknown): SettingsReturn => {
  const loaded = loadedOf(model)
  if (loaded === null) {
    return { model }
  }
  const next = withLoaded(model, {
    ...loaded,
    shown: { ...loaded.shown, [key]: value } as UserSettings,
  })
  return sendSave(next, key, { [key]: value } as UserSettingsPatch)
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
  // A blur while the dialog closes (Esc) must not save what was being typed.
  if (!model.dialog.isOpen) {
    return { model: cleared }
  }
  const shown = settingValue(loaded.shown, field.key)
  if (field.kind === "seconds" || field.kind === "minutes" || field.kind === "days") {
    const value =
      field.kind === "seconds"
        ? parseSeconds(draft)
        : field.kind === "minutes"
          ? parseMinutes(draft)
          : parseDays(draft)
    if (value === null) {
      return fail(
        cleared,
        key,
        field.kind === "seconds"
          ? "Enter a number of seconds."
          : field.kind === "minutes"
            ? "Enter a number of minutes."
            : "Enter a whole number of days.",
      )
    }
    return value === shown ? { model: cleared } : save(cleared, field.key, value)
  }
  if (field.kind === "list") {
    const entry = draft.trim()
    const list = shown as ReadonlyArray<string>
    if (entry === "" || list.includes(entry)) {
      return { model: cleared }
    }
    return save(cleared, field.key, [...list, entry])
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
        shown[key] = settingValue(loaded.shown, key)
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

    GotDialogMessage: ({ message: dialogMessage }) => {
      const next = liftDialog(model, Dialog.update(model.dialog, dialogMessage))
      // Closing (Esc, backdrop, Close) discards text that was typed but not committed.
      return next.model.dialog.isOpen ? next : { ...next, model: { ...next.model, drafts: {} } }
    },

    RequestedClose: () =>
      model.dialog.isOpen
        ? (() => {
            const next = liftDialog(model, Dialog.close(model.dialog))
            return { ...next, model: { ...next.model, drafts: {} } }
          })()
        : { model },

    SucceededFetchSettings: ({ response }) => ({
      model: withLoaded(model, { saved: response, shown: response.settings }),
    }),

    FailedFetchSettings: ({ error }) =>
      model.load._tag === "Loaded"
        ? { model }
        : { model: { ...model, load: SettingsLoad.Failed({ error }) } },

    ToggledSetting: ({ key, value }) =>
      fieldFor(key)?.kind === "toggle" ? save(model, key as SettingKey, value) : { model },

    ChoseSetting: ({ key, value }) => {
      const field = fieldFor(key)
      const loaded = loadedOf(model)
      if (
        field?.kind !== "choice" ||
        loaded === null ||
        !field.options?.some((o) => o.value === value) ||
        settingValue(loaded.shown, key) === value
      ) {
        return { model }
      }
      return save(model, field.key, value)
    },

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
      const list = settingValue(loaded.shown, field.key) as ReadonlyArray<string>
      return save(
        model,
        field.key,
        list.filter((v) => v !== value),
      )
    },

    ClickedReset: ({ key }) => {
      const loaded = loadedOf(model)
      const field = fieldFor(key)
      if (loaded === null || field === undefined) {
        return { model }
      }
      const next = withLoaded(model, {
        ...loaded,
        shown: {
          ...loaded.shown,
          [field.key]: settingValue(loaded.saved.defaults, field.key),
        } as UserSettings,
      })
      return sendSave({ ...next, drafts: withoutKey(next.drafts, key) }, key, {
        [field.key]: null,
      } as UserSettingsPatch)
    },

    ClickedResetAll: () => {
      const loaded = loadedOf(model)
      if (loaded === null) {
        return { model }
      }
      // Only keys this daemon knows: an unknown key would fail the whole PUT.
      const patch = Object.fromEntries(
        presentFields(loaded.saved).map((f) => [f.key, null]),
      ) as UserSettingsPatch
      return sendSave(
        {
          ...withLoaded(model, { ...loaded, shown: loaded.saved.defaults }),
          drafts: {},
          status: {},
        },
        RESET_ALL,
        patch,
      )
    },

    SucceededSaveSettings: ({ key, seq, response }) =>
      isStale(model, key, seq)
        ? { model }
        : {
            model: {
              ...withLoaded(model, merge(model, response, key)),
              status: { ...model.status, [key]: FieldStatus.Saved() },
            },
          },

    FailedSaveSettings: ({ key, seq, error }) => {
      const loaded = loadedOf(model)
      if (loaded === null || isStale(model, key, seq)) {
        return { model }
      }
      // Put the control back to what the daemon last said.
      const keys =
        key === RESET_ALL ? presentFields(loaded.saved).map((f) => f.key) : [key as SettingKey]
      const shown: Record<string, unknown> = { ...loaded.shown }
      for (const k of keys) {
        shown[k] = settingValue(loaded.saved.settings, k)
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
