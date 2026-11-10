/**
 * Pure merge / unmerge of our hooks block into a Claude Code settings object.
 * Ours are identified by the command's executable being `.../inbox-hook`.
 * Settings format (Claude Code 2.1.x):
 *   hooks.<Event> = [{ matcher?: string, hooks: [{ type: "command", command, timeout }] }]
 * `timeout` is in seconds.
 */

export type HookCommand = {
  type: "command"
  command: string
  timeout: number
  [k: string]: unknown
}
export type HookGroup = { matcher?: string; hooks: HookCommand[]; [k: string]: unknown }
export type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown }

/** Hold budget is 120 s; the PreToolUse timeout must exceed it. */
export const PRE_TOOL_USE_MATCHER =
  "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|AskUserQuestion"

/** Above the daemon's largest `holds.requestBudgetMs` (55 min), so our own exit always comes first. */
export const PERMISSION_REQUEST_TIMEOUT_S = 3600

type Spec = { event: string; matcher?: string; timeout: number }

export const HOOK_SPECS: Spec[] = [
  { event: "SessionStart", timeout: 5 },
  { event: "UserPromptSubmit", timeout: 5 },
  { event: "Notification", timeout: 5 },
  { event: "PreToolUse", matcher: PRE_TOOL_USE_MATCHER, timeout: 130 },
  { event: "PostToolUse", matcher: "*", timeout: 5 },
  // Every tool Claude is about to ask about. Observed: the hook exits at once. Answered from
  // the inbox (holds.via = permissionRequest): waits up to 55 min, so the timeout is above it.
  { event: "PermissionRequest", matcher: "*", timeout: PERMISSION_REQUEST_TIMEOUT_S },
  { event: "SubagentStart", timeout: 5 },
  { event: "SubagentStop", timeout: 5 },
  { event: "Stop", timeout: 5 },
  { event: "SessionEnd", timeout: 5 },
]

export const hookCommand = (home: string, event: string) => `"${home}/bin/inbox-hook" ${event}`

export const buildHooks = (home: string): Record<string, HookGroup[]> =>
  Object.fromEntries(
    HOOK_SPECS.map((s) => [
      s.event,
      [
        {
          ...(s.matcher === undefined ? {} : { matcher: s.matcher }),
          hooks: [{ type: "command", command: hookCommand(home, s.event), timeout: s.timeout }],
        },
      ],
    ]),
  )

/**
 * True when `command`'s executable (its first token, quoted or not) is exactly
 * `<some home>/bin/inbox-hook` and an event name follows. `node /opt/x/inbox-hook` is not ours.
 */
export const isOurs = (command: unknown): boolean =>
  typeof command === "string" &&
  /^\s*(?:"[^"]*\/bin\/inbox-hook"|[^\s"]*\/bin\/inbox-hook)\s+[A-Za-z]+(\s|$)/.test(command)

/** A settings file whose hooks we can't merge into without losing what's there. */
export class SettingsShapeError extends Error {}

/** The Session Inbox home a hook command points at (`<home>/bin/inbox-hook`), if any. */
export const hookHome = (command: unknown): string | null => {
  if (typeof command !== "string") return null
  const m = /^\s*(?:"([^"]*)\/bin\/inbox-hook"|(\S*)\/bin\/inbox-hook)(\s|$)/.exec(command)
  return m ? (m[1] ?? m[2] ?? null) : null
}

type Mine = (command: unknown) => boolean

/**
 * Ours = any inbox-hook command except those pointing at a home in `keep` (another
 * channel installed side by side, H-014). A moved home of the same channel is replaced.
 */
const mineExcept =
  (keep: readonly string[]): Mine =>
  (command) => {
    if (!isOurs(command)) return false
    const h = hookHome(command)
    return h === null || !keep.includes(h)
  }

const hasMine = (mine: Mine) => (g: HookGroup) =>
  Array.isArray(g.hooks) && g.hooks.some((h) => mine(h?.command))

const stripMine =
  (mine: Mine) =>
  (g: HookGroup): HookGroup => ({
    ...g,
    hooks: g.hooks.filter((h) => !mine(h?.command)),
  })

/** Strip our commands; drop only groups that held ours and are now empty. */
const pruneMine =
  (mine: Mine) =>
  (groups: HookGroup[]): HookGroup[] =>
    groups.flatMap((g) => {
      if (!hasMine(mine)(g)) return [g]
      const stripped = stripMine(mine)(g)
      return stripped.hooks.length > 0 ? [stripped] : []
    })

const clone = <T>(v: T): T => structuredClone(v)

export const mergeHooks = (
  input: Settings,
  home: string,
  keep: readonly string[] = [],
): Settings => {
  const mine = mineExcept(keep.filter((k) => k !== home))
  const hasOurs = hasMine(mine)
  const stripOurs = stripMine(mine)
  const pruneOurs = pruneMine(mine)
  const isOurs = mine
  const settings = clone(input)
  const raw: unknown = settings.hooks
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw)))
    throw new SettingsShapeError(`"hooks" is not an object; refusing to touch the file`)
  const hooks: Record<string, HookGroup[]> = { ...(settings.hooks ?? {}) }
  const wanted = buildHooks(home)
  // Replacing a value we don't understand would silently drop the user's hooks.
  for (const event of Object.keys(wanted))
    if (event in hooks && !Array.isArray(hooks[event]))
      throw new SettingsShapeError(
        `"hooks.${event}" is not a list; refusing to touch the file (fix or remove that key)`,
      )

  // Ours under an event we no longer register: remove.
  for (const [event, groups] of Object.entries(hooks)) {
    if (event in wanted || !Array.isArray(groups)) continue
    const next = pruneOurs(groups)
    if (next.length > 0 || !groups.some(hasOurs)) hooks[event] = next
    else delete hooks[event]
  }

  for (const [event, [desired]] of Object.entries(wanted) as [string, [HookGroup]][]) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : []
    const ourCmd = desired.hooks[0] as HookCommand
    let placed = false
    const next: HookGroup[] = []
    for (const g of groups) {
      if (!hasOurs(g)) {
        next.push(g)
        continue
      }
      if (!placed && g.matcher === desired.matcher) {
        placed = true
        let replaced = false
        next.push({
          ...g,
          hooks: g.hooks.flatMap((h) => {
            if (!isOurs(h?.command)) return [h]
            if (replaced) return []
            replaced = true
            return [{ ...h, ...ourCmd }]
          }),
        })
      } else {
        const stripped = stripOurs(g)
        if (stripped.hooks.length > 0) next.push(stripped)
      }
    }
    if (!placed) next.push(desired)
    hooks[event] = next
  }

  settings.hooks = hooks
  return settings
}

export const unmergeHooks = (input: Settings, keep: readonly string[] = []): Settings => {
  const mine = mineExcept(keep)
  const hasOurs = hasMine(mine)
  const pruneOurs = pruneMine(mine)
  const settings = clone(input)
  if (!settings.hooks || typeof settings.hooks !== "object") return settings
  const hooks: Record<string, HookGroup[]> = {}
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups
      continue
    }
    const next = pruneOurs(groups)
    if (next.length > 0 || !groups.some(hasOurs)) hooks[event] = next
  }
  if (Object.keys(hooks).length > 0) settings.hooks = hooks
  else delete settings.hooks
  return settings
}

export const serialize = (s: Settings) => `${JSON.stringify(s, null, 2)}\n`
