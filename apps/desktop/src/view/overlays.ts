import { Dialog } from "@foldkit/ui"
import type { Snapshot } from "@session-inbox/contracts"
import { Option } from "effect"
import { childAttributes, type Html, type HtmlBuilder } from "foldkit/html"
import { Message } from "../message.ts"
import type { Model } from "../model.ts"
import { findProject, needsYouCountForProject } from "../selectors.ts"
import { Toast } from "../toast.ts"
import { SessionCombobox } from "../update.ts"
import { Icon, kbd } from "./parts.ts"

type H = HtmlBuilder<Message>

const sessionLabel = (
  snapshot: Snapshot,
  sessionId: string,
): { title: string; project: string } => {
  const session = snapshot.sessions.find((s) => s.id === sessionId)
  const project = session === undefined ? Option.none() : findProject(snapshot, session.projectId)
  return {
    title: session?.title ?? "Untitled session",
    project: Option.getOrElse(
      Option.map(project, (p) => p.name),
      () => "",
    ),
  }
}

/** Sessions matching the typed text; sessions with items that need you first. */
const matchingSessions = (snapshot: Snapshot, query: string): ReadonlyArray<string> => {
  const q = query.trim().toLowerCase()
  const needsYou = new Set(
    snapshot.items.filter((i) => i.queue === "needs-you").map((i) => i.sessionId),
  )
  return snapshot.sessions
    .filter((s) => s.state !== "ended")
    .filter((s) => {
      const label = sessionLabel(snapshot, s.id)
      return q === "" || `${label.title} ${label.project}`.toLowerCase().includes(q)
    })
    .sort((a, b) => Number(needsYou.has(b.id)) - Number(needsYou.has(a.id)))
    .map((s) => s.id)
}

const jumpCombobox = (model: Model, snapshot: Snapshot, h: H): Html =>
  h.submodel({
    slotId: model.jumpCombobox.id,
    model: model.jumpCombobox,
    view: SessionCombobox.view,
    viewInputs: {
      items: matchingSessions(snapshot, model.jumpCombobox.inputValue),
      restingInputValue: "",
      maybeSelectedValue: Option.none(),
      itemToValue: (id) => id,
      itemToDisplayText: (id) => sessionLabel(snapshot, id).title,
      itemToConfig: (id) => {
        const label = sessionLabel(snapshot, id)
        const session = snapshot.sessions.find((s) => s.id === id)
        const needs =
          session === undefined ? 0 : needsYouCountForProject(snapshot, session.projectId)
        return {
          className:
            "flex min-h-8 cursor-pointer items-center gap-2 px-3 py-1.5 text-[13px] data-[active]:bg-working-tint data-[active]:shadow-[inset_3px_0_0_var(--working)]",
          content: h.div(
            [h.Class("flex w-full items-center gap-2")],
            [
              h.span([h.Class("flex-1 truncate font-medium")], [label.title]),
              h.span([h.Class("text-xs text-subtle-foreground")], [label.project]),
              needs > 0 && snapshot.items.some((i) => i.sessionId === id && i.queue === "needs-you")
                ? h.span([h.Class("text-xs font-semibold text-needs")], ["needs you"])
                : h.empty,
            ],
          ),
        }
      },
      inputAttributes: childAttributes([
        h.Class("input h-9 w-full text-[14px]"),
        h.Placeholder("Search sessions and projects"),
        h.Autofocus(true),
      ]),
      itemsAttributes: childAttributes([
        h.Class(
          "z-50 max-h-80 w-(--input-width) overflow-auto rounded-lg border border-border bg-popover py-1 shadow-lg outline-none",
        ),
      ]),
      anchor: { placement: "bottom-start", gap: 4, padding: 8 },
      attributes: childAttributes([h.Class("relative w-full")]),
    },
    toParentMessage: (message) => Message.GotJumpComboboxMessage({ message }),
  })

export const jumpDialogView = (model: Model, h: H): Html =>
  h.submodel({
    slotId: model.jumpDialog.id,
    model: model.jumpDialog,
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
                      "relative mt-[12vh] w-[min(560px,92vw)] rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-2xl",
                    ),
                  ],
                  [
                    h.div(
                      [h.Class("mb-3 flex items-center gap-2")],
                      [
                        Icon.search(h),
                        h.h2(
                          [...title, h.Class("flex-1 text-[14px] font-semibold")],
                          ["Jump to session"],
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
                    Option.match(model.maybeSnapshot, {
                      onNone: () =>
                        h.p([h.Class("text-[13px] text-muted-foreground")], ["Loading sessions…"]),
                      onSome: (snapshot) => jumpCombobox(model, snapshot, h),
                    }),
                  ],
                ),
              ]
            : [],
        ),
    },
    toParentMessage: (message) => Message.GotJumpDialogMessage({ message }),
  })

/** Every shortcut, as the `?` dialog lists them (U-073). */
export const SHORTCUTS: ReadonlyArray<Readonly<{ keys: ReadonlyArray<string>; does: string }>> = [
  { keys: ["⌘K"], does: "Jump to a session" },
  { keys: ["⌘↵"], does: "Main action: Allow once, Send answers or Send reply" },
  { keys: ["⌘⌫"], does: "Deny" },
  { keys: ["j", "k"], does: "Next / previous item in the list" },
  { keys: ["e"], does: "Done: clear a review or failed item" },
  { keys: ["⌘,"], does: "Settings" },
  { keys: ["↑", "↓"], does: "Move in the session tree" },
  { keys: ["?"], does: "This list" },
]

const shortcutList = (h: H): Html =>
  h.dl(
    [h.Class("m-0 grid grid-cols-[max-content_1fr] items-center gap-x-4 gap-y-2.5")],
    SHORTCUTS.flatMap(({ keys, does }) => [
      h.dt(
        [h.Class("flex items-center gap-1")],
        keys.flatMap((key, i) => [
          i === 0 ? h.empty : h.span([h.Class("text-xs text-subtle-foreground")], ["/"]),
          h.kbd(
            [
              h.Class(
                "inline-flex min-w-6 justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-[12px] font-medium",
              ),
            ],
            [key],
          ),
        ]),
      ),
      h.dd([h.Class("m-0 text-[13px]")], [does]),
    ]),
  )

export const shortcutsDialogView = (model: Model, h: H): Html =>
  h.submodel({
    slotId: model.shortcutsDialog.id,
    model: model.shortcutsDialog,
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
                      "relative mt-[12vh] w-[min(460px,92vw)] rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-2xl",
                    ),
                  ],
                  [
                    h.div(
                      [h.Class("mb-3 flex items-center gap-2")],
                      [
                        Icon.keyboard(h),
                        h.h2(
                          [...title, h.Class("flex-1 text-[14px] font-semibold")],
                          ["Keyboard shortcuts"],
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
                    shortcutList(h),
                    h.p(
                      [h.Class("mt-3 text-xs text-subtle-foreground")],
                      ["Letter keys do nothing while you type in a field."],
                    ),
                  ],
                ),
              ]
            : [],
        ),
    },
    toParentMessage: (message) => Message.GotShortcutsDialogMessage({ message }),
  })

const toastVariantClass: Record<string, string> = {
  Success: "border-ready/40",
  Error: "border-failed/50",
  Info: "border-border",
  Warning: "border-needs/50",
}

export const toastsView = (model: Model, h: H): Html =>
  h.submodel({
    slotId: model.toasts.id,
    model: model.toasts,
    view: Toast.view,
    viewInputs: {
      position: "BottomRight",
      entryClassName: "w-80",
      entryToView: (entry, handlers) =>
        h.div(
          [
            h.Class(
              `relative rounded-lg border bg-popover p-3 pr-9 text-popover-foreground shadow-md ${toastVariantClass[entry.variant] ?? ""}`,
            ),
          ],
          [
            h.p([h.Class("text-[13px] font-semibold")], [entry.payload.title]),
            h.p([h.Class("mt-0.5 text-[13px] text-muted-foreground")], [entry.payload.description]),
            h.button(
              [
                ...handlers.dismiss,
                h.Type("button"),
                h.AriaLabel("Dismiss"),
                h.Class(
                  "absolute top-2 right-2 cursor-pointer rounded p-1 text-subtle-foreground hover:text-foreground",
                ),
              ],
              ["×"],
            ),
          ],
        ),
    },
    toParentMessage: (message) => Message.GotToastMessage({ message }),
  })
