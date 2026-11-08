# Phase 0 spike findings

Claude Code 2.1.319 (`~/.local/bin/claude`), Claude desktop `app.asar` from `/Applications/Claude.app`, run 2026-11-08.

## Read this first: what was and was not proven live

**The spike agent could not make model calls.** Every child `claude -p` run returned
`Failed to authenticate: OAuth session expired and could not be refreshed`
(`claude auth status` in this environment: `loggedIn: false`). The parent desktop session authenticates
through the desktop host (`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1`), which a child process cannot reuse,
and entering credentials is out of scope. What that means:

- **Proven live (real `claude` process, real hooks):** SessionStart, UserPromptSubmit and SessionEnd payloads;
  `--resume` behaviour (same session id, same transcript, `source:"resume"`); worktree `cwd`; hook env
  (`CLAUDE_CODE_ENTRYPOINT` is `sdk-cli` for a plain `claude -p`). These fire before the API call, so they work without auth.
- **Static evidence only (bundled JS strings in the claude binary, desktop `app.asar`):** payload fields of the
  model-dependent events, notification types, PreToolUse decision semantics, AskUserQuestion mechanics, desktop
  deep links and settings sources. Marked `static` below.
- **Not verified, needs a logged-in run:** PreToolUse allow/deny/ask/timeout behaviour, the AskUserQuestion answer round trip,
  mid-turn concurrent `--resume`. `scripts/spike/live.ts` runs all of these in one command (see "Run the rest live").

No fixtures were fabricated. `fixtures/recorded/` only holds payloads that a real process produced.

## Tooling (`scripts/spike/`)

| File | Purpose |
| --- | --- |
| `record.ts` | The hook command. Appends `{event, payload, env:{entrypoint,hostSessionId,claudePid}, t}` to `$SPIKE_LOG`. For PreToolUse it prints a decision from `$SPIKE_DECISION` / `$SPIKE_DECISION_FILE` (`{decision, reason, updatedInput, sleep, only}`). |
| `mk.ts` | `bun mk.ts <name> [hookTimeout]` makes `/tmp/si-spike-<name>` (git repo) with project-local `.claude/settings.json` hooks for all 9 events. |
| `run.ts` | Runs `claude` in a scratch dir with a scrubbed env (`SPIKE_INHERIT=1` keeps the parent env minus the nested-session vars). |
| `live.ts` | The model-dependent scenarios (Q1-Q4) against a logged-in claude. Writes scrubbed fixtures. |
| `scrub.ts` | Home dir to `/Users/USER`, emails and tokens redacted, timestamps dropped. |
| `asar.ts` | Parses an asar header and extracts only `.js` files. |
| `ctx.ts` | Prints context windows around a literal needle in a huge minified file (`grep -o` chokes on it). |

Hooks are configured only in `<scratch>/.claude/settings.json`. `~/.claude/settings.json` was never touched.
Static analysis used `strings` on the claude binary and the extracted asar JS (both in scratch dirs).

---

## Q1. Payload shapes

Command (live, Q1 subset):

```
bun scripts/spike/mk.ts a
SPIKE_INHERIT=1 bun scripts/spike/run.ts /tmp/si-spike-a /tmp/si-spike-a.jsonl -- \
  -p "Run the bash command ... Write tool ..." --model haiku --max-turns 5 --permission-mode default --output-format json
```

Verdict: **partial.** Three events recorded for real, the rest from the binary.

### Live (fixtures: `session-basic.jsonl`, `session-resume.jsonl`, `worktree.jsonl`)

```jsonc
// SessionStart
{"session_id":"…","transcript_path":"/Users/USER/.claude/projects/-private-tmp-si-spike-a/<id>.jsonl",
 "cwd":"/private/tmp/si-spike-a","hook_event_name":"SessionStart","source":"startup"}
// UserPromptSubmit
{"session_id":"…","transcript_path":"…","cwd":"…","prompt_id":"<uuid>","permission_mode":"default",
 "hook_event_name":"UserPromptSubmit","prompt":"…"}
// SessionEnd
{"session_id":"…","transcript_path":"…","cwd":"…","prompt_id":"<uuid>","hook_event_name":"SessionEnd","reason":"other"}
```

Observations:

- `SessionStart` has **no `permission_mode`** and no `model` here (the binary builds `model`, `agent_type`, `session_title` into it; they were absent/undefined on this run, so keep them optional).
- **New field `prompt_id`** (uuid) on UserPromptSubmit and SessionEnd. It is the turn id and also `promptId` in the transcript. Not in `hook.ts`.
- `permission_mode` is present on UserPromptSubmit (`default`), absent on SessionStart/SessionEnd.
- `cwd` is the realpath (`/private/tmp/...`, not `/tmp/...`). `transcript_path` encodes it as `-private-tmp-…`.
- Hook process env: `CLAUDE_CODE_ENTRYPOINT=sdk-cli` for `claude -p`, `CLAUDE_CODE_HOST_SESSION_ID` unset. The recorder's `process.ppid` is the claude pid.
- `SessionEnd.reason` was `other` for a `-p` run that ended on an API error.

### Static (binary strings, 2.1.319; builder functions for each hook input)

| Event | Fields beyond the base (`session_id, transcript_path, cwd, hook_event_name`, + `permission_mode`, `prompt_id`, agent fields via the shared base builder) |
| --- | --- |
| SessionStart | `source` (`startup`/`resume`/…), `agent_type`, `model`, `session_title` |
| UserPromptSubmit | `prompt` |
| PreToolUse | `tool_name`, `tool_input`, `tool_use_id` |
| PostToolUse | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, **`duration_ms`** |
| Notification | `message`, `title`, `notification_type` |
| SubagentStart | `agent_id`, `agent_type` |
| SubagentStop | `stop_hook_active`, `agent_id`, `agent_transcript_path`, `agent_type`, **`last_assistant_message`**, **`background_tasks`**, **`session_crons`** |
| Stop | `stop_hook_active`, **`last_assistant_message`**, **`background_tasks`**, **`session_crons`** |
| SessionEnd | `reason` |

`last_assistant_message` on Stop is useful: the daemon gets the assistant's final text without parsing the transcript.

`notification_type` values the CLI emits, from `notificationType:"…"` literals: `permission_prompt`, `idle_prompt`
(message `"Claude is waiting for your input"`), `agent_needs_input`, `agent_completed`, `worker_permission_prompt`,
`elicitation_response`, `elicitation_complete`, `auth_success`, `auth_storage_failure`, `push_notification`,
`plugin_notification`, `computer_use_enter`, `computer_use_exit`. Notification hooks match on the type (`matchQuery: notification_type`).

Notification in `-p` mode: not triggerable (it needs an interactive permission prompt or an idle timer). Verify in a real desktop session.

SubagentStart/Stop with the Task/Agent tool, PreToolUse/PostToolUse for Bash and Write, Stop: **not recorded** (need a model). `live.ts` scenarios `tools` and `subagent` record them.

## Q2. PreToolUse decisions

Verdict: **not proven live; static semantics below. Run `live.ts tools tools-deny tools-ask tools-noop tools-slow tools-timeout`.**

Static, from the binary:

- Output schema: `{hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision: "allow"|"deny"|"ask"|"defer", permissionDecisionReason?, updatedInput?, additionalContext?}}`.
  So there is a fourth value, **`defer`**, and it is "print-mode only" (interactive mode logs "defer is print-mode only; ignoring"). Not usable for the desktop.
- A hook that errors or is `cancelled` (timeout): the "refuse the call, hook did not finish" path (`RUn`) is gated on a *served call* (cloud session). For local sessions the hook result is returned unchanged, i.e. a timeout is a non-blocking error and Claude falls back to its normal permission flow. **Unverified live.** If it is wrong, a timed-out hook would deny the tool, which is why the hook must always answer itself (`ask`) before its own `timeout`.
- `updatedInput` is applied to the tool input only when the decision is not `deny`/`defer`.
- Desktop-specific: the schema has an `@internal` `permissionDisplay` (title, description, displayName) "read only beside `permissionDecision: 'ask'` from the hook the SDK host registered". The desktop registers its **own** PreToolUse hook through the SDK initialize. Order and interaction with a user-level hook is unknown. Verify live.

Experiment design for `live.ts` (haiku, `--permission-mode default`, no allowedTools):

| Scenario | Hook does | Question answered |
| --- | --- | --- |
| tools | allow | does Bash/Write run unprompted in -p |
| tools-deny | deny + reason containing PINEAPPLE | does Claude's reply mention it (Claude sees the reason) |
| tools-ask | ask | what -p does with ask (expected: tool denied as no prompt possible) |
| tools-noop | prints nothing, exit 0 | same as no hook |
| tools-slow | sleeps 10 s, timeout 20 | long holds work |
| tools-timeout | sleeps 8 s, timeout 5 | timeout behaviour |

## Q3. AskUserQuestion from outside

Verdict: **partial (static).** Mechanism found; live round trip unverified.

Findings (static):

1. **Not available in plain `-p`.** `isEnabled()` = `!denyInsteadOfPrompting && (interactive || permissionPromptToolName set)`. In non-interactive mode it is only enabled when the host passes a **permission prompt tool** (`--permission-prompt-tool`, SDK `permissionPromptToolName`). The desktop app always does (`permissionPromptToolName`/`canUseTool` in its session options). So `--allowedTools AskUserQuestion` alone will not expose it, and I cannot cheaply drive it from `-p`. `CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL` appears in this session's env (set by the desktop) but the string is not present in the binary, so it is not the gate.
2. **Input** (`tool_input`): `{questions:[{question, header?, options:[{label, description?, preview?}], multiSelect?}], metadata?:{source?}}`, 1-4 questions, 2-4 options. (An "extended" variant adds `kind: "choice"|"text"|"number"`, `title`, `min/max/step/defaultValue/unit/placeholder`. Not enabled by default.) `contracts/hook.ts` `AskUserQuestionInput` matches the basic form.
3. **Answers are an input field.** `call(input)` reads `input.answers` (map question text to answer string; multi-select comma separated), `input.annotations`, `input.response` and returns them as the result. `checkPermissions` returns `{behavior:"ask"}` and `requiresUserInteraction()` is `true`: the normal flow is that the permission card fills `answers` into the input (`admitCardAnswer`/`shownCardInput`) and then the tool runs.
4. **Result text Claude sees:** `Your questions have been answered: "<q>"="<a>". You can now continue with these answers in mind.` (when every answer is one of the option labels), otherwise `The user answered: … Read the answers carefully …`. A free-text `response` yields `The user responded: <text>`. Nothing answered: `The user did not answer the questions.`

So `allow` + `updatedInput = {...tool_input, answers:{"<question>":"<label>"}}` should make `call()` return the answers, *if* a hook `allow` is honoured for a `requiresUserInteraction` tool. That is the unverified step: the permission pipeline re-runs `checkPermissions` for such tools in some paths (it does for PermissionRequest hooks; I did not find the PreToolUse equivalent in the minified code). Fallback `deny` + `permissionDecisionReason` always reaches Claude as the tool error, so it is the safe path.

Verdict on default mode: see P-004. Run live after install: ask Claude in a desktop session to call AskUserQuestion with a held hook.

## Q4. `claude --resume <id> -p "<reply>"`

Command (live, real):

```
SPIKE_INHERIT=1 bun scripts/spike/run.ts /tmp/si-spike-a /tmp/si-spike-resume.jsonl -- \
  -p "again" --resume c1dc349a-426d-4435-8442-119ae7697f9a --model haiku --output-format json
```

Verdict: **works for identity and transcript; mid-turn conflict not tested.**

- **Same `session_id`** in all three hook payloads (no fork). `SessionStart.source` is `"resume"` (vs `"startup"`).
- **Same `transcript_path`**; the transcript file grew (30 lines after the resume) and the reply was appended after the previous leaf (`parentUuid` chain continues). Resumed turns are appended, not copied.
- **UserPromptSubmit fires** with `prompt:"again"`, a new `prompt_id`, `permission_mode:"default"`.
- Hook env on the resumed process: `entrypoint:"sdk-cli"` (its own process), so the daemon must not treat a `--resume -p` SessionStart as a new CLI session or flip a desktop session's runtime to `cli`. Key the session by `session_id` and keep the original runtime (P-005).
- Concurrent resume of a session that is mid-turn in another process: **not tested** (needs a long model turn). Two writers appending to one jsonl with interleaved `parentUuid` chains is the likely failure mode (a fork-like branch in the transcript). Keep the plan: never resume a session whose last event is a running turn.

## Q5. Desktop deep links

Static analysis of `app.asar` (`scripts/spike/asar.ts` extracted 666 `.js` files; the router is in `.vite/build/index.chunk-BBUaTQ8d.js`, `function ZV(url, win, opts)`). No `claude://` URL was opened.

Verdict: **works (static), exact session by desktop id.**

Routes for host `code` (`fu.Code`), after the `hb="/code"`, `gb="/epitaxy"` constants:

| URL | Behaviour | Params |
| --- | --- | --- |
| `claude://code/continue?session=local_<id>` | Open that exact desktop session. `djr(id)` finds it among non-archived sessions and navigates to `getSessionRoute(id)`; unknown id falls back to `/epitaxy`. | `session` = `last` or `^local_[A-Za-z0-9-]{1,64}$`, `source` |
| `claude://code/continue?session=last` | Most recently active non-archived session | |
| `claude://code/needs-input[?session=local_<id>]` | Open that session if it is in the "waiting for you" set, else the first waiting one | `session` optional |
| `claude://code/new` | New session. `q` or `prompt` (prefill), `folder` (repeatable), `file`, `ssh_host/ssh_port/ssh_folder`, `source` | |
| `claude://code/search` | Open search | |
| `claude://code/session_<id>` or `cse_<id>` | Cloud (claude.ai) session | |
| `claude://code/project/<projectId>?thread=<session_…>&msg=<id>` | Cloud project/thread | |
| `claude://resume?session=<cli-session-uuid>` | **Imports a CLI session** into the desktop (`importCliSession`) and opens it. Needs a canonical UUID. | `session` |

Gating: `jkr()` requires a logged-in account and `authentication.disableDeepLinks` unset; otherwise the link is ignored ("entry points off").

Evidence:

```js
// router, case fu.Code
if(a.pathname==="/continue"||a.pathname==="/needs-input"){ let e=…?"code_continue":"code_needs_input", n=a.searchParams.get("session");
  return (e==="code_continue"?ajr(n):n===null||njr.test(n)) ? (ojr(e,n,o,t,i),!0) : (warn("code entry link invalid ?session"),!1) }
njr=/^local_[A-Za-z0-9-]{1,64}$/ ; function ajr(e){return e==="last"||e!==null&&njr.test(e)}
async function djr(e){ … n.find(t=>t.sessionId===e) … return r?t.getSessionRoute(r.sessionId):void 0 }
// in-app session route helper: function _b(e){return `${gb}/${encodeURIComponent(e)}`}   // gb="/epitaxy"
case pu.Resume:{ let e=a.searchParams.get("session"); return e&&IV.test(e)?(… t.importCliSession(e) …) }  // pu.Resume="resume", IV = uuid
```

**Best template for "open exact session" (desktop sessions):**
`claude://code/continue?session=<CLAUDE_CODE_HOST_SESSION_ID>` where the value is `local_<uuid>` as seen in the hook env.
For CLI sessions (no `local_` id): `claude://resume?session=<session_id>` imports the session into the desktop app and opens it (a side effect: it creates a desktop copy; offer it as secondary to copying `cd <cwd> && claude --resume <id>`).

Caveat: `local_<uuid>` is the *desktop's* id; the hook only sees it in `CLAUDE_CODE_HOST_SESSION_ID` for desktop-launched sessions. Whether that id equals what `getAllSessions()` calls `sessionId` is inferred from the router (it matches `t.sessionId===e` against the same `local_` regex), not tested live. Test after install by opening one link for a known running desktop session.

## Q6. Desktop sessions and user-level hooks

Verdict: **works (static); confirm live after install.**

Evidence: the desktop's real session spawn (`index.chunk-CuH_hqMe.js`, the `query({...})` options) passes

```js
settingSources:["user","project","local"], enableFileCheckpointing:!0, permissionMode:it,
canUseTool:this.deps.permissionBroker().createCanUseTool(…), env:pt, settings:{…sessionSettings, …}
```

so `~/.claude/settings.json` (user), `.claude/settings.json` and `.claude/settings.local.json` are all loaded, hooks included. The only desktop code path that sets `disableAllHooks:true` is a separate "config loading only" temporary query (`canUseTool` denies everything; `settingSources` `["user"]` or all three). Real sessions do not set it. The `eg=["hooks","disableAllHooks","allowManagedHooksOnly",…]` list is the SDK's hook-related keys, and managed settings (`allowManagedHooksOnly`) could still disable user hooks on a managed machine (unlikely here). Supporting evidence from this very session: user-level plugin hooks are active under `CLAUDE_CODE_ENTRYPOINT=claude-desktop`.

To verify after install: start a desktop Code-tab session, run one Bash command, confirm an event row with `env.entrypoint=claude-desktop` and a `local_<uuid>` `hostSessionId` reaches the daemon (the `inbox-hook record` fixture for the desktop will be the first real one).

## Q7. Worktrees

Command (live): `git worktree add /tmp/si-spike-a-wt -b wt1` from `/tmp/si-spike-a`, project-local settings copied in, then `claude -p "say ok"` run from the worktree.

Verdict: **works.** `cwd` in every payload is the **worktree path** (`/private/tmp/si-spike-a-wt`), not the main repo. `transcript_path` is keyed on the worktree path too (`-private-tmp-si-spike-a-wt`). So the daemon must map worktree to project itself (G-019: `git rev-parse --git-common-dir`). Fixture: `worktree.jsonl`. Note the project-local `.claude/settings.json` was copied manually (an untracked file); a committed one would be checked out into the worktree automatically.

---

## Run the rest live (needs a logged-in terminal, ~2 minutes, haiku)

```
claude auth status                      # must say loggedIn: true
bun scripts/spike/live.ts               # tools, tools-deny, tools-ask, tools-noop, tools-slow, tools-timeout, subagent, resume
```

It writes `fixtures/recorded/<scenario>.jsonl` (scrubbed) and `/tmp/si-spike-<scenario>.stream.jsonl` (the stream-json with tool results; check the deny reason and hook timeout outcomes there). The AskUserQuestion round trip must be tried from a desktop session with the daemon holding the hook; plain `-p` cannot expose the tool.

## DECISIONS.md entries (paste under `## Phase 0 spike findings`)

- P-001 — Phase 0 had no model access: child `claude -p` runs fail auth inside the agent sandbox. Live-proven: SessionStart/UserPromptSubmit/SessionEnd payloads, `--resume`, worktree `cwd`. Everything else is static (binary/asar) and marked unverified; `scripts/spike/live.ts` runs the rest. Fixtures hold only real payloads. Why: don't build contract tests on invented data.
- P-002 — Hook payload deltas vs `contracts/hook.ts`: add optional `prompt_id` (UserPromptSubmit, SessionEnd, others), `duration_ms` (PostToolUse), `last_assistant_message`, `background_tasks`, `session_crons` (Stop, SubagentStop), `session_title`, `agent_type` (SessionStart). `permission_mode` is absent on SessionStart/SessionEnd, so keep it optional. `cwd` is the realpath. Keep decoding with `decodeHookPayload` so unknown fields survive.
- P-003 — Classify Notification by `notification_type`: `permission_prompt` and `worker_permission_prompt` become approval items; `idle_prompt` ("Claude is waiting for your input") and `agent_needs_input` become "needs you"; `agent_completed` is informational; `elicitation_response`, `elicitation_complete`, `auth_success`, `auth_storage_failure`, `push_notification`, `plugin_notification`, `computer_use_enter`, `computer_use_exit` are ignored for the inbox. Unknown types default to ignored, never to an alert. Why: the CLI's emitted set (static); an unknown type must not spam.
- P-004 — AskUserQuestion answer mode: default **`updatedInput`** (`allow` + `updatedInput = tool_input + answers:{"<question text>":"<option label>"}`; multi-select comma separated), because `call()` reads `input.answers` and the result text is the clean "Your questions have been answered" message. Verify with the PostToolUse for AskUserQuestion: its `tool_response.answers` must equal what was sent; if the answers are empty or the tool still prompted, the daemon switches that session to **`denyWithReason`** (`deny` + reason `The user answered via Session Inbox: <question> → <label>`) and remembers it per runtime. Make the mode a daemon setting (`ask_answer_mode`). Unverified live (see spike.md Q3): `requiresUserInteraction` may stop a hook allow from skipping the card.
- P-005 — `--resume <id> -p` keeps the same `session_id` and appends to the same transcript (live). Its SessionStart arrives with `source:"resume"` and `entrypoint:"sdk-cli"`: never create a new session or change a desktop session's runtime from it. Use it only when the session has no running turn. Concurrent mid-turn resume is untested, so stay conservative. Desktop sessions: acceptable for idle/waiting sessions; prefer the PreToolUse path for live questions (G-015).
- P-006 — "Open in Claude" links: desktop session `claude://code/continue?session=<hostSessionId>` (`local_<uuid>` from `CLAUDE_CODE_HOST_SESSION_ID`); CLI session `claude://resume?session=<session_id>` (imports into desktop) with the copy-`cd … && claude --resume <id>` fallback; project-only fallback `claude://code/new?folder=<cwd>`; unknown id lands on `/epitaxy` (harmless). Needs the desktop app logged in and deep links enabled. Static; test one link after install.
- P-007 — Desktop Code-tab sessions load user-level hooks: the session spawn passes `settingSources:["user","project","local"]` and does not set `disableAllHooks`. Static plus the live evidence of this agent session. Verify live after install with one desktop session and a `local_<uuid>` hostSessionId in the event.
- P-008 — PreToolUse decisions: besides allow/deny/ask there is `defer` (print mode only, ignore it). The hook must answer within its own `timeout` (set it above the daemon hold, default hold 120 s so `timeout: 130`) and answer `ask` itself on expiry rather than relying on timeout semantics, which are unverified (a timed-out hook is expected to fall through, but a "hook did not finish, call not run" path exists for cloud sessions). Desktop registers its own PreToolUse hook (`permissionDisplay`); interaction with ours is unverified.
- P-009 — Worktree payloads carry the worktree path as `cwd` (live). Project grouping must resolve the main worktree via `git rev-parse --git-common-dir` in the daemon (G-019); never group by `cwd` string.
- P-010 — Notification hooks cannot be triggered in `-p`; the first real Notification fixture must come from a desktop/CLI interactive session after install (`inbox-hook record`).
