import type { Document, HtmlBuilder } from "foldkit/html"
import type { Message } from "../message.ts"
import type { Model } from "../model.ts"
import { compactView } from "./compact.ts"
import { detailView } from "./detail.ts"
import { historyView } from "./history.ts"
import { headerView, navView } from "./nav.ts"
import { jumpDialogView, shortcutsDialogView, toastsView } from "./overlays.ts"
import { queueView } from "./queue.ts"
import { settingsDialogView } from "./settings.ts"
import { setupView } from "./setup.ts"
import { updateBannerView } from "./update.ts"

// VIEW

const title = (model: Model): string => {
  const needs = model.maybeSnapshot._tag === "Some" ? model.maybeSnapshot.value.counts.needsYou : 0
  return needs > 0 ? `(${needs}) Session Inbox` : "Session Inbox"
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: title(model),
  body:
    model.view === "compact"
      ? h.div([], [compactView(model, h), toastsView(model, h)])
      : h.div(
          [h.Class("flex h-screen flex-col bg-background text-foreground")],
          [
            headerView(model, h),
            updateBannerView(model, h),
            h.div(
              [h.Class("shell min-h-0 flex-1")],
              model.route === "setup"
                ? [navView(model, h), setupView(model, h)]
                : model.route === "history"
                  ? [navView(model, h), historyView(model, h), detailView(model, h)]
                  : [navView(model, h), queueView(model, h), detailView(model, h)],
            ),
            jumpDialogView(model, h),
            shortcutsDialogView(model, h),
            settingsDialogView(model, h),
            toastsView(model, h),
          ],
        ),
})
