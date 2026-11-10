/**
 * Setup panel (`#/setup`, U-034): the daemon's DoctorReport rendered as given (C-021). The
 * daemon writes every word; the UI picks a glyph per status and turns each `fix` into a
 * link or a copy button.
 */
import type { DoctorCheck, DoctorFix, DoctorReport, DoctorStatus } from "@session-inbox/contracts"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "../message.ts"
import type { Model } from "../model.ts"
import { formatAgo } from "../selectors.ts"
import { Icon } from "./parts.ts"

type H = HtmlBuilder<Message>

export const attentionLabel = (n: number): string =>
  n === 1 ? "1 needs attention" : `${n} need attention`

const STATUS: Record<DoctorStatus, { word: string; tone: string; glyph: (h: H) => Html }> = {
  ok: { word: "OK", tone: "text-ready", glyph: (h) => Icon.check(h, "size-[14px]") },
  warn: { word: "Warning", tone: "text-needs", glyph: (h) => Icon.warn(h, "size-[14px]") },
  fail: { word: "Problem", tone: "text-failed", glyph: (h) => Icon.alert(h, "size-[14px]") },
  info: { word: "Info", tone: "text-subtle-foreground", glyph: (h) => Icon.info(h, "size-[14px]") },
}

/** Schemes a `url` fix may open; anything else is shown as text to copy instead. */
const LINK_SCHEMES = /^(https?:|mailto:|x-apple\.systempreferences:)/i
const isWebUrl = (url: string) => /^https?:/i.test(url)

const fixView = (model: Model, check: DoctorCheck, fix: DoctorFix, h: H): Html => {
  if (fix.kind === "url" && LINK_SCHEMES.test(fix.value)) {
    // A plain anchor: System Settings URLs open from the webview and from a browser alike;
    // only web pages get a new tab.
    return h.a(
      [
        h.Href(fix.value),
        ...(isWebUrl(fix.value) ? [h.Target("_blank"), h.Rel("noopener noreferrer")] : []),
        h.Class("btn self-start no-underline"),
        h.DataAttribute("variant", "outline"),
        h.DataAttribute("size", "sm"),
      ],
      [fix.label, Icon.external(h, "size-[12px]")],
    )
  }
  const isCopied = Option.contains(model.maybeCopiedFix, check.id)
  return h.div(
    [h.Class("flex min-w-0 flex-wrap items-center gap-2")],
    [
      h.code(
        [h.Class("min-w-0 rounded bg-code px-1.5 py-0.5 font-mono text-[12px] break-all")],
        [fix.value],
      ),
      h.button(
        [
          h.Type("button"),
          h.Class("btn"),
          h.DataAttribute("variant", "outline"),
          h.DataAttribute("size", "sm"),
          h.AriaLabel(isCopied ? `Copied: ${fix.value}` : `${fix.label}: ${fix.value}`),
          h.OnClick(Message.ClickedCopyFix({ checkId: check.id, value: fix.value })),
        ],
        isCopied
          ? [Icon.check(h, "size-[12px]"), "Copied"]
          : [Icon.copy(h, "size-[12px]"), fix.label],
      ),
    ],
  )
}

const checkRow = (model: Model, check: DoctorCheck, h: H): Html => {
  const status = STATUS[check.status]
  return h.keyed("li")(
    check.id,
    [h.Class("setup-check")],
    [
      h.span([h.Class(`mt-0.5 ${status.tone}`)], [status.glyph(h)]),
      h.div(
        [h.Class("flex min-w-0 flex-col gap-1")],
        [
          h.p(
            [h.Class("text-[14px] font-semibold text-foreground")],
            [h.span([h.Class("sr-only")], [`${status.word}: `]), check.title],
          ),
          h.p([h.Class("text-[13px] text-muted-foreground")], [check.detail]),
          check.fix === undefined ? h.empty : fixView(model, check, check.fix, h),
        ],
      ),
    ],
  )
}

const welcome = (h: H): Html =>
  h.section(
    [h.AriaLabelledBy("setup-welcome"), h.Class("rounded-xl bg-working-tint px-4 py-3.5")],
    [
      h.h2([h.Id("setup-welcome"), h.Class("text-[15px] font-semibold")], ["Welcome"]),
      h.p(
        [h.Class("mt-1 text-[13px] text-foreground")],
        [
          "Session Inbox collects what your Claude Code sessions need from you — questions, approvals, finished work — so you can answer without switching windows.",
        ],
      ),
      h.ol(
        [h.Class("mt-2 flex list-decimal flex-col gap-1 pl-5 text-[13px] text-foreground")],
        [
          h.li([], ["Allow notifications when macOS asks."]),
          h.li(
            [],
            ["Restart Claude sessions that were already open, so they load the inbox's hooks."],
          ),
          h.li(
            [],
            ["Try it: ask Claude for something that needs your approval, like running a command."],
          ),
        ],
      ),
    ],
  )

const summary = (report: DoctorReport, now: number, h: H): Html =>
  h.p(
    [h.Class("text-[13px] text-muted-foreground"), h.AriaLive("polite")],
    [
      report.attention > 0
        ? h.span([h.Class("font-semibold text-needs")], [attentionLabel(report.attention)])
        : h.span([h.Class("font-semibold text-ready")], ["Everything checks out"]),
      ` · checked ${formatAgo(now, report.generatedAt)}`,
    ],
  )

const toolbar = (model: Model, h: H): Html => {
  const canNotify = model.doctor._tag === "Loaded" || model.doctor._tag === "Failed"
  return h.div(
    [h.Class("flex flex-wrap items-center gap-2")],
    [
      h.button(
        [
          h.Type("button"),
          h.Class("btn"),
          h.DataAttribute("variant", "outline"),
          h.DataAttribute("size", "sm"),
          h.Disabled(model.isDoctorLoading || model.doctor._tag === "Unavailable"),
          h.OnClick(Message.ClickedRecheck()),
        ],
        [model.isDoctorLoading ? "Checking…" : "Re-check"],
      ),
      h.button(
        [
          h.Type("button"),
          h.Class("btn"),
          h.DataAttribute("variant", "outline"),
          h.DataAttribute("size", "sm"),
          h.Disabled(!canNotify || model.isTestNotifying),
          h.OnClick(Message.ClickedTestNotification()),
        ],
        [model.isTestNotifying ? "Sending…" : "Send test notification"],
      ),
    ],
  )
}

const body = (model: Model, h: H): ReadonlyArray<Html> => {
  const muted = (text: string) => h.p([h.Class("text-[13px] text-muted-foreground")], [text])
  switch (model.doctor._tag) {
    case "Unknown":
      return [muted("Running the setup check…")]
    case "Unavailable":
      return [muted("This daemon has no setup check. Update Session Inbox to get one.")]
    case "Failed":
      return [
        h.p(
          [h.Class("text-[13px] text-failed"), h.Role("alert")],
          [`Couldn't run the setup check: ${model.doctor.error}`],
        ),
      ]
    case "Loaded": {
      const { report, error } = model.doctor
      return [
        ...(report.firstRun ? [welcome(h)] : []),
        summary(report, model.now, h),
        error === null
          ? h.empty
          : h.p(
              [h.Class("text-[13px] text-failed"), h.Role("alert")],
              [`The last re-check failed: ${error}`],
            ),
        h.ul(
          [h.AriaLabel("Setup checks"), h.Class("m-0 flex list-none flex-col p-0")],
          report.checks.map((check) => checkRow(model, check, h)),
        ),
      ]
    }
  }
}

export const setupView = (model: Model, h: H): Html =>
  h.section(
    [
      h.AriaLabelledBy("setup-title"),
      h.Class("setup flex min-h-0 flex-col gap-4 overflow-y-auto bg-card px-6 pt-5 pb-6"),
    ],
    [
      h.div(
        [h.Class("flex flex-wrap items-start gap-3")],
        [
          h.div(
            [h.Class("min-w-60 flex-1")],
            [
              h.a(
                [
                  h.Href("#/"),
                  h.Class("text-[13px] text-muted-foreground underline-offset-2 hover:underline"),
                ],
                ["← Back to the inbox"],
              ),
              h.h1(
                [h.Id("setup-title"), h.Class("mt-1 text-[22px] font-bold tracking-tight")],
                ["Setup"],
              ),
            ],
          ),
          toolbar(model, h),
        ],
      ),
      ...body(model, h),
    ],
  )

/** A left-nav page link (Setup check, History); the current one reads as selected. */
export const navEntryClass = (isCurrent: boolean): string =>
  `mx-0 mt-2 flex min-h-8 items-center gap-2 rounded-lg border px-2 text-[13px] no-underline ${
    isCurrent
      ? "border-border bg-card font-semibold text-foreground"
      : "border-transparent text-muted-foreground hover:bg-accent"
  }`

/** The left-nav entry under "Where sessions run": hidden until the daemon has a report. */
export const setupNavEntry = (model: Model, h: H): Html => {
  if (model.doctor._tag === "Unknown" || model.doctor._tag === "Unavailable") {
    return h.empty
  }
  const attention = model.doctor._tag === "Loaded" ? model.doctor.report.attention : 0
  const isCurrent = model.route === "setup"
  return h.a(
    [
      h.Href("#/setup"),
      ...(isCurrent ? [h.AriaCurrent("page")] : []),
      h.Class(navEntryClass(isCurrent)),
    ],
    [
      Icon.wrench(h),
      h.span([h.Class("flex-1")], ["Setup check"]),
      attention > 0
        ? h.span(
            [
              h.Class(
                "inline-flex min-w-5 items-center justify-center rounded-full bg-needs-strong px-1.5 text-[11px] font-bold text-needs-strong-foreground",
              ),
              h.AriaLabel(attentionLabel(attention)),
            ],
            [String(attention)],
          )
        : h.empty,
    ],
  )
}

/** Popover row, only when something needs attention. */
export const compactSetupRowView = (model: Model, h: H): Html => {
  if (model.doctor._tag !== "Loaded" || model.doctor.report.attention === 0) {
    return h.empty
  }
  const attention = model.doctor.report.attention
  return h.a(
    [
      h.Href("/#/setup"),
      h.Class(
        "flex items-center gap-2 border-b border-border bg-needs-tint px-3.5 py-2 text-[13px] text-needs no-underline hover:underline focus-visible:underline",
      ),
    ],
    [
      Icon.warn(h),
      h.span(
        [h.Class("min-w-0 flex-1 truncate")],
        [`Setup: ${attention === 1 ? "1 check needs" : `${attention} checks need`} attention`],
      ),
      Icon.chevronRight(h, "size-[12px]"),
    ],
  )
}
