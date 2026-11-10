# UX log

A running record of how Session Inbox feels to use: a score per feature, how many steps each task takes, what is not obvious, and what was changed because of it. Decisions that came out of a review are recorded in [DECISIONS.md](DECISIONS.md) (U section); this file holds the evidence and the measurements.

The audience is a power user who runs several Claude Code sessions at once. Density is welcome. Extra clicks, mouse-only paths and unexplained controls are not.

## How to add to this log

- **Review a build**: run `bun run --cwd apps/desktop build && bun scripts/demo.ts`, open the printed URL at 1280×820 (the app's window size) and `?view=compact` at 480×600 (the popover), in light and dark.
- **Scorecard**: add a dated column; never rewrite an old one. Score 0 to 10: 9–10 nothing to fix, 7–8 good with small gaps, 5–6 works but costs the user thought or clicks, below 5 a real problem.
- **Step log**: one step is one click, one key chord, or one typed entry. Count from the stated starting point. Add a dated column when a change moves a number.
- **Findings**: give each an id (`UX-NNN`), a category and a status (`open`, `fixed <date>`, `won't fix: why`). Fixed findings stay in the list.
- **Changes**: one line per shipped change, newest first, naming the findings it closes.

## Scorecard

| Feature | 2026-11-10 baseline | Why |
| --- | --- | --- |
| Notification banners and their buttons | not graded | No person has seen them yet (see the docs' "Not yet verified by a person" list). One click by design. |
| Menu-bar popover | 6 | Counts are clear. Rows show the session and "Permission" but not what is being asked, so two requests from one session look identical; nothing can be decided here. |
| Inbox window layout (tree, queue, detail) | 7 | The three panes are easy to read. The context strip spends four boxed cells on one line of facts and pushes the action down. |
| Session tree | 7 | Arrow keys, counts per project, agents nested. The blue dot means "working" here and "unread" in the queue. |
| Queue tabs and list | 6 | The four tabs wrap onto two rows at the default width. No keyboard way through the list. After an answer the selection stays on the finished item. |
| Answering questions | 8 | Options, Other, a single Send, ⌘↵. The Other field wraps onto its own line for one question and not the next. |
| Approving a tool call (diff, command, fetch) | 8 | The preview and "what Claude said" are the best part of the app. The title says "Claude wants to use Edit" while the queue row says the useful thing. No way to deny with a note. After deciding, disabled buttons and the Always allow hint stay on screen. |
| Always allow | 8 | It says exactly which rule is added and where. The sentence is set at 9.75px. |
| Ready to review and Stopped with errors | 5 | The natural last step, "I've looked, clear it", is Dismiss inside the Snooze menu. |
| Replies | 6 | Works where the `claude` CLI is logged in. The reason it can't send is shown, which is good. |
| Snooze, dismiss, mute | 5 | Three different actions under a button labelled Snooze. Mute is only found there, and unmute only in Settings. The menu is offered on finished items, where the daemon refuses it. |
| Jump to session (⌘K) | 8 | Fast, shows project and state. |
| Open in Claude | 9 | One click from every item; lands on the exact session. |
| Settings | 6 | Applies live with no Save, without saying so. Two fields are both called "Wait for an answer". Classic-only settings stay on screen with "Not used…" repeated three times. The title reads "Settings · ga". |
| Setup check | 8 | Each line says what is wrong and offers the fix. |
| Update banner and Update now | not graded | Not exercised in this pass. |
| History and search | not graded | Being built on 2026-11-10; graded in the next column. |
| Keyboard | 5 | ⌘↵, ⌘⌫, ⌘K, ⌘, and the tree arrows exist. Nothing moves through the queue, nothing clears a review item, and there is no list of shortcuts in the app. |
| Type, icons and radius | 5 | One family and a consistent radius. But the root size is 13px, so every `text-xs` label renders at 9.75px (38 of them on the main view) and icons at 10–11px. |
| Dark mode | 8 | Matches light closely; tones hold up. |
| Accessibility basics | 7 | Every control has a name; roles for tabs, tree and radios are right. The 9.75px text and a few 20–23px targets are the gaps. |

## Step log

Starting point unless stated: the inbox window is open on **Needs you** with the first item selected.

| # | Task | 2026-11-10 baseline | Target | Note |
| --- | --- | --- | --- | --- |
| 1 | Allow a tool call from its notification | 1 | 1 | Unseen by a person. |
| 2 | Allow the selected tool call | 1 (click or ⌘↵) | 1 | |
| 3 | Clear four waiting tool calls in a row | 7 (allow, then select + allow three times) | 4 | Needs auto-advance. |
| 4 | Answer a two-question item | 3 (two options, Send) | 3 | |
| 5 | Move to the next item without the mouse | not possible | 1 | Needs a queue key. |
| 6 | Deny and tell Claude why | not possible in the inbox | 2 | Only Open in Claude today. |
| 7 | Clear a review item after reading it | 2 (Snooze menu, Dismiss) | 1 | Needs a visible button. |
| 8 | Snooze an item for an hour | 2 | 2 | |
| 9 | Mute a project | 2 (Snooze menu, Mute) | 2 | Findable only by opening the Snooze menu. |
| 10 | Unmute a project | 3 (Settings, scroll, remove) | 3 | |
| 11 | Jump to a session by name | 3 (⌘K, type, ↵) | 3 | |
| 12 | Open the session in Claude | 1 | 1 | |
| 13 | Decide a tool call from the menu-bar popover | 3 (menu-bar icon, row, Allow in the window) | 2 | Would need Allow and Deny in the popover row. |
| 14 | Tell two requests from one session apart in the popover | not possible without opening each | 0 | Rows should show what is asked. |
| 15 | Find what you allowed yesterday | not possible | 3 (History, type, row) | Needs History. |
| 16 | Turn approvals in the inbox off | 2 (⌘, then the checkbox) | 2 | |
| 17 | See why notifications aren't arriving | 1 (Setup check) | 1 | |

## Findings

### Flow and steps

- **UX-001** (open) After an answer or decision the selection stays on the finished item; the next one needs a click. Clearing N items costs 2N−1 steps.
- **UX-002** (open) No key moves through the queue list; the arrows only work in the session tree.
- **UX-003** (open) A review or failed item has no visible "done" action. Dismiss is in the Snooze menu.
- **UX-004** (open) The popover row doesn't show what is being asked, and nothing can be answered there.
- **UX-005** (open) A tool call can't be denied with a note from the inbox, although Claude's hook accepts one.
- **UX-006** (open) Finished items could not be found again. History is being built for this.

### Not obvious

- **UX-010** (open) The button labelled Snooze also holds Dismiss and Mute.
- **UX-011** (open) The blue dot means "working" in the tree and "unread" in the queue.
- **UX-012** (open) Settings apply at once, with no Save button and nothing saying so.
- **UX-013** (open) Two settings share the label "Wait for an answer" (minutes for the default mode, seconds for classic).
- **UX-014** (open) Classic-only settings are shown, each with "Not used while the inbox answers Claude's own prompt", while the default mode is on.
- **UX-015** (open) "Settings · ga" shows an internal channel name.
- **UX-016** (open) "Decided: allow at 08:23." prints the internal value, and the disabled Allow, Always allow and Deny buttons plus the Always allow hint stay under it.
- **UX-017** (open) The Snooze menu is offered on a finished item; the daemon answers 409.
- **UX-018** (open) The detail title for a tool call is "Claude wants to use Edit"; the queue row's "Wants to edit src/window.ts" is the informative line.
- **UX-019** (open) The question card says the session is "paused waiting"; in the default mode Claude is also asking in its own window.

### Type, icons, radius, spacing

- **UX-020** (open) Root font size is 13px, so Tailwind's `text-xs` is 9.75px: project names on rows, "waiting 1m", badges, timeline times, the Always allow sentence. Minimum should be 11px.
- **UX-021** (open) Icons render at 10–11px beside 13px text; the kind icons in badges are hard to tell apart.
- **UX-022** (open) The queue tabs wrap ("Snoozed 0" alone on a second row) at 1280px.
- **UX-023** (open) The context strip is a four-cell boxed grid (Runs on, Branch, Session, Last activity) about 90px tall; Branch is often "—".
- **UX-024** (open) "Snooze until tomorrow 9:00" wraps inside its menu.
- **UX-025** (open) The Other field sits on its own row for one question and inline for the next.
- **UX-026** (open) In Settings the selected tool chips are dark grey filled, which reads as disabled.
- **UX-027** (open) A decided approval card keeps the orange "needs you" border.

### Power user

- **UX-030** (open) No in-app list of shortcuts.
- **UX-031** (open) No keys for Always allow, Snooze or picking a question's option by number.

### Accessibility

- **UX-040** (open) Three targets are under 24px tall: the two agent rows in the tree (23px) and "Full transcript in Claude" (20px).

## Changes

- 2026-11-10 — First review pass on the build at `79a7376`: scorecard, step log and findings above. The demo (`scripts/demo.ts`) now waits on its seeded requests like a real hook, so they stay answerable while you review.

## Method notes

- Type sizes, icon sizes, radii, unnamed controls and small targets come from a script run in the page (computed styles over every visible element), not from eyeballing screenshots. Contrast is checked the same way against WCAG 4.5:1.
- The review used the seeded demo daemon, so wording that depends on this Mac's real setup (the Setup check, the beta notice in Settings) was read from the fake client or the code.
- Native surfaces (the menu-bar icon, notification banners, the window frame) can't be seen from the review tooling; those rows say so.
