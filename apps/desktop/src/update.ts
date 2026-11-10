import { Combobox, Dialog, Menu, RadioGroup } from "@foldkit/ui"
import {
  type Answer,
  type AttentionKind,
  type Decision,
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
  type ItemDetail,
  type OutboxEntry,
  type Snapshot,
  type StreamMessage,
  type UpdateStatus,
} from "@session-inbox/contracts"
import { Array as Arr, Option, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import type { DaemonClient } from "./client/daemonClient.ts"
import {
  ApplyUpdate,
  CheckForUpdates,
  CopyFix,
  DismissItem,
  FetchDoctor,
  FetchHistory,
  FetchItemDetail,
  FetchSnapshot,
  FocusTreeNode,
  MarkRead,
  MuteProject,
  OpenInClaude,
  ReloadPage,
  SaveDraft,
  ScrollToRow,
  SendDecision,
  SendDenyNote,
  SendReply,
  SendTestNotification,
  SetHash,
  SnoozeItem,
  SubmitAnswers,
  WaitBeforeDraftSave,
  WaitBeforeHistorySearch,
  WaitBeforeSnapshotRetry,
  WaitCopied,
} from "./command.ts"
import {
  type ListDirection,
  Message,
  type ShortcutTyping,
  type SnoozeAction,
  type TreeKey,
} from "./message.ts"
import {
  type ActionKind,
  type AnswerDraft,
  AppView,
  Connection,
  DetailState,
  DoctorState,
  type Form,
  type HistoryModel,
  HistoryResults,
  type Model,
  type QueueTab,
  type Route,
  Submission,
} from "./model.ts"
import {
  agentDisplayName,
  answersUnavailable,
  areAnswersComplete,
  draftBody,
  extendOrder,
  findItem,
  findSession,
  firstOpenItemForSession,
  formFromDetail,
  hashForHistoryItem,
  hashForItem,
  historyEntries,
  itemRowId,
  itemsInQueue,
  mergeDelta,
  nextInTab,
  projectNodeId,
  routeFromHash,
  SETUP_HASH,
  sessionNodeId,
  sessionRowId,
  stepThrough,
  visibleTreeNodes,
  workingSessions,
} from "./selectors.ts"
import { initSettings, SettingsMessage, updateSettings } from "./settings.ts"
import { Toast, type ToastPayload } from "./toast.ts"

export type UpdateReturn = Update.Return<Model, Message, DaemonClient>
type Commands = NonNullable<UpdateReturn["commands"]>

// FLAGS / INIT

export const Flags = Schema.Struct({
  view: AppView,
  now: Schema.Number,
  maybeInitialItemId: Schema.Option(Schema.String),
  /** From the boot hash: `#/setup` opens Setup, `#/update` checks for updates (U-034). */
  initialRoute: Schema.optional(
    Schema.Literals(["inbox", "setup", "update", "settings", "history"]),
  ),
})
export type Flags = typeof Flags.Type

export const SessionCombobox = Combobox.create<string>()
export const SnoozeMenu = Menu.create<SnoozeAction>()
export const QuestionRadioGroup = RadioGroup.create<string>()

/** Closed, empty, nothing highlighted: the first ArrowDown lands on the first result (U-020). */
const freshJumpCombobox = (): Combobox.Model => Combobox.init({ id: "jump-combobox" })

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
  isPreviewExpanded: false,
  draftVersion: 0,
  submission: Submission.Idle(),
  jumpDialog: Dialog.init({
    id: "jump-dialog",
    focusSelector: `#${Combobox.inputId("jump-combobox")}`,
  }),
  jumpCombobox: freshJumpCombobox(),
  snoozeMenu: Menu.init({ id: "snooze-menu" }),
  shortcutsDialog: Dialog.init({ id: "shortcuts-dialog" }),
  toasts: Toast.init({ id: "toasts", defaultDuration: "4 seconds" }),
  settings: initSettings(),
  maybeUpdate: Option.none(),
  maybeDaemonBuild: Option.none(),
  maybeDismissedUpdate: Option.none(),
  updateRequest: flags.initialRoute === "update" ? "Checking" : "Idle",
  route:
    flags.view !== "full"
      ? "inbox"
      : flags.initialRoute === "setup"
        ? "setup"
        : flags.initialRoute === "history"
          ? "history"
          : "inbox",
  doctor: DoctorState.Unknown(),
  isDoctorLoading: false,
  maybeCopiedFix: Option.none(),
  isTestNotifying: false,
  isLastMessageExpanded: false,
  maybeReplyError: Option.none(),
  denyNote: "",
  maybeAdvanceFrom: Option.none(),
  history: initialHistory,
})

export const initialHistory: HistoryModel = {
  query: "",
  kind: null,
  queryVersion: 0,
  requestId: 0,
  pending: "none",
  results: HistoryResults.Idle(),
  maybeInboxItemId: Option.none(),
}

export const init = (flags: Flags): UpdateReturn => {
  // `#/settings` at boot: the inbox with the Settings dialog open (U-041). `#/history[/<id>]`:
  // History, fetching its first page (U-052).
  const opened =
    flags.view === "full" && flags.initialRoute === "settings"
      ? liftSettings(initialModel(flags), SettingsMessage.RequestedOpen())
      : flags.view === "full" && flags.initialRoute === "history"
        ? fetchHistoryFirstPage(initialModel(flags), { keepCount: false })
        : { model: initialModel(flags) }
  const model = opened.model
  // The doctor report itself comes with every stream `hello` (U-034).
  const routeCommands: Commands =
    flags.view !== "full"
      ? []
      : flags.initialRoute === "update"
        ? [CheckForUpdates(), SetHash({ hash: "#/" })]
        : flags.initialRoute === "settings"
          ? [...(opened.commands ?? []), SetHash({ hash: "#/" })]
          : flags.initialRoute === "history"
            ? (opened.commands ?? [])
            : []
  return {
    model,
    commands: [
      FetchSnapshot(),
      ...Option.match(flags.maybeInitialItemId, {
        onNone: () => [],
        onSome: (itemId) => [FetchItemDetail({ itemId })],
      }),
      ...routeCommands,
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
  options: { readonly updateHash: boolean; readonly route?: Route },
): UpdateReturn => {
  const isSame = Option.contains(model.maybeSelectedItemId, itemId)
  // Picking an item is a user intent: it leaves Setup or History for the inbox, unless the
  // caller names the route (a History pick stays in History, U-052). Boot/hash picks don't.
  const route: Route = options.route ?? (options.updateHash ? "inbox" : model.route)
  const expanded = Option.match(route === "history" ? Option.none() : model.maybeSnapshot, {
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
    isPreviewExpanded: (expanded) => isSame && expanded,
    isLastMessageExpanded: (expanded) => isSame && expanded,
    maybeReplyError: (error) => (isSame ? error : Option.none()),
    submission: (submission) => (isSame ? submission : Submission.Idle()),
    denyNote: (note) => (isSame ? note : ""),
    maybeAdvanceFrom: (from) => (isSame ? from : Option.none()),
    route: () => route,
  })
  const hash = route === "history" ? hashForHistoryItem(itemId) : hashForItem(itemId)
  const hashCommands: Commands =
    options.updateHash && model.view === "full" ? [SetHash({ hash })] : []
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
            maybeReplyError: () => Option.none(),
            denyNote: () => "",
            maybeAdvanceFrom: () => Option.none(),
            route: () => "inbox",
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

/** The actions after which the selection moves on to the next item (U-059); never a reply. */
const ADVANCING: ReadonlyArray<ActionKind> = ["answers", "decision", "dismiss", "snooze"]

/** The selected item, when it is one of the rows of the queue tab on screen. */
const selectedInShownTab = (model: Model): Option.Option<string> =>
  model.view !== "full" || model.route !== "inbox" || model.queueTab === "working"
    ? Option.none()
    : Option.flatMap(model.maybeSnapshot, (snapshot) =>
        Option.filter(model.maybeSelectedItemId, (itemId) =>
          itemsInQueue(
            snapshot,
            model.itemOrder,
            model.queueTab as Exclude<QueueTab, "working">,
          ).some((i) => i.id === itemId),
        ),
      )

const startAction = (model: Model, action: ActionKind) =>
  modifyFields(model, {
    submission: () => Submission.Sending({ action }),
    maybeAdvanceFrom: () =>
      ADVANCING.includes(action) ? selectedInShownTab(model) : Option.none(),
  })

const submitAnswers = (model: Model): UpdateReturn =>
  Option.match(Option.all([model.maybeForm, loadedDetail(model)]), {
    onNone: () => ({ model }),
    onSome: ([form, detail]) =>
      isSending(model) ||
      detail.item.kind !== "question" ||
      !areAnswersComplete(form) ||
      answersUnavailable(detail) !== null
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
      isSending(model) ||
      form.reply.trim() === "" ||
      Option.exists(loadedDetail(model), (d) => d.replyUnavailable !== undefined)
        ? { model }
        : {
            model: startAction(model, "reply"),
            commands: [SendReply({ itemId: form.itemId, body: form.reply.trim() })],
          },
  })

/** Settings, ⌘K or the snooze menu is over the detail pane: its shortcuts must not reach it. */
export const isOverlayOpen = (model: Model): boolean =>
  model.settings.dialog.isOpen ||
  model.jumpDialog.isOpen ||
  model.snoozeMenu.isOpen ||
  model.shortcutsDialog.isOpen

/**
 * The detail pane's shortcuts apply only when it's what the person is looking at: on the inbox
 * with nothing open over it (U-046).
 */
const detailHasKeys = (model: Model): boolean => model.route === "inbox" && !isOverlayOpen(model)

/**
 * ⌘↵ means "the primary action of whatever the detail pane shows". In a text field it counts
 * only when that field is the detail's own form (reply box, a question's Other), never the
 * jump box or a settings field (U-046).
 */
const submitShortcut = (model: Model, typing: ShortcutTyping): UpdateReturn =>
  Option.match(
    !detailHasKeys(model) || typing === "elsewhere" ? Option.none() : loadedDetail(model),
    {
      onNone: () => ({ model }),
      onSome: (detail) => {
        if (detail.item.kind === "question" && detail.questions.length > 0) {
          return submitAnswers(model)
        }
        if (detail.approval !== null) {
          // Not held: Claude's own prompt is answered in Claude, not here (U-043).
          return detail.item.live ? sendDecision(model, "allow") : { model }
        }
        return submitReply(model)
      },
    },
  )

/**
 * Deny, with the note beside the button when there is one (U-063). A note goes through the reply
 * intent: for a live hold the daemon denies with the text as the reason. Not live: no decision.
 */
const denyWithNote = (model: Model): UpdateReturn => {
  const note = model.denyNote.trim()
  if (note === "") {
    return sendDecision(model, "deny")
  }
  return Option.match(loadedDetail(model), {
    onNone: () => ({ model }),
    onSome: (detail) =>
      isSending(model) ||
      detail.approval === null ||
      detail.approval.decision !== null ||
      !detail.item.live ||
      detail.item.queue === "done"
        ? { model }
        : {
            model: startAction(model, "decision"),
            commands: [SendDenyNote({ itemId: detail.item.id, body: note })],
          },
  })
}

/** A review or failed item still open: Done (the dismiss intent) clears it (U-061). */
export const canMarkDone = (detail: ItemDetail): boolean =>
  (detail.item.kind === "review" || detail.item.kind === "failed") && detail.item.queue !== "done"

const markDone = (model: Model): UpdateReturn =>
  Option.match(loadedDetail(model), {
    onNone: () => ({ model }),
    onSome: (detail) =>
      isSending(model) || !canMarkDone(detail)
        ? { model }
        : {
            model: startAction(model, "dismiss"),
            commands: [DismissItem({ itemId: detail.item.id })],
          },
  })

/**
 * `j` / `k` (U-060): the next or previous row of the list on screen. The inbox: the queue tab's
 * items, or in Working its sessions. History: its entries. The row is scrolled into view.
 */
const stepList = (model: Model, direction: ListDirection): UpdateReturn => {
  if (model.view !== "full" || isOverlayOpen(model)) {
    return { model }
  }
  if (model.route === "history") {
    const ids = historyEntries(model.history.results).map((e) => e.item.id)
    return Option.match(stepThrough(ids, model.maybeSelectedItemId, direction), {
      onNone: () => ({ model }),
      onSome: (itemId) =>
        Option.contains(model.maybeSelectedItemId, itemId)
          ? { model }
          : withCommands(selectItem(model, itemId, { updateHash: true, route: "history" }), [
              ScrollToRow({ rowId: itemRowId(itemId) }),
            ]),
    })
  }
  if (model.route !== "inbox") {
    return { model }
  }
  return Option.match(model.maybeSnapshot, {
    onNone: () => ({ model }),
    onSome: (snapshot) => {
      if (model.queueTab === "working") {
        const ids = workingSessions(snapshot).map((s) => s.id)
        const current = Option.orElse(model.maybeSelectedSessionId, () =>
          Option.flatMap(model.maybeSelectedItemId, (itemId) =>
            Option.map(findItem(snapshot, itemId), (i) => i.sessionId),
          ),
        )
        return Option.match(stepThrough(ids, current, direction), {
          onNone: () => ({ model }),
          onSome: (sessionId) =>
            Option.contains(current, sessionId)
              ? { model }
              : withCommands(
                  selectSession(
                    modifyFields(model, {
                      maybeFocusedNode: () => Option.some(sessionNodeId(sessionId)),
                    }),
                    sessionId,
                  ),
                  [ScrollToRow({ rowId: sessionRowId(sessionId) })],
                ),
        })
      }
      const ids = itemsInQueue(snapshot, model.itemOrder, model.queueTab).map((i) => i.id)
      return Option.match(stepThrough(ids, model.maybeSelectedItemId, direction), {
        onNone: () => ({ model }),
        onSome: (itemId) =>
          Option.contains(model.maybeSelectedItemId, itemId)
            ? { model }
            : withCommands(selectItem(model, itemId, { updateHash: true }), [
                ScrollToRow({ rowId: itemRowId(itemId) }),
              ]),
      })
    },
  })
}

/** After the selected item left the tab on screen, select the one that took its place (U-059). */
const advanceAfter = (model: Model, action: ActionKind, itemId: string): Option.Option<string> =>
  !ADVANCING.includes(action) ||
  !Option.contains(model.maybeAdvanceFrom, itemId) ||
  !Option.contains(model.maybeSelectedItemId, itemId) ||
  model.view !== "full" ||
  model.route !== "inbox" ||
  model.queueTab === "working"
    ? Option.none()
    : Option.flatMap(model.maybeSnapshot, (snapshot) =>
        itemsInQueue(
          snapshot,
          model.itemOrder,
          model.queueTab as Exclude<QueueTab, "working">,
        ).some((i) => i.id === itemId)
          ? Option.none()
          : nextInTab(snapshot, model.itemOrder, model.queueTab, itemId),
      )

/** A popover row's Allow or Deny (U-062): no selection, one decision at a time. */
const decideRow = (model: Model, itemId: string, decision: Decision): UpdateReturn =>
  isSending(model) || (decision !== "allow" && decision !== "deny")
    ? { model }
    : {
        model: modifyFields(model, {
          submission: () => Submission.Sending({ action: "decision" }),
        }),
        commands: [SendDecision({ itemId, decision })],
      }

const liftShortcutsDialog = (
  model: Model,
  result: ChildResult<Dialog.Model, Dialog.Message, Dialog.OutMessage>,
): UpdateReturn => {
  const lifted = lift(
    result,
    (shortcutsDialog) => modifyFields(model, { shortcutsDialog: () => shortcutsDialog }),
    (message) => Message.GotShortcutsDialogMessage({ message }),
  )
  return { model: lifted.model, commands: lifted.commands }
}

/** `?` or the nav's Shortcuts entry: the list of shortcuts (U-073). */
const openShortcuts = (model: Model): UpdateReturn =>
  model.view !== "full" || isOverlayOpen(model)
    ? { model }
    : liftShortcutsDialog(model, Dialog.open(model.shortcutsDialog))

const agentLabel = (detail: ItemDetail, snapshot: Option.Option<Snapshot>): string =>
  Option.getOrElse(
    Option.flatMap(snapshot, (s) =>
      Option.map(
        Arr.findFirst(s.agents, (a) => a.id === detail.item.agentId && a.parentAgentId !== null),
        agentDisplayName,
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
          model.view === "full" &&
          model.route !== "history" &&
          Option.isNone(model.maybeSelectedSessionId)
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
  // A combobox left open (dialog dismissed while its list was showing) kept its old
  // highlight, so the next ArrowDown moved on from that row. Start every open from scratch.
  const wasOpen = model.jumpDialog.isOpen
  const opened = lift(
    Dialog.open(model.jumpDialog),
    (jumpDialog) =>
      modifyFields(model, {
        jumpDialog: () => jumpDialog,
        jumpCombobox: (c) => (wasOpen ? c : freshJumpCombobox()),
      }),
    (message) => Message.GotJumpDialogMessage({ message }),
  )
  return { model: opened.model, commands: opened.commands }
}

// UPDATES (U-022..U-024): render the daemon's status, send intents, reload on a new build.

type Hello = Extract<StreamMessage, { _tag: "hello" }>

/** `version·build` the daemon reported, if it reports one (older daemons don't). */
export const daemonBuildKey = (hello: Hello): Option.Option<string> =>
  hello.version === undefined && hello.build === undefined
    ? Option.none()
    : Option.some(`${hello.version ?? "?"}·${hello.build ?? "?"}`)

/** Remember the first build; a reconnect to a different one reloads the page. */
const onHello = (model: Model, hello: Hello): UpdateReturn =>
  Option.match(daemonBuildKey(hello), {
    onNone: () => ({ model }),
    onSome: (key) =>
      Option.match(model.maybeDaemonBuild, {
        onNone: () => ({
          model: modifyFields(model, { maybeDaemonBuild: () => Option.some(key) }),
        }),
        onSome: (seen) => (seen === key ? { model } : { model, commands: [ReloadPage()] }),
      }),
  })

/** Banner identity: dismissing hides this state/version only. */
export const updateBannerKey = (status: UpdateStatus): string =>
  `${status.state}:${status.latest ?? status.target ?? ""}`

/** "Updated" toast window after a restart into a new version. */
const UPDATED_TOAST_MS = 10 * 60_000

const receiveUpdate = (model: Model, status: UpdateStatus): UpdateReturn => {
  const isFirst = Option.isNone(model.maybeUpdate)
  const next = modifyFields(model, { maybeUpdate: () => Option.some(status) })
  const justUpdated =
    isFirst &&
    status.updatedAt !== null &&
    Math.abs(model.now - status.updatedAt) < UPDATED_TOAST_MS
  return justUpdated
    ? showToast(
        next,
        {
          title: `Session Inbox updated to ${status.current}`,
          description:
            status.justUpdatedFrom === null ? "" : `You were on ${status.justUpdatedFrom}.`,
        },
        "Success",
      )
    : { model: next }
}

const updateRequestDone = (model: Model, status: UpdateStatus): UpdateReturn => {
  const wasChecking = model.updateRequest === "Checking"
  const received = receiveUpdate(
    modifyFields(model, {
      updateRequest: () => "Idle",
      // An explicit check shows its result even if the banner was dismissed.
      maybeDismissedUpdate: (d) => (wasChecking ? Option.none() : d),
    }),
    status,
  )
  if (!wasChecking || status.state === "available" || status.state === "failed") {
    return received
  }
  const ret = status.error
    ? showToast(
        received.model,
        { title: "Couldn't check for updates", description: status.error },
        "Error",
      )
    : showToast(
        received.model,
        { title: "Session Inbox is up to date", description: `You have ${status.current}.` },
        "Info",
      )
  return withCommands(ret, received.commands ?? [])
}

const checkForUpdates = (model: Model): UpdateReturn =>
  model.updateRequest !== "Idle"
    ? { model }
    : {
        model: modifyFields(model, { updateRequest: () => "Checking" }),
        commands: [CheckForUpdates()],
      }

// SETUP CHECK (U-034): render the daemon's DoctorReport; refetch on hello, `doctor`, open.

const fetchDoctor = (model: Model): UpdateReturn => ({
  model: modifyFields(model, { isDoctorLoading: () => true }),
  commands: [FetchDoctor()],
})

const liftSettings = (model: Model, message: SettingsMessage): UpdateReturn => {
  const next = updateSettings(model.settings, message)
  return {
    model: modifyFields(model, { settings: () => next.model }),
    commands: Command.mapMessages(next.commands, (child) =>
      Message.GotSettingsMessage({ message: child }),
    ),
  }
}

const selectedHash = (model: Model): string =>
  Option.match(model.maybeSelectedItemId, { onNone: () => "#/", onSome: hashForItem })

/** Show the Setup panel: closes Settings (its footer links here) and refetches the report. */
const openSetup = (model: Model, hash: string): UpdateReturn => {
  const routed = modifyFields(model, { route: () => "setup" })
  const closed = routed.settings.dialog.isOpen
    ? liftSettings(routed, SettingsMessage.RequestedClose())
    : { model: routed }
  const fetched = fetchDoctor(closed.model)
  return {
    model: fetched.model,
    commands: [
      ...(closed.commands ?? []),
      ...(fetched.commands ?? []),
      // `#/item/setup` (a test-notification click) settles on `#/setup`.
      ...(hash === SETUP_HASH ? [] : [SetHash({ hash: SETUP_HASH })]),
    ],
  }
}

const changeHash = (model: Model, hash: string): UpdateReturn => {
  const route = routeFromHash(hash)
  if (route._tag === "history") {
    return model.view === "full" ? enterHistory(model, route.itemId) : { model }
  }
  // Leaving History hands the inbox its own selection back first (U-054).
  const wasHistory = model.route === "history"
  const left = route._tag === "item" ? { model } : leaveHistory(model)
  return withCommands(changeInboxHash(left.model, hash, wasHistory), left.commands ?? [])
}

const changeInboxHash = (model: Model, hash: string, wasHistory: boolean): UpdateReturn => {
  const route = routeFromHash(hash)
  const toInbox = modifyFields(model, { route: () => "inbox" })
  switch (route._tag) {
    case "history":
      return { model }
    case "setup":
      return model.view === "full" ? openSetup(model, hash) : { model }
    case "update":
      // The tray's "Check for Updates…": the main view, with a check running.
      return withCommands(checkForUpdates(toInbox), [SetHash({ hash: selectedHash(model) })])
    case "settings":
      // The tray's "Settings…": the main view with the dialog open, hash put back (U-041).
      return model.view === "full"
        ? withCommands(liftSettings(toInbox, SettingsMessage.RequestedOpen()), [
            SetHash({ hash: selectedHash(model) }),
          ])
        : { model }
    case "item":
      return Option.contains(model.maybeSelectedItemId, route.itemId)
        ? { model: toInbox }
        : selectItem(toInbox, route.itemId, { updateHash: false })
    case "inbox":
      return (model.route === "setup" || wasHistory) && Option.isSome(model.maybeSelectedItemId)
        ? { model: toInbox, commands: [SetHash({ hash: selectedHash(model) })] }
        : { model: toInbox }
  }
}

// HISTORY (U-052..U-056): finished items as the daemon lists them (C-027).

const withHistory = (model: Model, f: (history: HistoryModel) => HistoryModel): Model =>
  modifyFields(model, { history: f })

/**
 * Fetch the first page for the current query and kind. Any request in flight is superseded.
 * `keepCount`: a refetch (a delta, a reconnect) asks for as many entries as are shown, so a
 * list grown by "Load more" doesn't shrink under the person (U-055).
 */
export const fetchHistoryFirstPage = (
  model: Model,
  options: { readonly keepCount: boolean },
): UpdateReturn => {
  const shown = model.history.results._tag === "Loaded" ? model.history.results.entries.length : 0
  const limit =
    options.keepCount && shown > HISTORY_LIMIT_DEFAULT ? Math.min(shown, HISTORY_LIMIT_MAX) : null
  const requestId = model.history.requestId + 1
  return {
    model: withHistory(model, (history) => ({ ...history, requestId, pending: "first" })),
    commands: [
      FetchHistory({
        requestId,
        q: model.history.query.trim(),
        kind: model.history.kind,
        before: null,
        limit,
        append: false,
      }),
    ],
  }
}

const loadMoreHistory = (model: Model): UpdateReturn => {
  const results = model.history.results
  if (
    model.history.pending !== "none" ||
    results._tag !== "Loaded" ||
    results.nextBefore === null
  ) {
    return { model }
  }
  const requestId = model.history.requestId + 1
  return {
    model: withHistory(model, (history) => ({ ...history, requestId, pending: "more" })),
    commands: [
      FetchHistory({
        requestId,
        q: model.history.query.trim(),
        kind: model.history.kind,
        before: results.nextBefore,
        limit: null,
        append: true,
      }),
    ],
  }
}

/** Selection cleared: the detail pane shows its empty state. */
const clearSelection = (model: Model): Model =>
  modifyFields(model, {
    maybeSelectedItemId: () => Option.none(),
    maybeSelectedSessionId: () => Option.none(),
    detail: () => DetailState.Idle(),
    maybeForm: () => Option.none(),
    submission: () => Submission.Idle(),
    maybeReplyError: () => Option.none(),
    isPreviewExpanded: () => false,
    isLastMessageExpanded: () => false,
    denyNote: () => "",
    maybeAdvanceFrom: () => Option.none(),
  })

/**
 * Show History (`#/history`, or `#/history/<id>` with that entry selected). Entering it keeps
 * the inbox's selection aside for the way back (U-054) and fetches the first page.
 */
const enterHistory = (model: Model, itemId: string | null): UpdateReturn => {
  const wasHere = model.route === "history"
  const routed = withHistory(modifyFields(model, { route: () => "history" }), (history) =>
    wasHere ? history : { ...history, maybeInboxItemId: model.maybeSelectedItemId },
  )
  const selected: UpdateReturn =
    itemId === null
      ? { model: clearSelection(routed) }
      : Option.contains(model.maybeSelectedItemId, itemId) && wasHere
        ? { model: routed }
        : selectItem(routed, itemId, { updateHash: false, route: "history" })
  return wasHere
    ? selected
    : withCommands(fetchHistoryFirstPage(selected.model, { keepCount: false }), [
        ...(selected.commands ?? []),
      ])
}

/**
 * Leaving History for anything else: the inbox gets back what it had selected (U-054), or its
 * first Needs-you item, as at boot. Not on History: unchanged.
 */
const leaveHistory = (model: Model): UpdateReturn => {
  if (model.route !== "history") {
    return { model }
  }
  const routed = withHistory(modifyFields(model, { route: () => "inbox" }), (history) => ({
    ...history,
    maybeInboxItemId: Option.none(),
  }))
  const target = Option.orElse(model.history.maybeInboxItemId, () =>
    Option.flatMap(model.maybeSnapshot, (snapshot) =>
      Option.map(
        Arr.findFirst(snapshot.items, (i) => i.queue === "needs-you"),
        (i) => i.id,
      ),
    ),
  )
  return Option.match(target, {
    onNone: () => ({ model: clearSelection(routed) }),
    onSome: (itemId) => selectItem(routed, itemId, { updateHash: false }),
  })
}

const receiveHistoryPage = (
  model: Model,
  message: Extract<Message, { _tag: "SucceededFetchHistory" }>,
): UpdateReturn => {
  if (message.requestId !== model.history.requestId) {
    return { model }
  }
  const { page, append } = message
  return {
    model: withHistory(model, (history) => {
      const before = append && history.results._tag === "Loaded" ? history.results.entries : []
      const known = new Set(before.map((e) => e.item.id))
      return {
        ...history,
        pending: "none",
        results: HistoryResults.Loaded({
          entries: [...before, ...page.entries.filter((e) => !known.has(e.item.id))],
          nextBefore: page.nextBefore,
          retentionDays: page.retentionDays,
          error: null,
        }),
      }
    }),
  }
}

const failHistory = (
  model: Model,
  message: Extract<Message, { _tag: "FailedFetchHistory" }>,
): UpdateReturn =>
  message.requestId !== model.history.requestId
    ? { model }
    : {
        model: withHistory(model, (history) => ({
          ...history,
          pending: "none",
          results:
            history.results._tag === "Loaded"
              ? HistoryResults.Loaded({ ...history.results, error: message.error })
              : HistoryResults.Failed({ error: message.error, status: message.status }),
        })),
      }

/** A keystroke: show "Searching…", drop answers for the old text, search after 250 ms (U-053). */
const typeHistoryQuery = (model: Model, value: string): UpdateReturn => {
  const version = model.history.queryVersion + 1
  return {
    model: withHistory(model, (history) => ({
      ...history,
      query: value,
      queryVersion: version,
      requestId: history.requestId + 1,
      pending: "first",
    })),
    commands: [WaitBeforeHistorySearch({ version })],
  }
}

const selectHistoryKind = (model: Model, kind: AttentionKind | null): UpdateReturn =>
  model.history.kind === kind && model.history.results._tag !== "Idle"
    ? { model }
    : fetchHistoryFirstPage(
        withHistory(model, (history) => ({ ...history, kind })),
        { keepCount: false },
      )

/** On History, a delta that finishes an item (or touches a finished one) refetches (U-055). */
const historyRefetchFor = (model: Model, message: StreamMessage): boolean =>
  model.route === "history" &&
  model.view === "full" &&
  ((message._tag === "delta" && message.items.some((i) => i.queue === "done")) ||
    message._tag === "hello")

/** What the test notification toast says, literally, for each answer of the daemon. */
export const testNotifyToast = (
  via: string | null,
  message: string | null,
): { payload: ToastPayload; variant: "Info" | "Success" | "Warning" } => {
  if (via === "shell") {
    return {
      payload: {
        title: "Test notification sent",
        description:
          message ??
          "Look for a Session Inbox banner at the top right of the screen. Clicking it opens Setup.",
      },
      variant: "Success",
    }
  }
  if (via === "fallback") {
    return {
      payload: {
        title: "Sent as a plain macOS notification",
        description:
          message ??
          "The menu-bar app couldn't post it, so macOS shows it as coming from Script Editor, and clicking it won't open the inbox.",
      },
      variant: "Info",
    }
  }
  if (via === "none") {
    return {
      payload: {
        title: "No notification was sent",
        description:
          message ??
          "Neither the menu-bar app nor the plain macOS fallback can post one right now. The checks below say why.",
      },
      variant: "Warning",
    }
  }
  return {
    payload: {
      title: "Test notification sent",
      description: message ?? "The daemon sent it the way it sends every notification.",
    },
    variant: "Info",
  }
}

const receiveStreamMessage = (model: Model, streamMessage: StreamMessage): UpdateReturn => {
  if (streamMessage._tag === "hello") {
    // Every (re)connect refetches the setup check: the daemon may have restarted.
    const hello = onHello(
      modifyFields(model, { connection: () => Connection.Live() }),
      streamMessage,
    )
    const fetched = fetchDoctor(hello.model)
    return {
      model: fetched.model,
      commands: [...(hello.commands ?? []), ...(fetched.commands ?? [])],
    }
  }
  if (streamMessage._tag === "doctor") {
    return fetchDoctor(model)
  }
  if (streamMessage._tag === "update") {
    return receiveUpdate(model, streamMessage.status)
  }
  if (streamMessage._tag === "delta") {
    return applyDelta(model, streamMessage)
  }
  if (streamMessage._tag === "reset") {
    return { model, commands: [FetchSnapshot()] }
  }
  // notify/badge are for the shell (G-012).
  return { model }
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
      const handled = receiveStreamMessage(model, streamMessage)
      return historyRefetchFor(model, streamMessage)
        ? withCommands(
            fetchHistoryFirstPage(handled.model, { keepCount: true }),
            handled.commands ?? [],
          )
        : handled
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

    ClickedHistoryEntry: ({ itemId }) =>
      selectItem(model, itemId, { updateHash: true, route: "history" }),

    UpdatedHistoryQuery: ({ value }) => typeHistoryQuery(model, value),

    CompletedWaitBeforeHistorySearch: ({ version }) =>
      version === model.history.queryVersion && model.route === "history"
        ? fetchHistoryFirstPage(model, { keepCount: false })
        : { model },

    // Enter searches now; the pending debounce then finds a newer request and does nothing new.
    SubmittedHistorySearch: () =>
      fetchHistoryFirstPage(
        withHistory(model, (history) => ({ ...history, queryVersion: history.queryVersion + 1 })),
        { keepCount: false },
      ),

    SelectedHistoryKind: ({ kind }) => selectHistoryKind(model, kind),
    ClickedLoadMoreHistory: () => loadMoreHistory(model),
    ClickedRetryHistory: () => fetchHistoryFirstPage(model, { keepCount: true }),
    SucceededFetchHistory: (message) => receiveHistoryPage(model, message),
    FailedFetchHistory: (message) => failHistory(model, message),

    ClickedSession: ({ sessionId }) =>
      selectSession(
        modifyFields(model, { maybeFocusedNode: () => Option.some(sessionNodeId(sessionId)) }),
        sessionId,
      ),

    ChangedHash: ({ hash }) => changeHash(model, hash),

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
        onSome: (form) =>
          bumpDraft(modifyFields(model, { maybeReplyError: () => Option.none() }), {
            ...form,
            reply: value,
          }),
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

    ToggledPreviewExpanded: () => ({
      model: modifyFields(model, { isPreviewExpanded: (expanded) => !expanded }),
    }),

    SubmittedAnswers: () => submitAnswers(model),
    PressedSubmitShortcut: ({ typing }) => submitShortcut(model, typing),
    ClickedDecision: ({ decision }) =>
      decision === "deny" ? denyWithNote(model) : sendDecision(model, decision),
    PressedDenyShortcut: () =>
      detailHasKeys(model) &&
      Option.exists(loadedDetail(model), (d) => d.approval !== null && d.item.live)
        ? denyWithNote(model)
        : { model },
    UpdatedDenyNote: ({ value }) => ({
      model: modifyFields(model, { denyNote: () => value }),
    }),
    SubmittedDenyNote: () => denyWithNote(model),
    ClickedRowDecision: ({ itemId, decision }) => decideRow(model, itemId, decision),
    SubmittedReply: () => submitReply(model),
    ClickedDone: () => markDone(model),
    PressedDoneShortcut: () => (detailHasKeys(model) ? markDone(model) : { model }),
    PressedListKey: ({ direction }) => stepList(model, direction),
    PressedShortcutsKey: () => openShortcuts(model),
    ClickedShortcuts: () => openShortcuts(model),
    GotShortcutsDialogMessage: ({ message: dialogMessage }) =>
      liftShortcutsDialog(model, Dialog.update(model.shortcutsDialog, dialogMessage)),
    CompletedScrollToRow: () => ({ model }),

    SucceededAction: ({ action, itemId, response }) => {
      const withItem = modifyFields(model, {
        submission: () => Submission.Idle(),
        denyNote: (note) => (action === "decision" ? "" : note),
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
        maybeReplyError: (error) => (action === "reply" ? Option.none() : error),
      })
      const refetch: Commands = Option.contains(model.maybeSelectedItemId, itemId)
        ? [FetchItemDetail({ itemId })]
        : []
      const toast = actionToast(action)
      // The item left the tab on screen: the next one takes its place (U-059).
      const settled = modifyFields(withItem, { maybeAdvanceFrom: () => Option.none() })
      const base: UpdateReturn = Option.match(advanceAfter(withItem, action, itemId), {
        onNone: () => ({ model: settled, commands: refetch }),
        onSome: (nextId) =>
          withCommands(selectItem(settled, nextId, { updateHash: true }), [
            ScrollToRow({ rowId: itemRowId(nextId) }),
          ]),
      })
      return toast === null ? base : showToasts(base, [{ payload: toast, variant: "Success" }])
    },

    FailedAction: ({ action, error, status }) =>
      // A reply the daemon refused (409) says why under the reply box, not in a toast (U-035).
      action === "reply" && status === 409
        ? {
            model: modifyFields(model, {
              submission: () => Submission.Failed({ action, error }),
              maybeReplyError: () => Option.some(error),
              maybeAdvanceFrom: () => Option.none(),
            }),
          }
        : showToasts(
            {
              model: modifyFields(model, {
                submission: () => Submission.Failed({ action, error }),
                maybeAdvanceFrom: () => Option.none(),
              }),
            },
            [
              {
                payload: { title: "Couldn't reach the daemon", description: error },
                variant: "Error",
              },
            ],
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
      const closed = lifted.outMessage?._tag === "Closed"
      return {
        model: closed
          ? modifyFields(lifted.model, { jumpCombobox: () => freshJumpCombobox() })
          : lifted.model,
        commands: lifted.commands,
      }
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
            jumpCombobox: () => freshJumpCombobox(),
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

    GotSettingsMessage: ({ message: settingsMessage }) => {
      const next = updateSettings(model.settings, settingsMessage)
      return {
        model: modifyFields(model, { settings: () => next.model }),
        commands: Command.mapMessages(next.commands, (child) =>
          Message.GotSettingsMessage({ message: child }),
        ),
      }
    },

    ClickedCheckForUpdates: () => checkForUpdates(model),

    SucceededFetchDoctor: ({ report }) => ({
      model: modifyFields(model, {
        doctor: () => DoctorState.Loaded({ report, error: null }),
        isDoctorLoading: () => false,
      }),
    }),

    FoundDoctorUnavailable: () => ({
      model: modifyFields(model, {
        doctor: () => DoctorState.Unavailable(),
        isDoctorLoading: () => false,
      }),
    }),

    FailedFetchDoctor: ({ error }) => ({
      model: modifyFields(model, {
        doctor: (doctor) =>
          doctor._tag === "Loaded"
            ? DoctorState.Loaded({ report: doctor.report, error })
            : DoctorState.Failed({ error }),
        isDoctorLoading: () => false,
      }),
    }),

    ClickedRecheck: () => fetchDoctor(model),

    ClickedCopyFix: ({ checkId, value }) => ({ model, commands: [CopyFix({ checkId, value })] }),

    CompletedCopyFix: ({ checkId, value, isCopied }) =>
      isCopied
        ? {
            model: modifyFields(model, { maybeCopiedFix: () => Option.some(checkId) }),
            commands: [WaitCopied({ checkId })],
          }
        : showToast(
            model,
            { title: "Couldn't copy", description: `Run this yourself: ${value}` },
            "Error",
          ),

    CompletedCopiedWait: ({ checkId }) => ({
      model: modifyFields(model, {
        maybeCopiedFix: (copied) => (Option.contains(copied, checkId) ? Option.none() : copied),
      }),
    }),

    ClickedTestNotification: () =>
      model.isTestNotifying
        ? { model }
        : {
            model: modifyFields(model, { isTestNotifying: () => true }),
            commands: [SendTestNotification()],
          },

    SucceededTestNotification: ({ via, message: detail }) => {
      const toast = testNotifyToast(via, detail)
      const shown = showToast(
        modifyFields(model, { isTestNotifying: () => false }),
        toast.payload,
        toast.variant,
      )
      // The notifications check may read differently now.
      const fetched = fetchDoctor(shown.model)
      return {
        model: fetched.model,
        commands: [...(shown.commands ?? []), ...(fetched.commands ?? [])],
      }
    },

    FailedTestNotification: ({ error }) =>
      showToast(
        modifyFields(model, { isTestNotifying: () => false }),
        { title: "Couldn't send a test notification", description: error },
        "Error",
      ),

    ToggledLastMessageExpanded: () => ({
      model: modifyFields(model, { isLastMessageExpanded: (expanded) => !expanded }),
    }),

    ClickedUpdateNow: () =>
      model.updateRequest !== "Idle"
        ? { model }
        : Option.match(model.maybeUpdate, {
            onNone: () => ({ model }),
            onSome: (status) => ({
              model: modifyFields(model, { updateRequest: () => "Applying" }),
              commands: [ApplyUpdate({ version: status.latest ?? status.target })],
            }),
          }),

    DismissedUpdateBanner: () => ({
      model: modifyFields(model, {
        maybeDismissedUpdate: () => Option.map(model.maybeUpdate, updateBannerKey),
      }),
    }),

    SucceededUpdateRequest: ({ status }) => updateRequestDone(model, status),

    FailedUpdateRequest: ({ error }) =>
      showToast(
        modifyFields(model, { updateRequest: () => "Idle" }),
        { title: "Update request failed", description: error },
        "Error",
      ),

    CompletedReload: () => ({ model }),
    CompletedMarkRead: () => ({ model }),
    CompletedSetHash: () => ({ model }),
    CompletedFocusTreeNode: () => ({ model }),
    TickedClock: ({ now }) => ({ model: modifyFields(model, { now: () => now }) }),
  })
