import { describe, expect, test } from "bun:test"
import { Dialog } from "@foldkit/ui"
import type { SettingsResponse, UserSettingsPatch } from "@session-inbox/contracts"
import { Effect, Exit, Option } from "effect"
import { makeFakeClient } from "../src/client/fake.ts"
import { Message } from "../src/message.ts"
import type { Model } from "../src/model.ts"
import { RESET_ALL, SettingsMessage } from "../src/settings.ts"
import { initialModel, type UpdateReturn, update } from "../src/update.ts"

const NOW = 1_800_000_000_000
const client = () => makeFakeClient({ now: () => NOW, simulate: false, delayScale: 0 })
const response = (): SettingsResponse => Effect.runSync(client().getSettings)

const s = (message: SettingsMessage): Message => Message.GotSettingsMessage({ message })
const names = (ret: UpdateReturn) => (ret.commands ?? []).map((c) => c.name)
const saveArgs = (ret: UpdateReturn) => {
  const command = (ret.commands ?? []).find((c) => c.name === "SaveSettings") as unknown as
    | { args: { key: string; patch: UserSettingsPatch } }
    | undefined
  if (command === undefined) {
    throw new Error("expected SaveSettings")
  }
  return command.args
}
const run = (start: Model, ...messages: ReadonlyArray<Message>): UpdateReturn =>
  messages.reduce<UpdateReturn>((acc, m) => update(acc.model, m), { model: start })

const fresh = (): Model =>
  initialModel({ view: "full", now: NOW, maybeInitialItemId: Option.none() })

/** Opened, and the daemon's settings arrived. */
const opened = (): Model =>
  run(
    fresh(),
    s(SettingsMessage.RequestedOpen()),
    s(SettingsMessage.SucceededFetchSettings({ response: response() })),
  ).model

const loaded = (model: Model) => {
  if (model.settings.load._tag !== "Loaded") {
    throw new Error("not loaded")
  }
  return model.settings.load.loaded
}

describe("settings dialog", () => {
  test("⌘, / gear opens the dialog and fetches settings; close closes it", () => {
    const ret = update(fresh(), s(SettingsMessage.RequestedOpen()))
    expect(ret.model.settings.dialog.isOpen).toBe(true)
    expect(ret.model.settings.load._tag).toBe("Loading")
    expect(names(ret)).toContain("FetchSettings")
    const closed = update(
      ret.model,
      s(SettingsMessage.GotDialogMessage({ message: Dialog.Message.RequestedClose() })),
    )
    expect(closed.model.settings.dialog.isOpen).toBe(false)
  })

  test("a failed fetch shows the error", () => {
    const ret = run(
      fresh(),
      s(SettingsMessage.RequestedOpen()),
      s(SettingsMessage.FailedFetchSettings({ error: "daemon down" })),
    )
    expect(ret.model.settings.load).toEqual({ _tag: "Failed", error: "daemon down" })
  })
})

describe("settings: edit → save → saved / error", () => {
  test("a toggle sends only its key and shows Saved with the daemon's answer", () => {
    const ret = update(
      opened(),
      s(SettingsMessage.ToggledSetting({ key: "holds.enabled", value: false })),
    )
    expect(saveArgs(ret)).toEqual({ key: "holds.enabled", patch: { "holds.enabled": false } })
    expect(loaded(ret.model).shown["holds.enabled"]).toBe(false)
    expect(ret.model.settings.status["holds.enabled"]?._tag).toBe("Saving")

    const answer = { ...response(), settings: { ...response().settings, "holds.enabled": false } }
    const done = update(
      ret.model,
      s(SettingsMessage.SucceededSaveSettings({ key: "holds.enabled", response: answer })),
    )
    expect(done.model.settings.status["holds.enabled"]?._tag).toBe("Saved")
    expect(loaded(done.model).saved.settings["holds.enabled"]).toBe(false)
  })

  test("a failed save puts the control back to the daemon's value and shows the error", () => {
    const ret = run(
      opened(),
      s(SettingsMessage.ToggledTool({ tool: "Write", isChecked: false })),
      s(SettingsMessage.FailedSaveSettings({ key: "holds.tools", error: "boom" })),
    )
    expect(loaded(ret.model).shown["holds.tools"]).toContain("Write")
    expect(ret.model.settings.status["holds.tools"]).toEqual({ _tag: "Failed", error: "boom" })
  })

  test("tool toggles keep the canonical order", () => {
    const ret = run(opened(), s(SettingsMessage.ToggledTool({ tool: "Write", isChecked: false })))
    expect(saveArgs(ret).patch["holds.tools"]).toEqual([
      "Bash",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "WebFetch",
    ])
  })

  test("seconds save on commit (blur / Enter) in ms; bad input is an inline error, no request", () => {
    const ok = run(
      opened(),
      s(SettingsMessage.UpdatedDraft({ key: "holds.budgetMs", value: "45" })),
      s(SettingsMessage.CommittedDraft({ key: "holds.budgetMs" })),
    )
    expect(saveArgs(ok).patch).toEqual({ "holds.budgetMs": 45_000 })
    expect(ok.model.settings.drafts["holds.budgetMs"]).toBeUndefined()

    const bad = run(
      opened(),
      s(SettingsMessage.UpdatedDraft({ key: "holds.budgetMs", value: "soon" })),
      s(SettingsMessage.CommittedDraft({ key: "holds.budgetMs" })),
    )
    expect(names(bad)).toEqual([])
    expect(bad.model.settings.status["holds.budgetMs"]?._tag).toBe("Failed")
    expect(loaded(bad.model).shown["holds.budgetMs"]).toBe(120_000)

    const same = run(
      opened(),
      s(SettingsMessage.UpdatedDraft({ key: "holds.budgetMs", value: "120" })),
      s(SettingsMessage.CommittedDraft({ key: "holds.budgetMs" })),
    )
    expect(names(same)).toEqual([])
  })

  test("list: add on commit, remove by entry", () => {
    const added = run(
      opened(),
      s(SettingsMessage.UpdatedDraft({ key: "holds.safeBashPrefixes", value: " npm test " })),
      s(SettingsMessage.CommittedDraft({ key: "holds.safeBashPrefixes" })),
    )
    expect(saveArgs(added).patch["holds.safeBashPrefixes"]?.at(-1)).toBe("npm test")
    const removed = update(
      opened(),
      s(SettingsMessage.RemovedListEntry({ key: "holds.safeBashPrefixes", value: "ls" })),
    )
    expect(saveArgs(removed).patch["holds.safeBashPrefixes"]).not.toContain("ls")
  })

  test("reset sends null for that key; reset all sends null for every key", () => {
    const one = run(opened(), s(SettingsMessage.ClickedReset({ key: "titles.generate" })))
    expect(saveArgs(one).patch).toEqual({ "titles.generate": null })
    const all = run(opened(), s(SettingsMessage.ClickedResetAll()))
    expect(saveArgs(all).key).toBe(RESET_ALL)
    expect(Object.values(saveArgs(all).patch).every((v) => v === null)).toBe(true)
  })

  test("unmute sends the mute intent once", () => {
    const ret = run(
      opened(),
      s(SettingsMessage.ClickedUnmute({ projectId: "p-1" })),
      s(SettingsMessage.ClickedUnmute({ projectId: "p-1" })),
    )
    expect(names(ret)).toEqual([])
    expect(ret.model.settings.unmuting).toEqual(["p-1"])
    const first = update(opened(), s(SettingsMessage.ClickedUnmute({ projectId: "p-1" })))
    expect(names(first)).toEqual(["UnmuteProject"])
  })
})

describe("fake daemon settings", () => {
  test("clamps, resets with null, rejects unknown keys", () => {
    const c = client()
    const put = (patch: Record<string, unknown>) =>
      Effect.runSyncExit(c.putSettings(patch as UserSettingsPatch))
    const clamped = put({ "holds.budgetMs": 1 })
    expect(Exit.isSuccess(clamped) && clamped.value.settings["holds.budgetMs"]).toBe(15_000)
    const reset = put({ "holds.budgetMs": null })
    expect(Exit.isSuccess(reset) && reset.value.settings["holds.budgetMs"]).toBe(120_000)
    expect(Exit.isFailure(put({ "outbox.maxAttempts": 9 }))).toBe(true)
  })
})
