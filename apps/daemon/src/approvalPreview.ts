/**
 * The side-effecting edge of approval previews (D-056): read the target file and the
 * transcript tail through the Files service, build the preview, never throw. Runs inside
 * the ingest transaction, so every read is synchronous and size-capped.
 */
import type { ApprovalPreview } from "@session-inbox/contracts"
import { buildPreview, PREVIEW_MAX_FILE_BYTES, previewSummary } from "./domain/preview.ts"
import { lastAssistantText, TRANSCRIPT_TAIL_BYTES } from "./domain/text.ts"
import { type FilesShape, LiveFiles, type LoggerShape } from "./services.ts"

export interface PreviewInput {
  readonly tool: string
  readonly input: unknown
  readonly cwd: string | null
  /** Session worktree and project root, most specific first. */
  readonly roots: ReadonlyArray<string | null>
  readonly transcriptPath: string | null
  readonly toolUseId: string | null
}

export interface PreviewOutput {
  readonly preview: ApprovalPreview | null
  readonly context: string | null
  /** Item summary with the diff stat ("Wants to edit src/a.ts +3 −1"), or null to keep the default. */
  readonly summary: string | null
}

/** Over this, a preview is logged as slow (it still counts against the hold's latency). */
const SLOW_MS = 50

export const computePreview = (
  files: FilesShape | undefined,
  log: LoggerShape,
  p: PreviewInput,
): PreviewOutput => {
  const fs = files ?? LiveFiles
  const started = performance.now()
  let preview: ApprovalPreview | null = null
  let context: string | null = null
  try {
    preview = buildPreview(p.tool, p.input, {
      cwd: p.cwd,
      roots: p.roots,
      read: (path) => fs.read(path, PREVIEW_MAX_FILE_BYTES),
    })
  } catch (e) {
    log.warn("approval preview failed", e)
  }
  try {
    if (p.transcriptPath)
      context = lastAssistantText(fs.tail(p.transcriptPath, TRANSCRIPT_TAIL_BYTES), p.toolUseId)
  } catch (e) {
    log.warn("approval context failed", e)
  }
  const ms = performance.now() - started
  if (ms > SLOW_MS) log.warn(`approval preview took ${Math.round(ms)} ms`, { tool: p.tool })
  let summary: string | null = null
  try {
    summary = previewSummary(p.tool, preview)
  } catch {
    summary = null
  }
  return { preview, context, summary }
}
