import type { UpdateStatus } from "@session-inbox/contracts"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "../message.ts"
import type { Model } from "../model.ts"
import { updateBannerKey } from "../update.ts"
import { Icon } from "./parts.ts"

type H = HtmlBuilder<Message>

// UPDATES (U-022..U-024). Renders the daemon's UpdateStatus; every decision
// (whether it's available, whether it installs by itself) is the daemon's.

const SOURCE_HINT = "git pull && bun scripts/install.ts --yes --app"
const CLI_HINT = "session-inbox update"

const PROGRESS: Record<string, string> = {
  downloading: "Downloading",
  verifying: "Verifying",
  installing: "Installing",
  done: "Restarting",
}

/** The status the banner should show, if any (dismissed per page load). */
const visibleBanner = (model: Model): Option.Option<UpdateStatus> =>
  Option.filter(
    model.maybeUpdate,
    (s) =>
      (s.state === "available" || s.state === "updating" || s.state === "failed") &&
      !Option.contains(model.maybeDismissedUpdate, updateBannerKey(s)),
  )

const versionOf = (s: UpdateStatus) => s.latest ?? s.target ?? "A new version"

const code = (h: H, text: string): Html =>
  h.code([h.Class("rounded bg-code px-1 py-0.5 font-mono text-[12px]")], [text])

const updateButton = (model: Model, h: H, label: string): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class("btn"),
      h.DataAttribute("size", "sm"),
      h.Disabled(model.updateRequest === "Applying"),
      h.OnClick(Message.ClickedUpdateNow()),
    ],
    [model.updateRequest === "Applying" ? "Starting…" : label],
  )

const notesLink = (h: H, s: UpdateStatus): ReadonlyArray<Html> =>
  s.notesUrl === null
    ? []
    : [
        h.a(
          [
            h.Href(s.notesUrl),
            h.Target("_blank"),
            h.Rel("noopener noreferrer"),
            h.Class(
              "inline-flex items-center gap-1 text-[13px] text-foreground underline-offset-2 hover:underline",
            ),
          ],
          ["Release notes", Icon.external(h, "size-3")],
        ),
      ]

const dismissButton = (h: H): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class("btn"),
      h.DataAttribute("variant", "ghost"),
      h.DataAttribute("size", "sm"),
      h.OnClick(Message.DismissedUpdateBanner()),
    ],
    ["Not now"],
  )

const bannerContent = (
  model: Model,
  h: H,
  s: UpdateStatus,
): { tone: string; text: ReadonlyArray<Html | string>; actions: ReadonlyArray<Html> } => {
  const v = versionOf(s)
  if (s.state === "updating") {
    const step = s.progress === null ? "" : ` · ${PROGRESS[s.progress] ?? s.progress}`
    return {
      tone: "bg-working-tint text-working",
      text: [h.strong([h.Class("font-semibold")], [`Updating to ${v}…`]), step],
      actions: [],
    }
  }
  if (s.state === "failed") {
    return {
      tone: "bg-failed-tint text-failed",
      text: [
        h.strong([h.Class("font-semibold")], [`Couldn't update to ${v}.`]),
        ` ${s.error ?? "The update failed."} You can also run `,
        code(h, CLI_HINT),
        " in a terminal.",
      ],
      actions: [updateButton(model, h, "Try again"), ...notesLink(h, s), dismissButton(h)],
    }
  }
  if (s.source === "source") {
    return {
      tone: "bg-working-tint text-foreground",
      text: [
        h.strong([h.Class("font-semibold")], [`Session Inbox ${v} is available.`]),
        " This copy was installed from source; update it with ",
        code(h, SOURCE_HINT),
        ".",
      ],
      actions: [updateButton(model, h, "Update anyway"), ...notesLink(h, s), dismissButton(h)],
    }
  }
  return {
    tone: "bg-working-tint text-foreground",
    text: [
      h.strong([h.Class("font-semibold")], [`Session Inbox ${v} is available.`]),
      s.auto ? " It installs by itself when no session is waiting." : "",
    ],
    actions: [updateButton(model, h, "Update now"), ...notesLink(h, s), dismissButton(h)],
  }
}

/** Slim banner under the header of the main window. */
export const updateBannerView = (model: Model, h: H): Html | null =>
  Option.match(visibleBanner(model), {
    onNone: () => null,
    onSome: (s) => {
      const { tone, text, actions } = bannerContent(model, h, s)
      return h.div(
        [
          h.Role(s.state === "failed" ? "alert" : "status"),
          h.Class(
            `flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-5 py-2 text-[13px] ${tone}`,
          ),
        ],
        [
          h.p([h.Class("m-0 min-w-0 flex-1")], text),
          ...(actions.length === 0 ? [] : [h.div([h.Class("flex items-center gap-2")], actions)]),
        ],
      )
    },
  })

/** One-line row for the menu-bar popover. */
export const compactUpdateRowView = (model: Model, h: H): Html | null =>
  Option.match(visibleBanner(model), {
    onNone: () => null,
    onSome: (s) => {
      const v = versionOf(s)
      const label =
        s.state === "updating"
          ? `Updating to ${v}…`
          : s.state === "failed"
            ? `Couldn't update to ${v}`
            : `Session Inbox ${v} is available`
      const tone =
        s.state === "failed" ? "bg-failed-tint text-failed" : "bg-working-tint text-foreground"
      return h.div(
        [
          h.Role(s.state === "failed" ? "alert" : "status"),
          h.Class(`flex items-center gap-2 border-b border-border px-3.5 py-2 text-[13px] ${tone}`),
        ],
        [
          h.span([h.Class("min-w-0 flex-1 truncate"), h.Title(s.error ?? label)], [label]),
          ...(s.state === "updating"
            ? []
            : [
                updateButton(
                  model,
                  h,
                  s.state === "failed"
                    ? "Retry"
                    : s.source === "source"
                      ? "Update anyway"
                      : "Update",
                ),
              ]),
        ],
      )
    },
  })

/** `v0.1.0 · 8ef7cf8` plus "Check for updates" when this install can update. */
export const versionView = (model: Model, h: H): Html | null => {
  const label = Option.match(model.maybeUpdate, {
    onSome: (s) => Option.some(`v${s.current} · ${s.build}`),
    onNone: () => Option.map(model.maybeDaemonBuild, (key) => `v${key.replace("·", " · ")}`),
  })
  if (Option.isNone(label)) {
    return null
  }
  const canCheck = Option.exists(model.maybeUpdate, (s) => s.state !== "unsupported")
  const isChecking =
    model.updateRequest === "Checking" ||
    Option.exists(model.maybeUpdate, (s) => s.state === "checking")
  return h.div(
    [h.Class("flex items-center gap-2 text-xs text-subtle-foreground")],
    [
      h.span([h.Class("font-mono tabular-nums")], [label.value]),
      ...(canCheck
        ? [
            h.button(
              [
                h.Type("button"),
                h.Class(
                  "cursor-pointer rounded px-1 text-xs text-subtle-foreground underline-offset-2 hover:text-foreground hover:underline disabled:cursor-default disabled:no-underline",
                ),
                h.Disabled(isChecking),
                h.OnClick(Message.ClickedCheckForUpdates()),
              ],
              [isChecking ? "Checking…" : "Check for updates"],
            ),
          ]
        : []),
    ],
  )
}
