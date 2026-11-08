import { Combobox, Dialog, Menu, RadioGroup } from "@foldkit/ui"
import type { Answer, Decision, ItemDetail, OutboxEntry, Snapshot } from "@session-inbox/contracts"
import { Array as Arr, Option, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import type { DaemonClient } from "./client/daemonClient.ts"
import {
  DismissItem,
  FetchItemDetail,
  FetchSnapshot,
  FocusTreeNode,
  MarkRead,
  MuteProject,
  OpenInClaude,
  SaveDraft,
  SendDecision,
  SendReply,
  SetHash,
  SnoozeItem,
  SubmitAnswers,
  WaitBeforeDraftSave,
  WaitBeforeSnapshotRetry,
} from "./command.ts"
import { Message, type SnoozeAction, type TreeKey } from "./message.ts"
import {
  type ActionKind,
  type AnswerDraft,
  AppView,
  Connection,
  DetailState,
  type Form,
  type Model,
  Submission,
} from "./model.ts"
import {
  areAnswersComplete,
  draftBody,
  extendOrder,
  findItem,
  findSession,
  firstOpenItemForSession,
  formFromDetail,
  hashForItem,
  itemIdFromHash,
  mergeDelta,
  projectNodeId,
  sessionNodeId,
  visibleTreeNodes,
} from "./selectors.ts"
import { Toast, type ToastPayload } from "./toast.ts"

export type UpdateReturn = Update.Return<Model, Message, DaemonClient>
type Commands = NonNullable<UpdateReturn["commands"]>

// FLAGS / INIT

export const Flags = Schema.Struct({
  view: AppView,
  now: Schema.Number,
  maybeInitialItemId: Schema.Option(Schema.String),
})
export type Flags = typeof Flags.Type

export const SessionCombobox = Combobox.create<string>()
export const SnoozeMenu = Menu.create<SnoozeAction>()
export const QuestionRadioGroup = RadioGroup.create<string>()

export const initialModel = (flags: Flags): Model => ({
  view: flags.view,
  now: flags.now,
  connection: Connection.Connecting(),
  maybeSnapshot: Option.none(),
  itemOrder: [],
  streamEpoch: 0,
  queueTab: "needs-you",
  maybeSelectedItemId: flags.maybeInitialItemId,
  maybeSelectedSessionId: Option.none(),
  detail: Option.match(flags.maybeInitialItemId, {
    onNone: () => DetailState.Idle(),
    onSome: (itemId) => DetailState.Loading({ itemId }),
  }),
  expandedNodes: [],
  maybeFocusedNode: Option.none(),
  maybeForm: Option.none(),
  draftVersion: 0,
  submission: Submission.Idle(),
  jumpDialog: Dialog.init({
    id: "jump-dialog",
    focusSelector: `#${Combobox.inputId("jump-combobox")}`,
  }),
  jumpCombobox: Combobox.init({ id: "jump-combobox" }),
  snoozeMenu: Menu.init({ id: "snooze-menu" }),
  toasts: Toast.init({ id: "toasts", defaultDuration: "4 seconds" }),
})

export const init = (flags: Flags): UpdateReturn => {
  const model = initialModel(flags)
  return {
    model,
    commands: [
      FetchSnapshot(),
      ...Option.match(flags.maybeInitialItemId, {
        onNone: () => [],
        onSome: (itemId) => [FetchItemDetail({ itemId })],
      }),
    ],
  }
}

// HELPERS

type ChildResult<ChildModel, ChildMessage, OutMessage> = Readonly<{
  model: ChildModel
  commands?: ReadonlyArray<Command.Command<ChildMessage>>
  outMessage?: OutMessage
}>

/** Lift a child component's result into the app Model/Message. */
const lift = <ChildModel, ChildMessage, OutMessage>(
  result: ChildResult<ChildModel, ChildMessage, OutMessage>,
  write: (childModel: ChildModel) => Model,
  toMessage: (message: ChildMessage) => Message,
): { model: Model; commands: Commands; outMessage: OutMessage | undefined } => ({
  model: write(result.model),
  commands: Command.mapMessages(result.commands, toMessage),
  outMessage: result.outMessage,
})

const withCommands = (ret: UpdateReturn, more: Commands): UpdateReturn => ({
  model: ret.model,
  commands: [...(ret.commands ?? []), ...more],
})

const showToast = (
  model: Model,
  payload: ToastPayload,
  variant: "Info" | "Success" | "Warning" | "Error",
): UpdateReturn => {
  const shown = lift(
    Toast.show(model.toasts, { payload, variant }),
    (toasts) => modifyFields(model, { toasts: () => toasts }),
    (message) => Message.GotToastMessage({ message }),
  )
  return { model: shown.model, commands: shown.commands }
}

const showToasts = (
  ret: UpdateReturn,
  toasts: ReadonlyArray<{ payload: ToastPayload; variant: "Success" | "Error" | "Info" }>,
): UpdateReturn =>
  toasts.reduce<UpdateReturn>((acc, toast) => {
    const next = showToast(acc.model, toast.payload, toast.variant)
    return { model: next.model, commands: [...(acc.commands ?? []), ...(next.commands ?? [])] }
  }, ret)

const loadedDetail = (model: Model): Option.Option<ItemDetail> =>
  model.detail._tag === "Loaded" ? Option.some(model.detail.detail) : Option.none()

const nodesToExpandFor = (snapshot: Snapshot, itemId: string): ReadonlyArray<string> =>
  Option.match(
    Option.flatMap(findItem(snapshot, itemId), (item) => findSession(snapshot, item.sessionId)),
    {
      onNone: () => [],
      onSome: (session) => [projectNodeId(session.projectId), sessionNodeId(session.id)],
    },
  )

const addExpanded = (expanded: ReadonlyArray<string>, ids: ReadonlyArray<string>) =>
  Arr.dedupe([...expanded, ...ids])

/** Select an item: the single place selection changes, so form/draft state resets cleanly. */
export const selectItem = (
  model: Model,
  itemId: string,
  options: { readonly updateHash: boolean },
): UpdateReturn => {
  const isSame = Option.contains(model.maybeSelectedItemId, itemId)
  const expanded = Option.match(model.maybeSnapshot, {
    onNone: () => model.expandedNodes,
    onSome: (snapshot) => addExpanded(model.expandedNodes, nodesToExpandFor(snapshot, itemId)),
  })
  const next = modifyFields(model, {
    maybeSelectedItemId: () => Option.some(itemId),
    maybeSelectedSessionId: () => Option.none(),
    expandedNodes: () => expanded,
    detail: (detail) =>
      isSame && detail._tag === "Loaded" ? detail : DetailState.Loading({ itemId }),
    maybeForm: (form) => (isSame ? form : Option.none()),
    submission: (submission) => (isSame ? submission : Submission.Idle()),
  })
  const hashCommands: Commands =
    options.updateHash && model.view === "full" ? [SetHash({ hash: hashForItem(itemId) })] : []
  return { model: next, commands: [FetchItemDetail({ itemId }), ...hashCommands] }
}

const selectSession = (model: Model, sessionId: string): UpdateReturn =>
  Option.match(model.maybeSnapshot, {
    onNone: () => ({ model }),
    onSome: (snapshot) =>
      Option.match(firstOpenItemForSession(snapshot, model.itemOrder, sessionId), {
        onSome: (item) => selectItem(model, item.id, { updateHash: true }),
        onNone: () => ({
          model: modifyFields(model, {
            maybeSelectedItemId: () => Option.none(),
            maybeSelectedSessionId: () => Option.some(sessionId),
            detail: () => DetailState.Idle(),
            maybeForm: () => Option.none(),
            submission: () => Submission.Idle(),
          }),
        }),
      }),
  })

const bumpDraft = (model: Model, nextForm: Form): UpdateReturn => {
  const version = model.draftVersion + 1
  return {
    model: modifyFields(model, {
      maybeForm: () => Option.some(nextForm),
      draftVersion: () => version,
    }),
    commands: [WaitBeforeDraftSave({ version })],
  }
}

const updateAnswer = (form: Form, idx: number, f: (answer: AnswerDraft) => AnswerDraft): Form => ({
  ...form,
  answers: form.answers.map((answer) => (answer.idx === idx ? f(answer) : answer)),
})

const isMultiQuestion = (model: Model, idx: number): boolean =>
  Option.match(loadedDetail(model), {
    onNone: () => false,
    onSome: (detail) => detail.questions.find((q) => q.idx === idx)?.multi ?? false,
  })

const toAnswers = (form: Form): ReadonlyArray<Answer> =>
  form.answers.map((answer) => {
    const other = answer.other.trim()
    return other === ""
      ? { idx: answer.idx, selected: answer.selected }
      : { idx: answer.idx, selected: answer.selected, other }
  })

const isSending = (model: Model) => model.submission._tag === "Sending"

const startAction = (model: Model, action: ActionKind) =>
  modifyFields(model, { submission: () => Submission.Sending({ action }) })

const submitAnswers = (model: Model): UpdateReturn =>
  Option.match(Option.all([model.maybeForm, loadedDetail(model)]), {
    onNone: () => ({ model }),
    onSome: ([form, detail]) =>
      isSending(model) || detail.item.kind !== "question" || !areAnswersComplete(form)
        ? { model }
        : {
            model: startAction(model, "answers"),
            commands: [SubmitAnswers({ itemId: form.itemId, answers: toAnswers(form) })],
          },
  })

const sendDecision = (model: Model, decision: Decision): UpdateReturn =>
  Option.match(loadedDetail(model), {
    onNone: () => ({ model }),
    onSome: (detail) =>
      isSending(model) || detail.approval === null
        ? { model }
        : {
            model: startAction(model, "decision"),
            commands: [SendDecision({ itemId: detail.item.id, decision })],
          },
  })

const submitReply = (model: Model): UpdateReturn =>
  Option.match(model.maybeForm, {
    onNone: () => ({ model }),
    onSome: (form) =>
      isSending(model) || form.reply.trim() === ""
        ? { model }
        : {
            model: startAction(model, "reply"),
            commands: [SendReply({ itemId: form.itemId, body: form.reply.trim() })],
          },
  })

/** ⌘↵ means "the primary action of whatever the detail pane shows". */
const submitShortcut = (model: Model): UpdateReturn =>
  Option.match(loadedDetail(model), {
    onNone: () => ({ model }),
    onSome: (detail) => {
      if (detail.item.kind === "question" && detail.questions.length > 0) {
        return submitAnswers(model)
      }
      if (detail.approval !== null) {
        return sendDecision(model, "allow")
      }
      return submitReply(model)
    },
  })

const agentLabel = (detail: ItemDetail, snapshot: Option.Option<Snapshot>): string =>
  Option.getOrElse(
    Option.flatMap(snapshot, (s) =>
      Option.map(
        Arr.findFirst(s.agents, (a) => a.id === detail.item.agentId && a.parentAgentId !== null),
        (a) => a.name,
      ),
    ),
    () => detail.session.title ?? "the session",
  )

type DeliveryToast = { payload: ToastPayload; variant: "Success" | "Error" }

/** Toasts for outbox entries that reached delivered/failed since the last detail we showed. */
export const deliveryToasts = (
  previous: ReadonlyArray<OutboxEntry>,
  next: ReadonlyArray<OutboxEntry>,
  target: string,
): ReadonlyArray<DeliveryToast> =>
  next.flatMap((entry): ReadonlyArray<DeliveryToast> => {
    const before = previous.find((p) => p.id === entry.id)
    if (before === undefined || before.state === entry.state) {
      return []
    }
    if (entry.state === "delivered") {
      return [
        {
          payload: { title: "Delivered", description: `Your reply reached ${target}.` },
          variant: "Success",
        },
      ]
    }
    if (entry.state === "failed") {
      return [
        {
          payload: {
            title: "Delivery failed",
            description: entry.lastError ?? "The reply could not be sent.",
          },
          variant: "Error",
        },
      ]
    }
    return []
  })

const TREE_MOVES: Record<TreeKey, (index: number, length: number) => number> = {
  ArrowUp: (i) => Math.max(0, i - 1),
  ArrowDown: (i, n) => Math.min(n - 1, i + 1),
  Home: () => 0,
  End: (_i, n) => n - 1,
  ArrowLeft: (i) => i,
  ArrowRight: (i) => i,
  Enter: (i) => i,
}

const focusNode = (model: Model, nodeId: string): UpdateReturn => ({
  model: modifyFields(model, { maybeFocusedNode: () => Option.some(nodeId) }),
  commands: [FocusTreeNode({ nodeId })],
})

const activateNode = (model: Model, nodeId: string): UpdateReturn => {
  const [kind, id] = [nodeId.slice(0, 1), nodeId.slice(2)]
  if (kind === "p") {
    return {
      model: modifyFields(model, {
        expandedNodes: (expanded) =>
          expanded.includes(nodeId) ? expanded.filter((n) => n !== nodeId) : [...expanded, nodeId],
      }),
    }
  }
  if (kind === "s") {
    return selectSession(model, id)
  }
  return Option.match(model.maybeSnapshot, {
    onNone: () => ({ model }),
    onSome: (snapshot) => {
      const agent = snapshot.agents.find((a) => a.id === id)
      const item = snapshot.items.find((i) => i.agentId === id && i.queue !== "done")
      if (item !== undefined) {
        return selectItem(model, item.id, { updateHash: true })
      }
      return agent === undefined ? { model } : selectSession(model, agent.sessionId)
    },
  })
}

const pressTreeKey = (model: Model, nodeId: string, key: TreeKey): UpdateReturn =>
  Option.match(model.maybeSnapshot, {
    onNone: () => ({ model }),
    onSome: (snapshot) => {
      const nodes = visibleTreeNodes(snapshot, model.expandedNodes)
      const index = nodes.findIndex((n) => n.id === nodeId)
      const node = nodes[index]
      if (node === undefined) {
        return { model }
      }
      const isExpanded = model.expandedNodes.includes(node.id)
      if (key === "Enter") {
        return activateNode(model, node.id)
      }
      if (key === "ArrowRight" && node.hasChildren) {
        if (!isExpanded) {
          return {
            model: modifyFields(model, { expandedNodes: (e) => [...e, node.id] }),
          }
        }
        const child = nodes[index + 1]
        return child === undefined ? { model } : focusNode(model, child.id)
      }
      if (key === "ArrowLeft") {
        if (isExpanded) {
          return {
            model: modifyFields(model, { expandedNodes: (e) => e.filter((n) => n !== node.id) }),
          }
        }
        return node.parentId === null ? { model } : focusNode(model, node.parentId)
      }
      const target = nodes[TREE_MOVES[key](index, nodes.length)]
      return target === undefined || target.id === node.id ? { model } : focusNode(model, target.id)
    },
  })

const loadSnapshot = (model: Model, snapshot: Snapshot): UpdateReturn => {
  const isFirstLoad = Option.isNone(model.maybeSnapshot)
  const base = modifyFields(model, {
    maybeSnapshot: () => Option.some(snapshot),
    // A fresh snapshot (first load or after reset) takes the daemon's order.
    itemOrder: () => snapshot.items.map((i) => i.id),
    streamEpoch: (epoch) => epoch + 1,
    connection: () => Connection.Live(),
  })
  const expandDefaults = isFirstLoad
    ? addExpanded(
        base.expandedNodes,
        snapshot.projects
          .filter((p) =>
            snapshot.items.some(
              (i) =>
                i.queue === "needs-you" &&
                snapshot.sessions.some((s) => s.id === i.sessionId && s.projectId === p.id),
            ),
          )
          .map((p) => projectNodeId(p.id)),
      )
    : base.expandedNodes
  const withExpanded = modifyFields(base, { expandedNodes: () => expandDefaults })
  return Option.match(withExpanded.maybeSelectedItemId, {
    onSome: (itemId) => ({
      model: modifyFields(withExpanded, {
        expandedNodes: (e) => addExpanded(e, nodesToExpandFor(snapshot, itemId)),
      }),
    }),
    onNone: () => {
      const first = Arr.findFirst(snapshot.items, (i) => i.queue === "needs-you")
      return Option.match(first, {
        onSome: (item) =>
          model.view === "full" && Option.isNone(model.maybeSelectedSessionId)
            ? selectItem(withExpanded, item.id, { updateHash: false })
            : { model: withExpanded },
        onNone: () => ({ model: withExpanded }),
      })
    },
  })
}

const applyDelta = (
  model: Model,
  delta: Extract<Message, { _tag: "ReceivedStreamMessage" }>["message"] & { _tag: "delta" },
): UpdateReturn =>
  Option.match(model.maybeSnapshot, {
    // Deltas before the first snapshot are covered by that snapshot's seq.
    onNone: () => ({ model }),
    onSome: (snapshot) => {
      const next = modifyFields(model, {
        maybeSnapshot: () => Option.some(mergeDelta(snapshot, delta)),
        itemOrder: (order) => extendOrder(order, delta.items),
        connection: () => Connection.Live(),
      })
      const touchesSelection = Option.match(model.maybeSelectedItemId, {
        onNone: () => false,
        onSome: (itemId) => {
          const item = findItem(snapshot, itemId)
          return (
            delta.items.some((i) => i.id === itemId) ||
            Option.match(item, {
              onNone: () => false,
              onSome: (i) => delta.sessions.some((s) => s.id === i.sessionId),
            })
          )
        },
      })
      return touchesSelection
        ? {
            model: next,
            commands: Option.match(model.maybeSelectedItemId, {
              onNone: () => [],
              onSome: (itemId) => [FetchItemDetail({ itemId })],
            }),
          }
        : { model: next }
    },
  })

const actionToast = (action: ActionKind): ToastPayload | null => {
  if (action === "answers") {
    return { title: "Answers sent", description: "Delivery status shows under Delivery." }
  }
  if (action === "reply") {
    return { title: "Reply queued", description: "It goes out when the session is idle." }
  }
  if (action === "decision") {
    return { title: "Decision sent", description: "Claude has your answer." }
  }
  if (action === "snooze") {
    return { title: "Snoozed", description: "It comes back to Needs you when the snooze ends." }
  }
  return null
}

const handleSnoozeSelection = (model: Model, action: SnoozeAction): UpdateReturn =>
  Option.match(loadedDetail(model), {
    onNone: () => ({ model }),
    onSome: (detail) => {
      const itemId = detail.item.id
      const sending = (kind: ActionKind, commands: Commands): UpdateReturn => ({
        model: startAction(model, kind),
        commands,
      })
      if (action === "snooze-15m") {
        return sending("snooze", [SnoozeItem({ itemId, preset: "15m" })])
      }
      if (action === "snooze-1h") {
        return sending("snooze", [SnoozeItem({ itemId, preset: "1h" })])
      }
      if (action === "snooze-tomorrow") {
        return sending("snooze", [SnoozeItem({ itemId, preset: "tomorrow" })])
      }
      if (action === "dismiss") {
        return sending("dismiss", [DismissItem({ itemId })])
      }
      return sending("mute", [
        MuteProject({ itemId, projectId: detail.project.id, muted: !detail.project.muted }),
      ])
    },
  })

const openJumpDialog = (model: Model): UpdateReturn => {
  const opened = lift(
    Dialog.open(model.jumpDialog),
    (jumpDialog) => modifyFields(model, { jumpDialog: () => jumpDialog }),
    (message) => Message.GotJumpDialogMessage({ message }),
  )
  return { model: opened.model, commands: opened.commands }
}

// UPDATE

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchSnapshot: ({ snapshot }) => loadSnapshot(model, snapshot),

    FailedFetchSnapshot: ({ error }) => ({
      model: modifyFields(model, { connection: () => Connection.Offline({ error }) }),
      commands: [WaitBeforeSnapshotRetry()],
    }),

    CompletedWaitBeforeSnapshotRetry: () => ({ model, commands: [FetchSnapshot()] }),

    ReceivedStreamMessage: ({ message: streamMessage }) => {
      if (streamMessage._tag === "hello") {
        return { model: modifyFields(model, { connection: () => Connection.Live() }) }
      }
      if (streamMessage._tag === "delta") {
        return applyDelta(model, streamMessage)
      }
      if (streamMessage._tag === "reset") {
        return { model, commands: [FetchSnapshot()] }
      }
      // notify/badge are for the shell (G-012).
      return { model }
    },

    DisconnectedStream: ({ error }) => ({
      model: modifyFields(model, { connection: () => Connection.Offline({ error }) }),
    }),

    SucceededFetchItemDetail: ({ detail }) => {
      if (!Option.contains(model.maybeSelectedItemId, detail.item.id)) {
        return { model }
      }
      const previous = loadedDetail(model).pipe(Option.filter((d) => d.item.id === detail.item.id))
      const keepForm = Option.exists(model.maybeForm, (form) => form.itemId === detail.item.id)
      const next = modifyFields(model, {
        detail: () => DetailState.Loaded({ detail }),
        maybeForm: (form) => (keepForm ? form : Option.some(formFromDetail(detail))),
      })
      const readCommands: Commands =
        !keepForm && detail.item.unread ? [MarkRead({ itemId: detail.item.id })] : []
      const toasts = Option.match(previous, {
        onNone: () => [],
        onSome: (prev) =>
          deliveryToasts(prev.outbox, detail.outbox, agentLabel(detail, model.maybeSnapshot)),
      })
      return showToasts({ model: next, commands: readCommands }, toasts)
    },

    FailedFetchItemDetail: ({ itemId, error }) =>
      Option.contains(model.maybeSelectedItemId, itemId) && model.detail._tag !== "Loaded"
        ? { model: modifyFields(model, { detail: () => DetailState.Failed({ itemId, error }) }) }
        : { model },

    ClickedItem: ({ itemId }) => selectItem(model, itemId, { updateHash: true }),

    ClickedSession: ({ sessionId }) =>
      selectSession(
        modifyFields(model, { maybeFocusedNode: () => Option.some(sessionNodeId(sessionId)) }),
        sessionId,
      ),

    ChangedHash: ({ hash }) =>
      Option.match(itemIdFromHash(hash), {
        onNone: () => ({ model }),
        onSome: (itemId) =>
          Option.contains(model.maybeSelectedItemId, itemId)
            ? { model }
            : selectItem(model, itemId, { updateHash: false }),
      }),

    SelectedQueueTab: ({ tab }) => ({ model: modifyFields(model, { queueTab: () => tab }) }),

    ToggledTreeNode: ({ nodeId }) => ({
      model: modifyFields(model, {
        maybeFocusedNode: () => Option.some(nodeId),
        expandedNodes: (expanded) =>
          expanded.includes(nodeId) ? expanded.filter((n) => n !== nodeId) : [...expanded, nodeId],
      }),
    }),

    PressedTreeKey: ({ nodeId, key }) => pressTreeKey(model, nodeId, key),

    ClickedTreeNode: ({ nodeId }) =>
      activateNode(modifyFields(model, { maybeFocusedNode: () => Option.some(nodeId) }), nodeId),

    GotRadioGroupMessage: ({ idx, message: radioMessage }) =>
      Option.match(model.maybeForm, {
        onNone: () => ({ model }),
        onSome: (form) => {
          const group = form.radioGroups[form.answers.findIndex((a) => a.idx === idx)]
          if (group === undefined) {
            return { model }
          }
          const position = form.answers.findIndex((a) => a.idx === idx)
          const lifted = lift(
            QuestionRadioGroup.update(group, radioMessage),
            (nextGroup) =>
              modifyFields(model, {
                maybeForm: () =>
                  Option.some({
                    ...form,
                    radioGroups: form.radioGroups.map((g, i) => (i === position ? nextGroup : g)),
                  }),
              }),
            (child) => Message.GotRadioGroupMessage({ idx, message: child }),
          )
          if (lifted.outMessage === undefined) {
            return { model: lifted.model, commands: lifted.commands }
          }
          const selected = lifted.outMessage.value
          const nextForm = Option.getOrElse(lifted.model.maybeForm, () => form)
          return withCommands(
            bumpDraft(
              lifted.model,
              updateAnswer(nextForm, idx, (answer) => ({
                ...answer,
                selected: [selected],
                other: "",
              })),
            ),
            lifted.commands,
          )
        },
      }),

    ToggledOption: ({ idx, label, isChecked }) =>
      Option.match(model.maybeForm, {
        onNone: () => ({ model }),
        onSome: (form) =>
          bumpDraft(
            model,
            updateAnswer(form, idx, (answer) => ({
              ...answer,
              selected: isChecked
                ? Arr.dedupe([...answer.selected, label])
                : answer.selected.filter((s) => s !== label),
            })),
          ),
      }),

    UpdatedOther: ({ idx, value }) =>
      Option.match(model.maybeForm, {
        onNone: () => ({ model }),
        onSome: (form) => {
          const isMulti = isMultiQuestion(model, idx)
          return bumpDraft(
            model,
            updateAnswer(form, idx, (answer) => ({
              ...answer,
              other: value,
              // Single choice: typing your own answer replaces the picked option.
              selected: isMulti || value.trim() === "" ? answer.selected : [],
            })),
          )
        },
      }),

    UpdatedReply: ({ value }) =>
      Option.match(model.maybeForm, {
        onNone: () => ({ model }),
        onSome: (form) => bumpDraft(model, { ...form, reply: value }),
      }),

    CompletedWaitBeforeDraftSave: ({ version }) =>
      Option.match(model.maybeForm, {
        onNone: () => ({ model }),
        onSome: (form) =>
          version === model.draftVersion
            ? { model, commands: [SaveDraft({ itemId: form.itemId, body: draftBody(form) })] }
            : { model },
      }),

    CompletedSaveDraft: () => ({ model }),

    SubmittedAnswers: () => submitAnswers(model),
    PressedSubmitShortcut: () => submitShortcut(model),
    ClickedDecision: ({ decision }) => sendDecision(model, decision),
    PressedDenyShortcut: () =>
      Option.exists(loadedDetail(model), (d) => d.approval !== null)
        ? sendDecision(model, "deny")
        : { model },
    SubmittedReply: () => submitReply(model),

    SucceededAction: ({ action, itemId, response }) => {
      const withItem = modifyFields(model, {
        submission: () => Submission.Idle(),
        maybeSnapshot: (maybeSnapshot) =>
          Option.map(maybeSnapshot, (snapshot) =>
            response.item === null
              ? snapshot
              : {
                  ...snapshot,
                  items: snapshot.items.map((i) => (i.id === itemId ? (response.item ?? i) : i)),
                },
          ),
        maybeForm: (maybeForm) =>
          action === "reply"
            ? Option.map(maybeForm, (form) => ({ ...form, reply: "" }))
            : maybeForm,
      })
      const refetch: Commands = Option.contains(model.maybeSelectedItemId, itemId)
        ? [FetchItemDetail({ itemId })]
        : []
      const toast = actionToast(action)
      const base: UpdateReturn = { model: withItem, commands: refetch }
      return toast === null ? base : showToasts(base, [{ payload: toast, variant: "Success" }])
    },

    FailedAction: ({ action, error }) =>
      showToasts(
        { model: modifyFields(model, { submission: () => Submission.Failed({ action, error }) }) },
        [{ payload: { title: "Couldn't reach the daemon", description: error }, variant: "Error" }],
      ),

    ClickedOpenInClaude: () =>
      Option.match(model.maybeSelectedItemId, {
        onNone: () => ({ model }),
        onSome: (itemId) => ({ model, commands: [OpenInClaude({ itemId })] }),
      }),

    SucceededOpenInClaude: ({ url }) =>
      showToasts({ model }, [
        {
          payload:
            url === null
              ? {
                  title: "Resume command copied",
                  description: "Paste it in a terminal to continue.",
                }
              : { title: "Opened in Claude", description: "The session is in front of you." },
          variant: "Info",
        },
      ]),

    PressedJumpShortcut: () => openJumpDialog(model),
    ClickedJumpField: () => openJumpDialog(model),

    GotSnoozeMenuMessage: ({ message: menuMessage }) => {
      const lifted = lift(
        SnoozeMenu.update(model.snoozeMenu, menuMessage),
        (snoozeMenu) => modifyFields(model, { snoozeMenu: () => snoozeMenu }),
        (child) => Message.GotSnoozeMenuMessage({ message: child }),
      )
      return lifted.outMessage === undefined
        ? { model: lifted.model, commands: lifted.commands }
        : withCommands(
            handleSnoozeSelection(lifted.model, lifted.outMessage.value),
            lifted.commands,
          )
    },

    GotJumpDialogMessage: ({ message: dialogMessage }) => {
      const lifted = lift(
        Dialog.update(model.jumpDialog, dialogMessage),
        (jumpDialog) => modifyFields(model, { jumpDialog: () => jumpDialog }),
        (child) => Message.GotJumpDialogMessage({ message: child }),
      )
      return { model: lifted.model, commands: lifted.commands }
    },

    GotJumpComboboxMessage: ({ message: comboboxMessage }) => {
      const lifted = lift(
        SessionCombobox.update(model.jumpCombobox, comboboxMessage),
        (jumpCombobox) => modifyFields(model, { jumpCombobox: () => jumpCombobox }),
        (child) => Message.GotJumpComboboxMessage({ message: child }),
      )
      if (lifted.outMessage === undefined || lifted.outMessage._tag !== "Selected") {
        return { model: lifted.model, commands: lifted.commands }
      }
      const sessionId = lifted.outMessage.value
      const closed = lift(
        Dialog.close(lifted.model.jumpDialog),
        (jumpDialog) =>
          modifyFields(lifted.model, {
            jumpDialog: () => jumpDialog,
            jumpCombobox: (c) => ({ ...c, inputValue: "" }),
          }),
        (child) => Message.GotJumpDialogMessage({ message: child }),
      )
      return withCommands(selectSession(closed.model, sessionId), [
        ...lifted.commands,
        ...closed.commands,
      ])
    },

    GotToastMessage: ({ message: toastMessage }) => {
      const lifted = lift(
        Toast.update(model.toasts, toastMessage),
        (toasts) => modifyFields(model, { toasts: () => toasts }),
        (child) => Message.GotToastMessage({ message: child }),
      )
      return { model: lifted.model, commands: lifted.commands }
    },

    CompletedMarkRead: () => ({ model }),
    CompletedSetHash: () => ({ model }),
    CompletedFocusTreeNode: () => ({ model }),
    TickedClock: ({ now }) => ({ model: modifyFields(model, { now: () => now }) }),
  })
