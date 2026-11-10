import { Checkbox, Textarea } from "@foldkit/ui"
import type {
  Approval,
  Decision,
  ItemDetail,
  OutboxEntry,
  Question,
  Snapshot,
} from "@session-inbox/contracts"
import { Option } from "effect"
import { childAttributes, type Html, type HtmlBuilder } from "foldkit/html"
import { COLLAPSED_LINES, collapsedSource, lineCount } from "../markdown.ts"
import { Message, type SnoozeAction } from "../message.ts"
import type { AnswerDraft, Form, Model } from "../model.ts"
import {
  agentDisplayName,
  answersUnavailable,
  areAnswersComplete,
  dayLabel,
  findAgent,
  findSession,
  formatAgo,
  formatClock,
  recordedAnswer,
  selectedHistoryEntry,
} from "../selectors.ts"
import { DETAIL_FORM } from "../shortcuts.ts"
import { canMarkDone, QuestionRadioGroup, SnoozeMenu } from "../update.ts"
import { markdownView } from "./markdown.ts"
import {
  Icon,
  itemBadge,
  kbd,
  kindBadge,
  outcomeBadge,
  runtimeLabel,
  sessionStateLabel,
  sessionTone,
  toneText,
} from "./parts.ts"
import { contextLine, previewView } from "./preview.ts"

type H = HtmlBuilder<Message>

const sectionShell = (h: H, children: ReadonlyArray<Html>): Html =>
  h.section(
    [
      h.AriaLabel("Session detail"),
      h.Class("detail flex min-h-0 flex-col gap-4 overflow-y-auto bg-card px-6 pt-5 pb-6"),
    ],
    children,
  )

const muted = (h: H, text: string): Html =>
  h.p([h.Class("text-[13px] text-muted-foreground")], [text])

// HEADER

const agentName = (snapshot: Option.Option<Snapshot>, detail: ItemDetail): Option.Option<string> =>
  Option.flatMap(snapshot, (s) =>
    Option.map(
      Option.filter(findAgent(s, detail.item.agentId), (a) => a.parentAgentId !== null),
      agentDisplayName,
    ),
  )

const WANTS_TO = "Wants to "

/**
 * The detail's h1 (U-066). A permission says what is asked, from the daemon's summary ("Claude
 * wants to edit src/window.ts +2 −1"); a finished item is in the past tense.
 */
export const titleFor = (detail: ItemDetail): string => {
  const { item, questions, approval } = detail
  const isDone = item.queue === "done"
  if (item.kind === "question") {
    const count = `${questions.length} question${questions.length === 1 ? "" : "s"}`
    if (questions.length === 0) {
      return isDone ? "Claude asked for your input" : "Claude is waiting for your input"
    }
    return isDone ? `Claude asked ${count}` : `Claude has ${count} for you`
  }
  if (item.kind === "permission") {
    const lead = isDone ? "Claude asked to " : "Claude wants to "
    if (item.summary?.startsWith(WANTS_TO) === true) {
      const asked = item.summary.slice(WANTS_TO.length)
      return `${lead}${asked.charAt(0).toLowerCase()}${asked.slice(1)}`
    }
    return approval === null || approval.tool === "Bash"
      ? `${lead}run a command`
      : `${lead}use ${approval.tool}`
  }
  if (item.kind === "failed") {
    return "Session stopped with errors"
  }
  return isDone ? "Session finished its work" : "Ready for your review"
}

/** Review and failed items have Done in the header, so Dismiss leaves this menu (U-061). */
export const snoozeItems = (detail: ItemDetail): ReadonlyArray<SnoozeAction> => [
  "snooze-15m",
  "snooze-1h",
  "snooze-tomorrow",
  ...(canMarkDone(detail) ? [] : (["dismiss"] as const)),
  "mute",
]

const snoozeLabel = (action: SnoozeAction, detail: ItemDetail): string =>
  ({
    "snooze-15m": "Snooze 15 minutes",
    "snooze-1h": "Snooze 1 hour",
    "snooze-tomorrow": "Snooze until tomorrow 9:00",
    dismiss: "Dismiss",
    mute: detail.project.muted ? `Unmute ${detail.project.name}` : `Mute ${detail.project.name}`,
  })[action]

const snoozeMenuView = (model: Model, detail: ItemDetail, h: H): Html =>
  h.div(
    [h.Class("relative")],
    [
      h.submodel({
        slotId: model.snoozeMenu.id,
        model: model.snoozeMenu,
        view: SnoozeMenu.view,
        viewInputs: {
          items: snoozeItems(detail),
          anchor: { placement: "bottom-end", gap: 4, padding: 8 },
          ariaLabel: "Snooze or dismiss",
          itemToConfig: (action) => ({
            className:
              "flex min-h-8 cursor-pointer items-center px-3 text-[13px] whitespace-nowrap text-popover-foreground data-[active]:bg-accent",
            content: h.span([], [snoozeLabel(action, detail)]),
          }),
          itemGroupKey: (action) => (action.startsWith("snooze") ? "snooze" : "other"),
          buttonContent: h.span(
            [h.Class("inline-flex items-center gap-1.5")],
            [Icon.clock(h), "Snooze", Icon.chevronDown(h, "size-[12px]")],
          ),
          buttonAttributes: childAttributes([
            h.Class("btn"),
            h.DataAttribute("variant", "outline"),
            h.DataAttribute("size", "lg"),
          ]),
          itemsAttributes: childAttributes([
            h.Class(
              "z-20 w-max min-w-56 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-lg outline-none",
            ),
          ]),
          separatorAttributes: childAttributes([h.Class("my-1 border-t border-border")]),
          backdropAttributes: childAttributes([h.Class("fixed inset-0 z-10")]),
        },
        toParentMessage: (message) => Message.GotSnoozeMenuMessage({ message }),
      }),
    ],
  )

const detailHeader = (model: Model, detail: ItemDetail, h: H): Html => {
  const crumbs = [
    detail.project.name,
    detail.session.title ?? "Untitled session",
    ...Option.toArray(agentName(model.maybeSnapshot, detail)),
  ]
  const isOpening = model.submission._tag === "Sending" && model.submission.action === "open"
  return h.div(
    [h.Class("flex flex-wrap items-start gap-3")],
    [
      h.div(
        [h.Class("min-w-60 flex-1")],
        [
          h.nav(
            [h.AriaLabel("Breadcrumb"), h.Class("text-[13px] text-muted-foreground")],
            [crumbs.join(" › ")],
          ),
          h.h1([h.Class("mt-1 text-[22px] font-bold tracking-tight")], [titleFor(detail)]),
          h.div(
            [h.Class("mt-1.5")],
            // Finished: what it was; how it ended is the line below (U-057).
            [
              detail.item.queue === "done"
                ? kindBadge(h, detail.item.kind)
                : itemBadge(h, detail.item),
            ],
          ),
          endedLine(model, detail, h),
        ],
      ),
      h.div(
        [h.Class("flex gap-2")],
        [
          canMarkDone(detail) ? doneButton(model, h) : h.empty,
          // A finished item can't be snoozed or dismissed: the daemon answers 409 (U-057, U-065).
          detail.item.queue === "done" ? h.empty : snoozeMenuView(model, detail, h),
          h.button(
            [
              h.Type("button"),
              h.Class("btn"),
              h.DataAttribute("size", "lg"),
              h.Disabled(isOpening),
              h.OnClick(Message.ClickedOpenInClaude()),
            ],
            [Icon.external(h), "Open in Claude"],
          ),
        ],
      ),
    ],
  )
}

/** "I've read it, clear it" for a review or failed item: the dismiss intent, key `e` (U-061). */
const doneButton = (model: Model, h: H): Html => {
  const isSending = model.submission._tag === "Sending" && model.submission.action === "dismiss"
  return h.button(
    [
      h.Type("button"),
      h.Class("btn"),
      h.DataAttribute("variant", "outline"),
      h.DataAttribute("size", "lg"),
      h.Disabled(isSending),
      h.AriaKeyshortcuts("E"),
      h.OnClick(Message.ClickedDone()),
    ],
    [Icon.check(h), "Done", kbd(h, "e")],
  )
}

/** How a finished item ended, in History's words, when History has its entry (U-057). */
const endedLine = (model: Model, detail: ItemDetail, h: H): Html =>
  Option.match(
    Option.filter(selectedHistoryEntry(model), (entry) => entry.item.id === detail.item.id),
    {
      onNone: () => h.empty,
      onSome: (entry) =>
        h.p(
          [h.Class("mt-1.5 flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground")],
          [
            "Ended:",
            outcomeBadge(h, entry.outcome),
            `· ${dayLabel(model.now, entry.endedAt)} at ${formatClock(entry.endedAt)}`,
          ],
        ),
    },
  )

// CONTEXT LINE

/**
 * The session's facts in one quiet line under the title (U-071): where it runs, the branch or
 * worktree when there is one, its state (a word in its tone colour) and when it was last active.
 * A labelled list, so a screen reader hears each fact.
 */
export const contextFacts = (model: Model, detail: ItemDetail, h: H): Html => {
  const { session } = detail
  const branch = session.worktree ?? session.branch
  const fact = (label: string, value: Html | string, title: string, className = "") =>
    h.li(
      [h.Class(`min-w-0 ${className}`), h.Title(title)],
      [h.span([h.Class("sr-only")], [`${label}: `]), value],
    )
  return h.ul(
    [
      h.AriaLabel("Session"),
      h.Class(
        "context-facts m-0 -mt-2 flex list-none flex-wrap items-center p-0 text-[13px] text-muted-foreground",
      ),
    ],
    [
      fact("Runs on", runtimeLabel(session), runtimeLabel(session)),
      branch === null
        ? h.empty
        : fact(
            session.worktree !== null ? "Worktree" : "Branch",
            h.span([h.Class("font-mono text-[12px] text-foreground")], [branch]),
            `${session.worktree !== null ? "Worktree" : "Branch"}: ${branch}`,
          ),
      fact(
        "Session",
        h.span(
          [h.Class(`font-medium ${toneText[sessionTone(session)]}`)],
          [sessionStateLabel(session)],
        ),
        sessionStateLabel(session),
      ),
      fact(
        "Last activity",
        `active ${formatAgo(model.now, session.lastEventAt)}`,
        `Last activity at ${formatClock(session.lastEventAt)}`,
      ),
    ],
  )
}

// CLAUDE'S LAST MESSAGE (C-023, U-033)

export const lastMessageView = (model: Model, detail: ItemDetail, h: H): Html => {
  const message = detail.lastMessage
  if (message === undefined || message.trim() === "") {
    return h.empty
  }
  const collapsed = collapsedSource(message)
  const isExpanded = model.isLastMessageExpanded
  const shown = collapsed === null || isExpanded ? message : collapsed
  const bodyId = `last-message-${detail.item.id}`
  return h.section(
    [
      h.AriaLabelledBy(`${bodyId}-title`),
      h.Class("flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-background p-4"),
    ],
    [
      h.h2(
        [
          h.Id(`${bodyId}-title`),
          h.Class("text-[11px] font-semibold uppercase tracking-[0.06em] text-subtle-foreground"),
        ],
        ["Claude's last message"],
      ),
      h.div(
        [h.Id(bodyId), h.Class(`md ${collapsed !== null && !isExpanded ? "md-faded" : ""}`)],
        markdownView(h, shown),
      ),
      collapsed === null
        ? h.empty
        : h.button(
            [
              h.Type("button"),
              h.Class("btn self-start"),
              h.DataAttribute("variant", "ghost"),
              h.DataAttribute("size", "sm"),
              h.AriaExpanded(isExpanded),
              h.AriaControls(bodyId),
              h.OnClick(Message.ToggledLastMessageExpanded()),
            ],
            [
              isExpanded
                ? "Show less"
                : lineCount(message) > COLLAPSED_LINES
                  ? `Show all ${lineCount(message)} lines`
                  : "Show all",
            ],
          ),
    ],
  )
}

// QUESTION FORM

const answerFor = (form: Form, idx: number): AnswerDraft =>
  form.answers.find((a) => a.idx === idx) ?? { idx, selected: [], other: "" }

const optionDescription = (
  h: H,
  description: string | undefined,
  attrs: ReadonlyArray<never> | ReadonlyArray<unknown> = [],
) =>
  description === undefined
    ? h.empty
    : h.span(
        [...(attrs as ReadonlyArray<never>), h.Class("text-xs font-normal opacity-75")],
        [description],
      )

const singleChoice = (form: Form, question: Question, position: number, h: H): Html => {
  const group = form.radioGroups[position]
  const answer = answerFor(form, question.idx)
  if (group === undefined) {
    return h.empty
  }
  return h.submodel({
    slotId: group.id,
    model: group,
    view: QuestionRadioGroup.view,
    viewInputs: {
      options: question.options.map((o) => o.label),
      selectedValue: Option.fromNullishOr(answer.selected[0]),
      ariaLabel: question.text,
      orientation: "Horizontal",
      hasOptionDescription: (_value, index) => question.options[index]?.description !== undefined,
      toView: ({ group: groupAttrs, options }) =>
        h.div(
          [...groupAttrs, h.Class("flex flex-wrap gap-2")],
          options.map((option) =>
            h.div(
              [...option.option, h.Class("choice")],
              [
                h.span([...option.label], [option.value]),
                optionDescription(
                  h,
                  question.options[option.index]?.description,
                  option.description,
                ),
              ],
            ),
          ),
        ),
    },
    toParentMessage: (message) => Message.GotRadioGroupMessage({ idx: question.idx, message }),
  })
}

const multiChoice = (form: Form, question: Question, h: H): Html => {
  const answer = answerFor(form, question.idx)
  return h.div(
    [h.Class("flex flex-wrap gap-2")],
    question.options.map((option, index) =>
      Checkbox.view(
        {
          id: `q-${form.itemId}-${question.idx}-${index}`,
          isChecked: answer.selected.includes(option.label),
          onToggle: (isChecked) =>
            Message.ToggledOption({ idx: question.idx, label: option.label, isChecked }),
          hasDescription: option.description !== undefined,
          toView: ({ checkbox, label, description }) =>
            h.div(
              [...checkbox, h.Class("choice")],
              [
                h.span(
                  [
                    h.AriaHidden(true),
                    h.Class(
                      "inline-flex size-[16px] items-center justify-center rounded border border-current",
                    ),
                  ],
                  [answer.selected.includes(option.label) ? Icon.check(h, "size-[12px]") : h.empty],
                ),
                h.span([...label], [option.label]),
                option.description === undefined
                  ? h.empty
                  : h.span(
                      [...description, h.Class("text-xs font-normal opacity-75")],
                      [option.description],
                    ),
              ],
            ),
        },
        h,
      ),
    ),
  )
}

const questionFieldset = (form: Form, question: Question, position: number, h: H): Html => {
  const answer = answerFor(form, question.idx)
  const otherId = `q-${form.itemId}-${question.idx}-other`
  return h.fieldset(
    [h.Class("m-0 flex flex-col gap-2 border-none p-0")],
    [
      h.legend(
        [h.Class("mb-2 p-0 text-[15px] font-semibold")],
        [
          `${position + 1}. ${question.text}`,
          question.multi
            ? h.span([h.Class("ml-2 text-xs font-normal text-subtle-foreground")], ["Pick any"])
            : h.empty,
        ],
      ),
      question.multi ? multiChoice(form, question, h) : singleChoice(form, question, position, h),
      // Always its own full-width row under the options (U-072).
      h.div(
        [h.Class("flex")],
        [
          h.label(
            [h.For(otherId), h.Class("sr-only")],
            [`Other answer to question ${position + 1}`],
          ),
          h.input([
            h.Id(otherId),
            h.Type("text"),
            h.Class(
              `input min-h-8 w-full ${answer.other.trim() !== "" ? "border-2 border-primary" : ""}`,
            ),
            h.Placeholder("Other…"),
            h.Value(answer.other),
            h.OnInput((value) => Message.UpdatedOther({ idx: question.idx, value })),
          ]),
        ],
      ),
    ],
  )
}

export const deliveryNote = (model: Model, detail: ItemDetail, h: H): Html => {
  const target = Option.getOrElse(
    agentName(model.maybeSnapshot, detail),
    () => detail.session.title ?? "the session",
  )
  return h.span(
    [h.Class("text-[13px] text-muted-foreground")],
    detail.item.queue === "done"
      ? [
          "Answered. ",
          h.strong([h.Class("font-semibold text-foreground")], [target]),
          " has your answers.",
        ]
      : detail.item.live
        ? [
            "Your answers go straight to ",
            h.strong([h.Class("font-semibold text-foreground")], [target]),
            // Through Claude's own prompt nothing is paused: say what the approval card says.
            detail.approval?.via === "permissionRequest"
              ? `. ${ASKING_TOO_TEXT}`
              : ". It's paused waiting for them.",
          ]
        : [
            "Your answers go to ",
            h.strong([h.Class("font-semibold text-foreground")], [target]),
            " in one reply when the session is idle. The session picks up from there.",
          ],
  )
}

/** Claude's own question prompt (or no way to send): the questions, the reason, Open in Claude. */
const questionsWaitingView = (model: Model, detail: ItemDetail, reason: string, h: H): Html =>
  h.section(
    [
      h.AriaLabel("Claude's questions"),
      h.Class("flex flex-col gap-3 rounded-[14px] border-2 border-needs-strong p-4"),
    ],
    [
      h.ul(
        [h.Class("m-0 flex list-none flex-col gap-1.5 p-0")],
        detail.questions.map((q) =>
          h.li(
            [h.Class("text-[14px] text-foreground")],
            [
              q.header === undefined
                ? h.empty
                : h.span([h.Class("mr-2 font-semibold")], [q.header]),
              q.text,
            ],
          ),
        ),
      ),
      ...waitingInClaudeFooter(model, h, reason),
    ],
  )

/** A finished question: what was asked and what was answered, nothing to send (U-057). */
const answeredQuestionsView = (detail: ItemDetail, h: H): Html =>
  h.section(
    [
      h.AriaLabel("Claude's questions"),
      h.Class("flex flex-col gap-3 rounded-[14px] border border-border p-4"),
    ],
    [
      h.ol(
        [h.Class("m-0 flex list-none flex-col gap-3 p-0")],
        detail.questions.map((q, i) => {
          const answer = recordedAnswer(q)
          const words =
            answer === null
              ? null
              : [...answer.selected, ...(answer.other.trim() === "" ? [] : [answer.other])].join(
                  ", ",
                )
          return h.li(
            [h.Class("flex flex-col gap-1")],
            [
              h.p([h.Class("text-[15px] font-semibold")], [`${i + 1}. ${q.text}`]),
              words === null
                ? h.p(
                    [h.Class("text-[13px] text-muted-foreground")],
                    ["No answer was sent from the inbox."],
                  )
                : h.p(
                    [h.Class("flex items-start gap-1.5 text-[14px] text-foreground")],
                    [
                      h.span([h.Class("mt-0.5 text-ready")], [Icon.check(h)]),
                      h.span([h.Class("sr-only")], ["Answer: "]),
                      words,
                    ],
                  ),
            ],
          )
        }),
      ),
    ],
  )

export const questionForm = (model: Model, detail: ItemDetail, form: Form, h: H): Html => {
  if (detail.item.queue === "done") return answeredQuestionsView(detail, h)
  const unavailable = answersUnavailable(detail)
  if (unavailable !== null) return questionsWaitingView(model, detail, unavailable, h)
  const isSending = model.submission._tag === "Sending" && model.submission.action === "answers"
  const isComplete = areAnswersComplete(form)
  return h.form(
    [
      h.AriaLabel("Answer Claude's questions"),
      h.DataAttribute(DETAIL_FORM, ""),
      h.Class("flex flex-col gap-4 rounded-[14px] border-2 border-needs-strong p-4"),
      h.OnSubmit(Message.SubmittedAnswers()),
    ],
    [
      ...detail.questions.map((q, i) => questionFieldset(form, q, i, h)),
      h.div(
        [h.Class("flex flex-wrap items-center gap-3 border-t border-border pt-3.5")],
        [
          deliveryNote(model, detail, h),
          h.button(
            [
              h.Type("submit"),
              h.Class("btn ml-auto"),
              h.DataAttribute("variant", "needs"),
              h.DataAttribute("size", "lg"),
              h.Disabled(!isComplete || isSending),
              h.AriaKeyshortcuts("Meta+Enter"),
            ],
            [isSending ? "Sending…" : "Send answers", kbd(h, "⌘↵")],
          ),
        ],
      ),
      isComplete
        ? h.empty
        : h.p(
            [h.Class("-mt-2 text-xs text-subtle-foreground")],
            ["Answer every question to send."],
          ),
    ],
  )
}

// APPROVAL CARD

const commandPreview = (approval: Approval): { command: string; description: string | null } => {
  const input = approval.input
  if (input !== null && typeof input === "object") {
    const record = input as Record<string, unknown>
    const description = typeof record.description === "string" ? record.description : null
    if (typeof record.command === "string") {
      return { command: record.command, description }
    }
    if (typeof record.file_path === "string") {
      return { command: record.file_path, description }
    }
    return { command: JSON.stringify(input, null, 2), description }
  }
  return { command: String(input), description: null }
}

const DECISION_WORD: Record<Decision, string> = {
  allow: "Allowed once",
  "allow-always": "Always allowed",
  deny: "Denied",
  ask: "Left to Claude's own prompt",
}

/** A finished permission: the decision made here, or that none was; no buttons (U-057). */
export const decisionLine = (approval: Approval): string =>
  approval.decision === null
    ? "No decision was made in the inbox."
    : `Decided here: ${DECISION_WORD[approval.decision]}${approval.decidedAt === null ? "" : ` at ${formatClock(approval.decidedAt)}`}.`

/** One quiet line and Open in Claude: the item is Claude's own prompt, answered there (U-043). */
export const WAITING_IN_CLAUDE_TEXT = "Claude is asking in its own window. Answer there."

const waitingInClaudeFooter = (
  model: Model,
  h: H,
  text: string = WAITING_IN_CLAUDE_TEXT,
): ReadonlyArray<Html> => {
  const isOpening = model.submission._tag === "Sending" && model.submission.action === "open"
  return [
    h.p([h.Class("text-[13px] text-muted-foreground")], [text]),
    h.div(
      [h.Class("flex flex-wrap items-center gap-2")],
      [
        h.button(
          [
            h.Type("button"),
            h.Class("btn"),
            h.DataAttribute("size", "lg"),
            h.Disabled(isOpening),
            h.OnClick(Message.ClickedOpenInClaude()),
          ],
          [Icon.external(h), "Open in Claude"],
        ),
      ],
    ),
  ]
}

/** Claude's own prompt is open too (U-045); the question card says the same (U-067). */
export const ASKING_TOO_TEXT =
  "Claude is asking in its own window too; whichever is answered first wins."

const decisionFooter = (
  model: Model,
  detail: ItemDetail,
  approval: Approval,
  disabled: boolean,
  h: H,
): ReadonlyArray<Html> => {
  const secondsLeft = Math.max(0, Math.round((approval.expiresAt - model.now) / 1000))
  const within = secondsLeft > 0 ? `about ${Math.max(1, Math.round(secondsLeft / 60))} min` : null
  // The daemon says how this request reached us; the words follow it (U-045).
  const viaRequest = approval.via === "permissionRequest"
  // Offered only when the daemon says exactly which rule it would write (C-026).
  const alwaysAllow = approval.alwaysAllow
  const liveLine = viaRequest
    ? `${ASKING_TOO_TEXT}${within === null ? "" : ` The inbox can answer for ${within}.`}`
    : `Claude is paused on this. If you don't answer${within === null ? " soon" : ` within ${within}`}, Claude's own prompt takes over.`
  return [
    h.p(
      [h.Class("text-[13px] text-muted-foreground")],
      [
        detail.item.live
          ? liveLine
          : "Claude's own prompt has taken over — deciding here may not reach it. Open it in Claude.",
      ],
    ),
    h.div(
      [h.Class("flex flex-wrap items-center gap-2")],
      [
        h.button(
          [
            h.Type("button"),
            h.Class("btn"),
            h.DataAttribute("size", "lg"),
            h.Disabled(disabled),
            h.AriaKeyshortcuts("Meta+Enter"),
            h.OnClick(Message.ClickedDecision({ decision: "allow" })),
          ],
          ["Allow once", kbd(h, "⌘↵")],
        ),
        alwaysAllow === undefined
          ? h.empty
          : h.button(
              [
                h.Type("button"),
                h.Class("btn"),
                h.DataAttribute("variant", "outline"),
                h.DataAttribute("size", "lg"),
                h.Disabled(disabled),
                h.Title(`Adds ${alwaysAllow}`),
                h.OnClick(Message.ClickedDecision({ decision: "allow-always" })),
              ],
              ["Always allow"],
            ),
        denyNoteField(model, detail, disabled, h),
        h.button(
          [
            h.Type("button"),
            h.Class("btn"),
            h.DataAttribute("variant", "danger-outline"),
            h.DataAttribute("size", "lg"),
            h.Disabled(disabled),
            h.AriaKeyshortcuts("Meta+Backspace"),
            h.OnClick(Message.ClickedDecision({ decision: "deny" })),
          ],
          ["Deny", kbd(h, "⌘⌫")],
        ),
      ],
    ),
    alwaysAllow === undefined ? h.empty : alwaysAllowHint(alwaysAllow, h),
  ]
}

export const DENY_NOTE_PLACEHOLDER = "Tell Claude why (optional)"

/**
 * One optional line beside Deny (U-063). With text, Deny (the button, ⌘⌫ outside the field, or
 * Enter in it) sends it as the reason. Not part of the detail form: ⌘↵ in it allows nothing.
 */
const denyNoteField = (model: Model, detail: ItemDetail, disabled: boolean, h: H): Html => {
  const id = `deny-note-${detail.item.id}`
  return h.div(
    [h.Class("ml-auto flex min-w-48 flex-1 justify-end")],
    [
      h.label([h.For(id), h.Class("sr-only")], ["Reason for denying (optional)"]),
      h.input([
        h.Id(id),
        h.Type("text"),
        h.Class("input h-9 w-full max-w-72 text-[13px]"),
        h.Placeholder(DENY_NOTE_PLACEHOLDER),
        h.Autocomplete("off"),
        h.Value(model.denyNote),
        h.Disabled(disabled),
        h.OnInput((value) => Message.UpdatedDenyNote({ value })),
        h.OnKeyDownPreventDefault((key, modifiers) =>
          key === "Enter" && !modifiers.metaKey && !modifiers.ctrlKey
            ? Option.some(Message.SubmittedDenyNote())
            : Option.none(),
        ),
      ]),
    ],
  )
}

/**
 * `Read(//tmp/p/**) for this session` → the rule and where it goes. Splits at the first space
 * after the parenthesis that closes the first `(`; null when there's no such shape.
 */
export const splitAlwaysAllow = (text: string): { rule: string; rest: string } | null => {
  const open = text.indexOf("(")
  if (open <= 0) return null
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === "(") depth++
    else if (c === ")" && --depth === 0) {
      const space = text.indexOf(" ", i)
      return space === -1 ? null : { rule: text.slice(0, space), rest: text.slice(space) }
    }
  }
  return null
}

/** What Always allow will write, in the daemon's words (C-026, U-048). */
const alwaysAllowHint = (alwaysAllow: string, h: H): Html => {
  const split = splitAlwaysAllow(alwaysAllow)
  return h.p(
    [h.Class("text-xs text-subtle-foreground")],
    split === null
      ? [`Always allow adds ${alwaysAllow}.`]
      : [
          "Always allow adds ",
          h.code([h.Class("rounded bg-code px-1 font-mono")], [split.rule]),
          `${split.rest}.`,
        ],
  )
}

export const approvalCard = (model: Model, detail: ItemDetail, approval: Approval, h: H): Html => {
  const { command, description } = commandPreview(approval)
  const isSending = model.submission._tag === "Sending" && model.submission.action === "decision"
  // Decided here a moment ago (the item may still be on its way to done) reads like a finished
  // one: the decision in words, no buttons, no Needs-you border (U-064).
  const isDecided = approval.decision !== null || detail.item.queue === "done"
  // Not held and not finished: Claude's own prompt is what's waiting (observed prompt, lapsed
  // hold, observer channel). Buttons here couldn't reach it (U-043).
  const isWaitingInClaude = !detail.item.live && !isDecided
  // Daemon-computed preview (U-031); older approvals without one keep the plain block.
  const preview = previewView(h, approval, model.isPreviewExpanded)
  return h.section(
    [
      h.AriaLabel("Permission request"),
      h.Class(
        `flex min-w-0 flex-col gap-3 rounded-[14px] p-4 ${
          isDecided ? "border border-border" : "border-2 border-needs-strong"
        }`,
      ),
    ],
    [
      // The title already says what is asked; with a preview the tool name adds nothing (U-066).
      preview !== null
        ? h.empty
        : h.div(
            [h.Class("flex items-center gap-2 text-[13px] text-muted-foreground")],
            [
              h.span([h.Class("font-semibold text-foreground")], [approval.tool]),
              description === null ? h.empty : `· ${description}`,
            ],
          ),
      contextLine(h, approval),
      preview ??
        h.pre(
          [
            h.Class(
              "m-0 overflow-x-auto rounded-lg bg-code px-3 py-2 font-mono text-[13px] whitespace-pre-wrap",
            ),
          ],
          [h.code([], [command])],
        ),
      ...(isDecided
        ? [h.p([h.Class("text-[13px] text-muted-foreground")], [decisionLine(approval)])]
        : isWaitingInClaude
          ? waitingInClaudeFooter(model, h)
          : decisionFooter(model, detail, approval, isSending, h)),
    ],
  )
}

// SHORT REPLY

/** The daemon says a reply can't be sent from here (C-023): say so instead of a reply box. */
const replyUnavailableView = (model: Model, reason: string, h: H): Html => {
  const isOpening = model.submission._tag === "Sending" && model.submission.action === "open"
  return h.section(
    [
      h.AriaLabel("Reply to Claude"),
      h.Class("flex flex-col gap-2.5 rounded-xl border border-border p-4"),
    ],
    [
      h.p([h.Class("text-[13px] text-foreground")], [reason]),
      h.button(
        [
          h.Type("button"),
          h.Class("btn self-start"),
          h.DataAttribute("size", "lg"),
          h.Disabled(isOpening),
          h.OnClick(Message.ClickedOpenInClaude()),
        ],
        [Icon.external(h), "Open in Claude"],
      ),
    ],
  )
}

export const replyForm = (model: Model, detail: ItemDetail, form: Form, h: H): Html => {
  if (detail.replyUnavailable !== undefined) {
    return replyUnavailableView(model, detail.replyUnavailable, h)
  }
  const isSending = model.submission._tag === "Sending" && model.submission.action === "reply"
  const replyErrorId = `reply-${detail.item.id}-error`
  const replyError = Option.getOrUndefined(model.maybeReplyError)
  return h.form(
    [
      h.AriaLabel("Reply to Claude"),
      h.DataAttribute(DETAIL_FORM, ""),
      h.Class("flex flex-col gap-2"),
      h.OnSubmit(Message.SubmittedReply()),
    ],
    [
      Textarea.view(
        {
          id: `reply-${detail.item.id}`,
          value: form.reply,
          rows: 3,
          placeholder:
            detail.item.kind === "failed"
              ? "e.g. Fix the parser tests, then stop"
              : "e.g. Looks good — open the PR",
          hasDescription: true,
          onInput: (value) => Message.UpdatedReply({ value }),
          toView: ({ textarea, label, description }) =>
            h.div(
              [h.Class("flex flex-col gap-1.5")],
              [
                h.label([...label, h.Class("text-[14px] font-semibold")], ["Short reply"]),
                h.textarea([
                  ...textarea,
                  h.Class("textarea min-h-20 text-[13px]"),
                  ...(replyError === undefined
                    ? []
                    : [h.AriaInvalid(true), h.AriaErrorMessage(replyErrorId)]),
                ]),
                h.p(
                  [...description, h.Class("text-xs text-subtle-foreground")],
                  [
                    "Sent with claude --resume when the session is idle. For anything bigger, open it in Claude.",
                  ],
                ),
              ],
            ),
        },
        h,
      ),
      replyError === undefined
        ? h.empty
        : h.p(
            [
              h.Id(replyErrorId),
              h.Role("alert"),
              h.Class("rounded-md bg-failed-tint px-2.5 py-1.5 text-[13px] text-failed"),
            ],
            [replyError],
          ),
      h.div(
        [h.Class("flex justify-end")],
        [
          h.button(
            [
              h.Type("submit"),
              h.Class("btn"),
              h.DataAttribute("size", "lg"),
              h.Disabled(form.reply.trim() === "" || isSending),
              h.AriaKeyshortcuts("Meta+Enter"),
            ],
            [Icon.send(h), isSending ? "Sending…" : "Send reply", kbd(h, "⌘↵")],
          ),
        ],
      ),
    ],
  )
}

// DELIVERY

const OUTBOX_LABEL: Record<OutboxEntry["state"], { word: string; tone: string }> = {
  queued: { word: "Queued", tone: "text-subtle-foreground" },
  sending: { word: "Sending", tone: "text-working" },
  delivered: { word: "Delivered", tone: "text-ready" },
  failed: { word: "Failed", tone: "text-failed" },
}

const outboxIcon = (h: H, state: OutboxEntry["state"]): Html =>
  state === "delivered"
    ? Icon.check(h)
    : state === "failed"
      ? Icon.alert(h)
      : state === "sending"
        ? Icon.send(h)
        : Icon.clock(h)

const deliveryView = (model: Model, detail: ItemDetail, h: H): Html => {
  if (
    detail.outbox.length === 0 &&
    !detail.item.unconfirmed &&
    (detail.item.state !== "answered" || detail.approval !== null)
  ) {
    return h.empty
  }
  return h.section(
    [h.AriaLabel("Delivery"), h.Class("flex flex-col gap-2 rounded-xl border border-border p-3")],
    [
      h.h2([h.Class("text-[13px] font-semibold")], ["Delivery"]),
      h.ul(
        [h.Class("flex flex-col gap-1.5"), h.AriaLive("polite")],
        [
          ...detail.outbox.map((entry) =>
            h.keyed("li")(
              entry.id,
              [h.Class("flex items-start gap-2 text-[13px]")],
              [
                h.span(
                  [
                    h.Class(
                      `inline-flex w-24 shrink-0 items-center gap-1 font-semibold ${OUTBOX_LABEL[entry.state].tone}`,
                    ),
                  ],
                  [outboxIcon(h, entry.state), OUTBOX_LABEL[entry.state].word],
                ),
                h.span([h.Class("min-w-0 flex-1 truncate text-muted-foreground")], [entry.body]),
                h.span(
                  [h.Class("shrink-0 text-xs text-subtle-foreground")],
                  [formatAgo(model.now, entry.createdAt)],
                ),
                entry.lastError === null
                  ? h.empty
                  : h.span([h.Class("text-xs text-failed")], [entry.lastError]),
              ],
            ),
          ),
          // An approval's answer is its decision, said on the card (U-064).
          ...(detail.outbox.length === 0 &&
          detail.item.state === "answered" &&
          detail.approval === null
            ? [
                h.li(
                  [h.Class("flex items-center gap-2 text-[13px] text-ready")],
                  [Icon.check(h), "Sent to the live session"],
                ),
              ]
            : []),
          ...(detail.item.unconfirmed
            ? [
                h.li(
                  [h.Class("flex items-center gap-2 text-[13px] text-needs")],
                  [
                    Icon.alert(h),
                    "Unconfirmed — no event from the session since. Check it in Claude.",
                  ],
                ),
              ]
            : []),
        ],
      ),
    ],
  )
}

// ACTIVITY

/** The newest 8 lines, plus the item's source event when it is older than those (U-021). */
export const activityEntries = (
  timeline: ItemDetail["timeline"],
  limit = 8,
): ItemDetail["timeline"] => {
  const recent = timeline.slice(0, limit)
  const source = timeline.find((e) => e.isSource === true)
  return source === undefined || recent.includes(source) ? recent : [...recent, source]
}

const activityView = (model: Model, detail: ItemDetail, h: H): Html => {
  const entries = activityEntries(detail.timeline)
  const oldest = entries[entries.length - 1]
  const minutes =
    oldest === undefined ? 0 : Math.max(1, Math.round((model.now - oldest.at) / 60_000))
  return h.section(
    [h.AriaLabel("Activity"), h.Class("flex flex-col gap-2.5")],
    [
      h.div(
        [h.Class("flex items-center")],
        [
          h.h2(
            [h.Class("text-[14px] font-semibold")],
            [entries.length === 0 ? "No activity yet" : `Since you left · ${minutes} min`],
          ),
          h.button(
            [
              h.Type("button"),
              h.Class(
                "ml-auto inline-flex min-h-[24px] cursor-pointer items-center text-[13px] text-working underline-offset-2 hover:underline",
              ),
              h.OnClick(Message.ClickedOpenInClaude()),
            ],
            ["Full transcript in Claude"],
          ),
        ],
      ),
      h.ol(
        [h.Class("m-0 flex list-none flex-col p-0 text-[14px]")],
        entries.map((entry) => {
          const isLatest = entry.isSource === true
          return h.keyed("li")(
            String(entry.seq),
            [h.Class("grid min-h-8 grid-cols-[56px_14px_1fr] items-center gap-2.5")],
            [
              h.span(
                [h.Class("text-xs text-subtle-foreground tabular-nums")],
                [formatClock(entry.at)],
              ),
              h.span([
                h.AriaHidden(true),
                h.Class(
                  isLatest
                    ? "size-2.5 rounded-full bg-needs-strong"
                    : "box-border size-2.5 rounded-full border-2 border-subtle-foreground/60",
                ),
              ]),
              h.span(
                [h.Class(isLatest ? "font-semibold" : "text-muted-foreground")],
                [entry.text, isLatest ? " (this item)" : ""],
              ),
            ],
          )
        }),
      ),
    ],
  )
}

// DETAIL

const loadedView = (model: Model, detail: ItemDetail, h: H): ReadonlyArray<Html> => {
  const form = Option.getOrUndefined(
    Option.filter(model.maybeForm, (f) => f.itemId === detail.item.id),
  )
  const action =
    form === undefined
      ? h.empty
      : detail.item.kind === "question" && detail.questions.length > 0
        ? questionForm(model, detail, form, h)
        : detail.approval !== null
          ? approvalCard(model, detail, detail.approval, h)
          : replyForm(model, detail, form, h)
  return [
    detailHeader(model, detail, h),
    contextFacts(model, detail, h),
    lastMessageView(model, detail, h),
    action,
    deliveryView(model, detail, h),
    activityView(model, detail, h),
  ]
}

const sessionOnlyView = (model: Model, sessionId: string, h: H): ReadonlyArray<Html> =>
  Option.match(
    Option.flatMap(model.maybeSnapshot, (s) => findSession(s, sessionId)),
    {
      onNone: () => [muted(h, "Session not found.")],
      onSome: (session) => [
        h.div(
          [],
          [
            h.h1(
              [h.Class("text-[22px] font-bold tracking-tight")],
              [session.title ?? "Untitled session"],
            ),
            h.p(
              [h.Class(`mt-1 text-[13px] ${toneText[sessionTone(session)]}`)],
              [`${sessionStateLabel(session)} · ${runtimeLabel(session)}`],
            ),
          ],
        ),
        muted(
          h,
          "Nothing here needs you. Routine progress stays quiet; you'll see this session again when it asks, stops or fails.",
        ),
      ],
    },
  )

export const detailView = (model: Model, h: H): Html =>
  sectionShell(
    h,
    (() => {
      if (model.detail._tag === "Loaded") {
        return loadedView(model, model.detail.detail, h)
      }
      if (model.detail._tag === "Loading") {
        return [muted(h, "Loading…")]
      }
      if (model.detail._tag === "Failed") {
        return [muted(h, `Couldn't load this item: ${model.detail.error}`)]
      }
      return Option.match(model.maybeSelectedSessionId, {
        onSome: (sessionId) => sessionOnlyView(model, sessionId, h),
        onNone: () => [
          muted(
            h,
            model.route === "history"
              ? "Pick an entry to see how it ended."
              : "Pick an item from the queue.",
          ),
        ],
      })
    })(),
  )
