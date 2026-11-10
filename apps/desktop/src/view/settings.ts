import { Checkbox, Dialog } from "@foldkit/ui"
import { HOLDABLE_TOOLS, type Project } from "@session-inbox/contracts"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "../message.ts"
import type { Model } from "../model.ts"
import {
  isDefault,
  type Loaded,
  msToMinutes,
  msToSeconds,
  presentFields,
  RESET_ALL,
  SETTINGS_GROUPS,
  type SettingsField,
  type SettingsGroupId,
  SettingsMessage,
  type SettingsModel,
  settingValue,
} from "../settings.ts"
import { Icon, kbd } from "./parts.ts"
import { attentionLabel } from "./setup.ts"

// SETTINGS DIALOG (U-026): renders SETTINGS_FIELDS; every control saves on its own.

type H = HtmlBuilder<Message>

const send = (message: SettingsMessage): Message => Message.GotSettingsMessage({ message })

const idFor = (key: string) => `setting-${key.replaceAll(".", "-")}`

const formatValue = (field: SettingsField, value: unknown): string => {
  if (field.kind === "toggle") {
    return value === true ? "on" : "off"
  }
  if (field.kind === "seconds") {
    return `${msToSeconds(value as number)} s`
  }
  if (field.kind === "minutes") {
    return `${msToMinutes(value as number)} min`
  }
  if (field.kind === "days") {
    return value === 1 ? "1 day" : `${String(value)} days`
  }
  if (field.kind === "choice") {
    return field.options?.find((o) => o.value === value)?.label ?? String(value)
  }
  const list = value as ReadonlyArray<string>
  return list.length === 0 ? "none" : list.join(", ")
}

const statusLine = (settings: SettingsModel, key: string, h: H): Html => {
  const status = settings.status[key]
  if (status === undefined || status._tag === "Idle") {
    return h.empty
  }
  if (status._tag === "Saving") {
    return h.p([h.Class("text-xs text-subtle-foreground"), h.AriaLive("polite")], ["Saving…"])
  }
  if (status._tag === "Saved") {
    return h.p(
      [h.Class("flex items-center gap-1 text-xs text-ready"), h.AriaLive("polite")],
      [Icon.check(h, "size-3"), "Saved"],
    )
  }
  return h.p([h.Class("text-xs text-failed"), h.Role("alert")], [status.error])
}

/** Help text, plus the default and a Reset when the value differs from it. */
const helpLine = (loaded: Loaded, field: SettingsField, h: H): Html =>
  h.p(
    [h.Id(`${idFor(field.key)}-help`), h.Class("text-xs text-subtle-foreground")],
    [
      field.help,
      isDefault(loaded, field.key)
        ? h.empty
        : h.span(
            [],
            [
              ` Default: ${formatValue(field, settingValue(loaded.saved.defaults, field.key))}. `,
              h.button(
                [
                  h.Type("button"),
                  h.Class("cursor-pointer font-medium text-foreground underline"),
                  h.AriaLabel(`Reset ${field.label} to its default`),
                  h.OnClick(send(SettingsMessage.ClickedReset({ key: field.key }))),
                ],
                ["Reset"],
              ),
            ],
          ),
    ],
  )

const checkBox = (h: H, isChecked: boolean): Html =>
  h.span(
    [
      h.AriaHidden(true),
      h.Class(
        `mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded border ${isChecked ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card"}`,
      ),
    ],
    [isChecked ? Icon.check(h, "size-3") : h.empty],
  )

const toggleRow = (loaded: Loaded, field: SettingsField, isDisabled: boolean, h: H): Html => {
  const isChecked = settingValue(loaded.shown, field.key) === true
  return Checkbox.view(
    {
      id: idFor(field.key),
      isChecked,
      isDisabled,
      hasDescription: true,
      onToggle: (value) => send(SettingsMessage.ToggledSetting({ key: field.key, value })),
      toView: ({ checkbox, label, description }) =>
        h.div(
          [
            ...checkbox,
            h.Class(
              "flex cursor-pointer items-start gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
            ),
          ],
          [
            checkBox(h, isChecked),
            h.div(
              [h.Class("flex flex-col gap-0.5")],
              [
                h.span([...label, h.Class("text-[13px] font-medium")], [field.label]),
                h.span([...description, h.Class("text-xs text-subtle-foreground")], [field.help]),
              ],
            ),
          ],
        ),
    },
    h,
  )
}

const fieldLabel = (field: SettingsField, forId: string, h: H): Html =>
  h.label([h.For(forId), h.Class("text-[13px] font-medium")], [field.label])

const enterCommits = (key: string, h: H) =>
  h.OnKeyDownPreventDefault((pressed) =>
    pressed === "Enter"
      ? Option.some(send(SettingsMessage.CommittedDraft({ key })))
      : Option.none(),
  )

/** Seconds (stored as ms) or whole days: "Wait for an answer [45] seconds". */
const numberRow = (
  settings: SettingsModel,
  loaded: Loaded,
  field: SettingsField,
  isDisabled: boolean,
  h: H,
): Html => {
  const id = idFor(field.key)
  const draft = settings.drafts[field.key]
  const current = settingValue(loaded.shown, field.key) as number
  const value =
    draft ??
    (field.kind === "seconds"
      ? msToSeconds(current)
      : field.kind === "minutes"
        ? msToMinutes(current)
        : String(current))
  const failed = settings.status[field.key]?._tag === "Failed"
  const unit =
    field.kind === "seconds"
      ? "seconds"
      : field.kind === "minutes"
        ? "minutes"
        : current === 1 && draft === undefined
          ? "day"
          : "days"
  return h.div(
    [h.Class("flex flex-col gap-1")],
    [
      fieldLabel(field, id, h),
      h.div(
        [h.Class("flex items-center gap-2")],
        [
          h.input([
            h.Id(id),
            h.Type("text"),
            h.InputMode(field.kind === "days" ? "numeric" : "decimal"),
            h.Class("input h-8 w-24 text-[13px]"),
            h.Value(value),
            h.Disabled(isDisabled),
            h.AriaInvalid(failed),
            h.AriaDescribedBy(`${id}-help`),
            h.OnInput((text) =>
              send(SettingsMessage.UpdatedDraft({ key: field.key, value: text })),
            ),
            h.OnBlur(send(SettingsMessage.CommittedDraft({ key: field.key }))),
            enterCommits(field.key, h),
          ]),
          h.span([h.Class("text-[13px] text-muted-foreground")], [unit]),
        ],
      ),
      helpLine(loaded, field, h),
    ],
  )
}

const toolsRow = (loaded: Loaded, field: SettingsField, isDisabled: boolean, h: H): Html => {
  const tools = loaded.shown["holds.tools"]
  return h.fieldset(
    [
      h.Class("m-0 flex flex-col gap-1.5 border-none p-0"),
      h.AriaDescribedBy(`${idFor(field.key)}-help`),
    ],
    [
      h.legend([h.Class("mb-1 text-[13px] font-medium")], [field.label]),
      h.div(
        [h.Class("flex flex-wrap gap-2")],
        HOLDABLE_TOOLS.map((tool) => {
          const isChecked = tools.includes(tool)
          return Checkbox.view(
            {
              id: `${idFor(field.key)}-${tool}`,
              isChecked,
              isDisabled,
              onToggle: (checked) =>
                send(SettingsMessage.ToggledTool({ tool, isChecked: checked })),
              toView: ({ checkbox, label }) =>
                h.div(
                  [
                    ...checkbox,
                    h.Class("choice data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"),
                  ],
                  [
                    h.span(
                      [
                        h.AriaHidden(true),
                        h.Class(
                          "inline-flex size-4 items-center justify-center rounded border border-current",
                        ),
                      ],
                      [isChecked ? Icon.check(h, "size-3") : h.empty],
                    ),
                    h.span([...label], [tool]),
                  ],
                ),
            },
            h,
          )
        }),
      ),
      helpLine(loaded, field, h),
    ],
  )
}

const listRow = (
  settings: SettingsModel,
  loaded: Loaded,
  field: SettingsField,
  isDisabled: boolean,
  h: H,
): Html => {
  const id = idFor(field.key)
  const list = settingValue(loaded.shown, field.key) as ReadonlyArray<string>
  return h.div(
    [h.Class("flex flex-col gap-1.5")],
    [
      h.span([h.Id(`${id}-label`), h.Class("text-[13px] font-medium")], [field.label]),
      h.ul(
        [h.AriaLabelledBy(`${id}-label`), h.Class("m-0 flex list-none flex-wrap gap-1.5 p-0")],
        list.map((entry) =>
          h.li(
            [
              h.Class(
                "inline-flex h-7 items-center gap-1 rounded-md border border-border bg-muted pr-1 pl-2 font-mono text-xs",
              ),
            ],
            [
              entry,
              h.button(
                [
                  h.Type("button"),
                  h.Disabled(isDisabled),
                  h.AriaLabel(`Remove ${entry}`),
                  h.Class(
                    "cursor-pointer rounded px-1 text-subtle-foreground hover:text-foreground disabled:cursor-not-allowed",
                  ),
                  h.OnClick(
                    send(SettingsMessage.RemovedListEntry({ key: field.key, value: entry })),
                  ),
                ],
                ["×"],
              ),
            ],
          ),
        ),
      ),
      h.div(
        [h.Class("flex items-center gap-2")],
        [
          h.label([h.For(`${id}-add`), h.Class("sr-only")], ["Add a command"]),
          h.input([
            h.Id(`${id}-add`),
            h.Type("text"),
            h.Class("input h-8 w-56 font-mono text-xs"),
            h.Placeholder("e.g. npm test"),
            h.Value(settings.drafts[field.key] ?? ""),
            h.Disabled(isDisabled),
            h.AriaDescribedBy(`${id}-help`),
            h.OnInput((text) =>
              send(SettingsMessage.UpdatedDraft({ key: field.key, value: text })),
            ),
            h.OnBlur(send(SettingsMessage.CommittedDraft({ key: field.key }))),
            enterCommits(field.key, h),
          ]),
          h.button(
            [
              h.Type("button"),
              h.Class("btn"),
              h.DataAttribute("variant", "outline"),
              h.DataAttribute("size", "sm"),
              h.Disabled(isDisabled),
              h.OnClick(send(SettingsMessage.CommittedDraft({ key: field.key }))),
            ],
            ["Add"],
          ),
        ],
      ),
      helpLine(loaded, field, h),
    ],
  )
}

/** One of a few named values, as native radio buttons (keyboard and screen readers for free). */
const choiceRow = (loaded: Loaded, field: SettingsField, isDisabled: boolean, h: H): Html => {
  const id = idFor(field.key)
  const current = settingValue(loaded.shown, field.key)
  return h.fieldset(
    [h.Class("m-0 flex flex-col gap-1.5 border-none p-0"), h.AriaDescribedBy(`${id}-help`)],
    [
      h.legend([h.Class("mb-1 text-[13px] font-medium")], [field.label]),
      ...(field.options ?? []).map((option) =>
        h.label(
          [
            h.For(`${id}-${option.value}`),
            h.Class(
              `flex items-center gap-2 text-[13px] ${isDisabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`,
            ),
          ],
          [
            h.input([
              h.Id(`${id}-${option.value}`),
              h.Type("radio"),
              h.Name(id),
              h.Value(option.value),
              h.Checked(current === option.value),
              h.Disabled(isDisabled),
              h.OnChange(() =>
                send(SettingsMessage.ChoseSetting({ key: field.key, value: option.value })),
              ),
            ]),
            option.label,
          ],
        ),
      ),
      helpLine(loaded, field, h),
    ],
  )
}

/** H-016: a second install on this Mac may hold too. Shown only when one exists. */
const holdsCaveat = (loaded: Loaded, h: H): Html =>
  loaded.saved.otherChannel === null
    ? h.empty
    : h.p(
        [h.Class("rounded-md bg-needs-tint px-2.5 py-1.5 text-xs text-needs")],
        [
          `The ${loaded.saved.otherChannel} install is also on this Mac. Only one install should hold calls: `,
          "if both do, each waits for its own answer. Turn this off in one of them.",
        ],
      )

const fieldRow = (settings: SettingsModel, loaded: Loaded, field: SettingsField, h: H): Html => {
  const shown = loaded.shown as Readonly<Record<string, unknown>>
  const isUnused = field.disabledWhen?.(shown) === true
  const isDisabled =
    isUnused || (field.needsHolds === true && loaded.shown["holds.enabled"] !== true)
  const control = (() => {
    switch (field.kind) {
      case "toggle":
        return toggleRow(loaded, field, isDisabled, h)
      case "seconds":
      case "minutes":
      case "days":
        return numberRow(settings, loaded, field, isDisabled, h)
      case "tools":
        return toolsRow(loaded, field, isDisabled, h)
      case "list":
        return listRow(settings, loaded, field, isDisabled, h)
      case "choice":
        return choiceRow(loaded, field, isDisabled, h)
    }
  })()
  return h.div(
    [h.Class("flex flex-col gap-1")],
    [
      control,
      field.kind === "toggle" && !isDefault(loaded, field.key)
        ? helpLineForToggle(loaded, field, h)
        : h.empty,
      field.key === "holds.enabled" ? holdsCaveat(loaded, h) : h.empty,
      isUnused && field.disabledNote
        ? h.p([h.Class("text-xs text-subtle-foreground")], [field.disabledNote])
        : h.empty,
      statusLine(settings, field.key, h),
    ],
  )
}

/** A toggle's help is its description; only the default + Reset go underneath. */
const helpLineForToggle = (loaded: Loaded, field: SettingsField, h: H): Html =>
  h.p(
    [h.Class("pl-6.5 text-xs text-subtle-foreground")],
    [
      `Default: ${formatValue(field, settingValue(loaded.saved.defaults, field.key))}. `,
      h.button(
        [
          h.Type("button"),
          h.Class("cursor-pointer font-medium text-foreground underline"),
          h.AriaLabel(`Reset ${field.label} to its default`),
          h.OnClick(send(SettingsMessage.ClickedReset({ key: field.key }))),
        ],
        ["Reset"],
      ),
    ],
  )

const mutedProjects = (model: Model, h: H): Html => {
  const muted: ReadonlyArray<Project> = Option.match(model.maybeSnapshot, {
    onNone: () => [],
    onSome: (s) => s.projects.filter((p) => p.muted),
  })
  return h.div(
    [h.Class("flex flex-col gap-1.5")],
    [
      h.span(
        [h.Id("muted-projects-label"), h.Class("text-[13px] font-medium")],
        ["Muted projects"],
      ),
      muted.length === 0
        ? h.p(
            [h.Class("text-xs text-subtle-foreground")],
            [
              "None. Mute a project from an item's snooze menu to stop its holds and notifications.",
            ],
          )
        : h.ul(
            [
              h.AriaLabelledBy("muted-projects-label"),
              h.Class("m-0 flex list-none flex-col gap-1 p-0"),
            ],
            muted.map((project) =>
              h.li(
                [h.Class("flex flex-col gap-0.5")],
                [
                  h.div(
                    [h.Class("flex items-center gap-2")],
                    [
                      h.span([h.Class("flex-1 truncate text-[13px]")], [project.name]),
                      h.button(
                        [
                          h.Type("button"),
                          h.Class("btn"),
                          h.DataAttribute("variant", "outline"),
                          h.DataAttribute("size", "sm"),
                          h.Disabled(model.settings.unmuting.includes(project.id)),
                          h.AriaLabel(`Unmute ${project.name}`),
                          h.OnClick(send(SettingsMessage.ClickedUnmute({ projectId: project.id }))),
                        ],
                        ["Unmute"],
                      ),
                    ],
                  ),
                  statusLine(model.settings, `mute:${project.id}`, h),
                ],
              ),
            ),
          ),
    ],
  )
}

const groupSection = (
  model: Model,
  loaded: Loaded,
  group: SettingsGroupId,
  title: string,
  h: H,
): Html => {
  const fields = presentFields(loaded.saved).filter(
    (f) =>
      f.group === group &&
      (f.showWhen === undefined || f.showWhen(loaded.shown as Readonly<Record<string, unknown>>)),
  )
  // A group whose only settings this daemon doesn't have (Storage on an older one) is hidden.
  if (fields.length === 0 && group !== "sessions") {
    return h.empty
  }
  return h.section(
    [h.AriaLabelledBy(`settings-group-${group}`), h.Class("flex flex-col gap-3.5")],
    [
      h.h3(
        [
          h.Id(`settings-group-${group}`),
          h.Class("text-xs font-semibold tracking-wide text-subtle-foreground uppercase"),
        ],
        [title],
      ),
      ...fields.map((f) => fieldRow(model.settings, loaded, f, h)),
      group === "sessions" ? mutedProjects(model, h) : h.empty,
    ],
  )
}

/** Footer link to the Setup panel (U-034); navigating closes the dialog. */
const setupLink = (model: Model, h: H): Html =>
  model.doctor._tag === "Unknown" || model.doctor._tag === "Unavailable"
    ? h.empty
    : h.a(
        [
          h.Href("#/setup"),
          h.Class(
            "ml-auto inline-flex items-center gap-1 rounded text-[13px] text-foreground underline-offset-2 hover:underline",
          ),
        ],
        [
          "Setup check",
          model.doctor._tag === "Loaded" && model.doctor.report.attention > 0
            ? h.span(
                [h.Class("text-xs font-semibold text-needs")],
                [` · ${attentionLabel(model.doctor.report.attention)}`],
              )
            : h.empty,
        ],
      )

export const settingsBody = (model: Model, h: H): Html => {
  const load = model.settings.load
  if (load._tag === "Loaded") {
    const loaded = load.loaded
    const allDefault = presentFields(loaded.saved).every((f) => isDefault(loaded, f.key))
    return h.div(
      [h.Class("flex flex-col gap-6")],
      [
        ...SETTINGS_GROUPS.map((g) => groupSection(model, loaded, g.id, g.title, h)),
        h.div(
          [h.Class("flex items-center gap-3 border-t border-border pt-3")],
          [
            h.button(
              [
                h.Type("button"),
                h.Class("btn"),
                h.DataAttribute("variant", "outline"),
                h.DataAttribute("size", "sm"),
                h.Disabled(allDefault),
                h.OnClick(send(SettingsMessage.ClickedResetAll())),
              ],
              ["Reset all to defaults"],
            ),
            statusLine(model.settings, RESET_ALL, h),
            setupLink(model, h),
          ],
        ),
      ],
    )
  }
  if (load._tag === "Failed") {
    return h.div(
      [h.Class("flex flex-col gap-3")],
      [
        h.p([h.Class("text-[13px] text-failed"), h.Role("alert")], [load.error]),
        setupLink(model, h),
      ],
    )
  }
  return h.p([h.Class("text-[13px] text-muted-foreground")], ["Loading settings…"])
}

const channelLabel = (model: Model): string =>
  model.settings.load._tag === "Loaded" ? ` · ${model.settings.load.loaded.saved.channel}` : ""

export const settingsDialogView = (model: Model, h: H): Html =>
  h.submodel({
    slotId: model.settings.dialog.id,
    model: model.settings.dialog,
    view: Dialog.view,
    viewInputs: {
      toView: ({ dialog, backdrop, panel, title, closeButton, isVisible }) =>
        h.dialog(
          [
            ...dialog,
            h.Class(
              "m-0 h-full max-h-none w-full max-w-none bg-transparent p-0 open:flex items-start justify-center",
            ),
          ],
          isVisible
            ? [
                h.div([...backdrop, h.Class("fixed inset-0 bg-black/40")]),
                h.div(
                  [
                    ...panel,
                    h.Class(
                      "relative mt-[8vh] flex max-h-[84vh] w-[min(600px,94vw)] flex-col rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl",
                    ),
                  ],
                  [
                    h.div(
                      [h.Class("flex items-center gap-2 border-b border-border px-5 py-3")],
                      [
                        h.h2(
                          [...title, h.Class("flex-1 text-[14px] font-semibold")],
                          [`Settings${channelLabel(model)}`],
                        ),
                        h.button(
                          [
                            ...closeButton,
                            h.Type("button"),
                            h.Class("btn"),
                            h.DataAttribute("variant", "ghost"),
                            h.DataAttribute("size", "sm"),
                          ],
                          ["Close", kbd(h, "esc")],
                        ),
                      ],
                    ),
                    h.div([h.Class("overflow-y-auto px-5 py-4")], [settingsBody(model, h)]),
                  ],
                ),
              ]
            : [],
        ),
    },
    toParentMessage: (message) => send(SettingsMessage.GotDialogMessage({ message })),
  })
