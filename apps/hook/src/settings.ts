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

type Spec = { event: string; matcher?: string; timeout: number }

export const HOOK_SPECS: Spec[] = [
  { event: "SessionStart", timeout: 5 },
  { event: "UserPromptSubmit", timeout: 5 },
  { event: "Notification", timeout: 5 },
  { event: "PreToolUse", matcher: PRE_TOOL_USE_MATCHER, timeout: 130 },
  { event: "PostToolUse", matcher: "*", timeout: 5 },
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

/** True when `command` runs an executable named inbox-hook (quoted or not). */
export const isOurs = (command: unknown): boolean =>
  typeof command === "string" && /^\s*"?[^"]*\/inbox-hook"?(\s|$)/.test(command)

const hasOurs = (g: HookGroup) => Array.isArray(g.hooks) && g.hooks.some((h) => isOurs(h?.command))

const stripOurs = (g: HookGroup): HookGroup => ({
  ...g,
  hooks: g.hooks.filter((h) => !isOurs(h?.command)),
})

/** Strip our commands; drop only groups that held ours and are now empty. */
const pruneOurs = (groups: HookGroup[]): HookGroup[] =>
  groups.flatMap((g) => {
    if (!hasOurs(g)) return [g]
    const stripped = stripOurs(g)
    return stripped.hooks.length > 0 ? [stripped] : []
  })

const clone = <T>(v: T): T => structuredClone(v)

export const mergeHooks = (input: Settings, home: string): Settings => {
  const settings = clone(input)
  const hooks: Record<string, HookGroup[]> = { ...(settings.hooks ?? {}) }
  const wanted = buildHooks(home)

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

export const unmergeHooks = (input: Settings): Settings => {
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
