/**
 * AskUserQuestion: pulling structured questions out of tool_input, and encoding
 * answers — either back through the held hook or as one outbox reply.
 */
import {
  type Answer,
  AskUserQuestionInput,
  type HookDecision,
  type Question,
} from "@session-inbox/contracts"
import { Result, Schema } from "effect"

export type AnswerMode = "updatedInput" | "denyWithReason"

export const parseQuestions = (toolInput: unknown): Question[] => {
  const r = Schema.decodeUnknownResult(AskUserQuestionInput)(toolInput)
  if (Result.isFailure(r)) return []
  return r.success.questions.map((q, idx) => ({
    idx,
    ...(q.header === undefined ? {} : { header: q.header }),
    text: q.question,
    options: q.options.map((o) => ({
      label: o.label,
      ...(o.description === undefined ? {} : { description: o.description }),
    })),
    multi: q.multiSelect ?? false,
    answer: null,
  }))
}

/** "label", "a, b", or the free text (other wins when given). */
export const answerText = (a: Answer): string => {
  const other = a.other?.trim()
  if (other) return a.selected.length > 0 ? `${a.selected.join(", ")}, ${other}` : other
  return a.selected.join(", ")
}

export const validateAnswers = (
  questions: ReadonlyArray<Question>,
  answers: ReadonlyArray<Answer>,
): string | null => {
  if (questions.length === 0) return "item has no structured questions"
  for (const q of questions) {
    const a = answers.find((x) => x.idx === q.idx)
    if (!a || answerText(a) === "") return `question ${q.idx + 1} has no answer`
    if (!q.multi && a.selected.length > 1) return `question ${q.idx + 1} takes one option`
  }
  return null
}

/**
 * THE encoding of answers to a live AskUserQuestion (DECISIONS.md D-0xx). The spike
 * may flip `questions.answerMode`; nothing else needs to change.
 */
export const encodeLiveAnswers = (
  mode: AnswerMode,
  toolInput: unknown,
  questions: ReadonlyArray<Question>,
  answers: ReadonlyArray<Answer>,
): HookDecision => {
  const map: Record<string, string> = {}
  for (const q of questions) {
    const a = answers.find((x) => x.idx === q.idx)
    if (a) map[q.text] = answerText(a)
  }
  if (mode === "updatedInput") {
    const base = toolInput && typeof toolInput === "object" ? toolInput : {}
    return { decision: "allow", updatedInput: { ...base, answers: map } }
  }
  return { decision: "deny", reason: formatAnswersReply(questions, answers) }
}

/** One human-readable reply for the outbox (non-live questions) or a deny reason. */
export const formatAnswersReply = (
  questions: ReadonlyArray<Question>,
  answers: ReadonlyArray<Answer>,
): string => {
  const lines = ["The user answered your questions:"]
  for (const q of questions) {
    const a = answers.find((x) => x.idx === q.idx)
    lines.push(`${q.idx + 1}. ${q.text}`, `   → ${a ? answerText(a) : "(no answer)"}`)
  }
  return lines.join("\n")
}
