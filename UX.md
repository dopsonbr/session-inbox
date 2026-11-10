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

| Feature | 2026-11-10 baseline (`79a7376`) | 2026-11-10 after fixes (`3b2144c`) | 2026-11-10 with shortcut settings (`0.3.0`) | Why it is where it is now |
| --- | --- | --- | --- | --- |
| Notification banners and their buttons | not graded | not graded | not graded | No person has seen them yet (see the docs' "Not yet verified by a person" list). One click by design. |
| Menu-bar popover | 6 | 8 | 8 | Rows now say what is asked, and a waiting tool call has **Allow** and **Deny** on its row. No preview and no Always allow there; items to review aren't listed. |
| Inbox window layout (tree, queue, detail) | 7 | 8 | 8 | The boxed context strip is one line of facts, so the action sits about 70px higher. |
| Session tree | 7 | 8 | 8 | Arrow keys, counts, nested agents. Blue now only means "working". |
| Queue tabs and list | 6 | 8 | 8 | One row of tabs, `j` / `k` through the list, and the next item is selected after an answer. |
| Answering questions | 8 | 8 | 8 | The Other field is laid out the same for every question and the footer says what really happens. No number keys for options. |
| Approving a tool call (diff, command, fetch) | 8 | 9 | 9 | The title says what is asked, Deny takes a note, and a decided card is one clean line. |
| Always allow | 8 | 8 | 8 | Says exactly which rule is added and where, now at 11px. |
| Ready to review and Stopped with errors | 5 | 8 | 8 | A **Done** button and `e`. The item you just cleared doesn't say "Dismissed" until you look in History. |
| Replies | 6 | 6 | 6 | Unchanged. Works where the `claude` CLI is logged in, and says why when it can't send. |
| Snooze, dismiss, mute | 5 | 6 | 6 | Done left the menu for review and failed items, and the menu is gone from finished ones. Dismiss (questions, permissions) and Mute are still found only by opening Snooze. |
| Jump to session (⌘K) | 8 | 8 | 8 | Fast, shows project and state. |
| Open in Claude | 9 | 9 | 9 | One click from every item; lands on the exact session. |
| Settings | 6 | 8 | 8 | Says changes apply at once, shows classic-only settings only in classic mode, and has a Shortcuts group with press-to-record. After recording, focus lands on Close instead of staying on the row. |
| Setup check | 8 | 8 | 8 | Each line says what is wrong and offers the fix. |
| Update banner and Update now | not graded | not graded | not graded | Not exercised in either pass. |
| History and search | not there | 8 | 8 | Finished items by day with how each ended, word search with a "Matched in…" line, kind chips, `j` / `k`. No key to focus the search field, no project or date filter, and the first entry isn't selected for you. |
| Stuck calls | not there | not there | 7 | In Review as "Running npm run dev for 12 min" with a clock and "Still running" in blue; the detail shows the command, when it started and that Done is for a call meant to keep running. Done or `e` clears it. It can't be stopped from the inbox (Open in Claude), the popover row has only its dot and line, and it was checked against the fake client only, not a real hang. |
| Keyboard | 5 | 8 | 9 | Every shortcut can be changed or turned off in Settings, and the hints and the `?` list follow. Still no key for Snooze, Always allow or a question's options. |
| Type, icons and radius | 5 | 8 | 8 | Six text sizes from 11 to 22px (was eight, down to 9.75px); icons 12, 14 and 16px (was 10 to 13px). |
| Dark mode | 8 | 8 | 8 | Matches light closely, History included. |
| Accessibility basics | 7 | 8 | 8 | Every control named, no text under 11px, no target under 24px, no pair under 4.5:1 on the main view. |

## Step log

Starting point unless stated: the inbox window is open on **Needs you** with the first item selected. Counts in the second column were re-taken on the real daemon (the demo) after the fixes.

| # | Task | Baseline (`79a7376`) | After fixes (`3b2144c`) | Target | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | Allow a tool call from its notification | 1 | 1 | 1 | Unseen by a person. |
| 2 | Allow the selected tool call | 1 | 1 | 1 | Click or ⌘↵. |
| 3 | Clear four waiting tool calls in a row | 7 | 4 | 4 | ⌘↵ four times; the next item is selected for you. |
| 4 | Answer a two-question item | 3 | 3 | 3 | Two options, Send. |
| 5 | Move to the next item without the mouse | not possible | 1 | 1 | `j`. |
| 6 | Deny and tell Claude why | not possible | 2 | 2 | Type the note, Enter. |
| 7 | Clear a review item after reading it | 2 | 1 | 1 | **Done** or `e`. |
| 8 | Snooze an item for an hour | 2 | 2 | 2 | |
| 9 | Mute a project | 2 | 2 | 2 | Still findable only by opening the Snooze menu. |
| 10 | Unmute a project | 3 | 3 | 3 | |
| 11 | Jump to a session by name | 3 | 3 | 3 | ⌘K, type, ↵. |
| 12 | Open the session in Claude | 1 | 1 | 1 | |
| 13 | Decide a tool call from the menu-bar popover | 3 | 2 | 2 | Menu-bar icon, **Allow** on the row. |
| 14 | Tell two requests from one session apart in the popover | not possible | 0 | 0 | The row shows what is asked. |
| 15 | Find what you allowed yesterday | not possible | 3 | 3 | History, type a word, the row. |
| 16 | Turn approvals in the inbox off | 2 | 2 | 2 | ⌘, then the checkbox. |
| 17 | See why notifications aren't arriving | 1 | 1 | 1 | Setup check. |
| 18 | See the note you sent with a denial | not possible | 2 | 2 | History, the row: "Sent with the denial: …". |
| 19 | Change a shortcut | not possible | not possible | 3 | 3 since the shortcut settings (`0.3.0`): Settings, **Change** on the row, press the keys. |
| 20 | Clear a stuck call you expected (a dev server) | not possible | not possible | 3 | 3 with stuck calls, measured on `dev:mock`: the **Review** tab, the row, **Done** (or `e`). The next Review item is selected after. |
| 21 | Open the inbox window from another app | 1 | 1 | 1 | ⌘⇧I. The menu-bar icon then **Open inbox** is 2. Since the Dock icon (0.4.0): ⌘Tab to the app while no window shows, or a click on its Dock icon, is 1 too; not yet counted in the running app. |

## Findings

### Flow and steps

- **UX-001** (fixed 2026-11-10, U-059) After an answer or decision the selection stays on the finished item; the next one needs a click. Clearing N items costs 2N−1 steps.
- **UX-002** (fixed 2026-11-10, U-060) No key moves through the queue list; the arrows only work in the session tree.
- **UX-003** (fixed 2026-11-10, U-061) A review or failed item has no visible "done" action. Dismiss is in the Snooze menu.
- **UX-004** (fixed 2026-11-10, U-062) The popover row doesn't show what is being asked, and nothing can be answered there.
- **UX-005** (fixed 2026-11-10, U-063, C-028) A tool call can't be denied with a note from the inbox, although Claude's hook accepts one.
- **UX-006** (fixed 2026-11-10, G-032, C-027, D-096, U-052 to U-058) Finished items could not be found again. History is being built for this.

### Not obvious

- **UX-010** (open, partly: Done moved out for review and failed items, U-061) The button labelled Snooze also holds Dismiss and Mute.
- **UX-011** (fixed 2026-11-10, U-069) The blue dot means "working" in the tree and "unread" in the queue.
- **UX-012** (fixed 2026-11-10, U-074) Settings apply at once, with no Save button and nothing saying so.
- **UX-013** (fixed 2026-11-10, U-074) Two settings share the label "Wait for an answer" (minutes for the default mode, seconds for classic).
- **UX-014** (fixed 2026-11-10, U-074) Classic-only settings are shown, each with "Not used while the inbox answers Claude's own prompt", while the default mode is on.
- **UX-015** (fixed 2026-11-10, U-074) "Settings · ga" shows an internal channel name.
- **UX-016** (fixed 2026-11-10, U-064) "Decided: allow at 08:23." prints the internal value, and the disabled Allow, Always allow and Deny buttons plus the Always allow hint stay under it.
- **UX-017** (fixed 2026-11-10, U-065) The Snooze menu is offered on a finished item; the daemon answers 409.
- **UX-018** (fixed 2026-11-10, U-066) The detail title for a tool call is "Claude wants to use Edit"; the queue row's "Wants to edit src/window.ts" is the informative line.
- **UX-019** (fixed 2026-11-10, U-067) The question card says the session is "paused waiting"; in the default mode Claude is also asking in its own window.

### Type, icons, radius, spacing

- **UX-020** (fixed 2026-11-10, U-068) Root font size is 13px, so Tailwind's `text-xs` is 9.75px: project names on rows, "waiting 1m", badges, timeline times, the Always allow sentence. Minimum should be 11px.
- **UX-021** (fixed 2026-11-10, U-076) Icons render at 10–11px beside 13px text; the kind icons in badges are hard to tell apart.
- **UX-022** (fixed 2026-11-10, U-070) The queue tabs wrap ("Snoozed 0" alone on a second row) at 1280px.
- **UX-023** (fixed 2026-11-10, U-071) The context strip is a four-cell boxed grid (Runs on, Branch, Session, Last activity) about 90px tall; Branch is often "—".
- **UX-024** (fixed 2026-11-10, U-072) "Snooze until tomorrow 9:00" wraps inside its menu.
- **UX-025** (fixed 2026-11-10, U-072) The Other field sits on its own row for one question and inline for the next.
- **UX-026** (fixed 2026-11-10, U-074) In Settings the selected tool chips are dark grey filled, which reads as disabled.
- **UX-027** (fixed 2026-11-10, U-064) A decided approval card keeps the orange "needs you" border.

### Power user

- **UX-030** (fixed 2026-11-10, U-073) No in-app list of shortcuts.
- **UX-031** (open) No keys for Always allow, Snooze or picking a question's option by number.
- **UX-064** (fixed 2026-11-10, G-034, C-029, D-098, U-078 to U-083, S-024 to S-026) Shortcuts were fixed in code; each can now be changed or turned off in Settings, including the system-wide one.
- **UX-065** (open) After recording a shortcut, keyboard focus moves to the dialog's Close button, not back to the row.
- **UX-032** (open) No key puts the cursor in History's search field (`/` is the usual one).

### Found in the second pass

- **UX-050** (fixed 2026-11-10, U-075) History's search field and chips scrolled away with the list.
- **UX-051** (fixed 2026-11-10, U-066) A finished item's title was in the present tense ("Claude has 1 question for you").
- **UX-052** (fixed 2026-11-10, U-075) History rows cut a long summary at one line.
- **UX-053** (fixed 2026-11-10) The new permission title carried the diff count ("… src/window.ts +2 −1") and wrapped; the count stays on the row and above the diff.
- **UX-054** (fixed 2026-11-10, C-028) A denial's note could be sent but not seen again; the finished item now shows "Sent with the denial: …".
- **UX-060** (fixed 2026-11-10) A command that runs in the project root said "in ."; it says "in the project folder".
- **UX-061** (fixed 2026-11-10) A finished item's activity was headed "Since you left · 1 min"; it is headed "Session activity".
- **UX-062** (open) A question's detail says the count twice: the title "Claude has 2 questions for you" and the "2 questions" badge under it.
- **UX-063** (open) The activity heading "Since you left · 1 min" doesn't say what you left; the number is the age of the oldest line shown.
- **UX-066** (fixed 2026-11-10) Regression in 0.3.0 from the decided-card clean-up (U-064): an open item whose hold had lapsed to Claude's own prompt read "Decided here: Left to Claude's own prompt at …" and lost its Open in Claude button in the card. It reads "Claude is asking in its own window. Answer there." again. Found by the docs tour's screenshots.
- **UX-055** (open) An item you just cleared with Done still shows its "Ready to review" badge and no "Dismissed" until you find it in History.
- **UX-056** (open) Opening History selects nothing; the inbox selects the first item for you.
- **UX-057** (open) History has no project or date filter; a project's name in the search box does the first.
- **UX-058** (open) The popover lists only what needs you; an item to review is a count, not a row.
- **UX-059** (open) `?` is read as Shift+/ and is untested on non-US keyboard layouts.

### Window and Dock

- **UX-067** (fixed 2026-11-10, U-089) The app had no Dock icon and wasn't in ⌘Tab: the inbox window could only be reached from the menu-bar icon or ⌘⇧I, and got lost behind other windows. It now has a Dock icon with the count, is in ⌘Tab, and the window remembers its place.
- **UX-068** (fixed 2026-11-10, in the shell; U-092) Clicking a row in the popover did nothing useful in the native app (the link wasn't wired up). It now opens that item in the inbox window.
- **UX-069** (fixed 2026-11-10, U-089 to U-091) Where a notification click and the menu-bar icon go is now a setting, "Notification clicks and the menu-bar icon": the window (default), the popover with the item's row marked, or the window while it's open.

### Accessibility

- **UX-040** (fixed 2026-11-10, U-072) Three targets are under 24px tall: the two agent rows in the tree (23px) and "Full transcript in Claude" (20px).

## Changes

- 2026-11-10 — The app as a window (0.4.0): a Dock icon with the count, ⌘Tab, a window that hides on close and remembers its place, Settings › Window and menu bar (U-089), and the popover marking the row a notification pointed at (U-090 to U-092). The setting and the marked row were checked in a browser against the demo daemon, in light and dark, at 1280×900 and the popover at 480×600 and 480×400; the Dock icon, ⌘Tab and the window's memory are unseen by a person. Closes UX-067 to UX-069; step 21 added.
- 2026-11-10 — Stuck calls in the UI (G-035, C-030, U-084 to U-088): a Review row and title reading "Running npm run dev for 12 min", a card with the command and "Started at … No result yet.", Done/Snooze/Open in Claude, "Ran long" in History, and a switch plus minutes in Settings › Notifications. Checked on `dev:mock` in light and dark at 1280×820 and the popover at 480×600; not yet on a real hung call.
- 2026-11-10 — Shortcut settings (G-034): a Shortcuts group in Settings with press-to-record, Clear and Reset, clash warnings, and the menu-bar app re-registering its system-wide key. Checked on the real daemon: after changing Next to N, J did nothing, N moved, and N still worked after a reload. The system-wide key changing in the running app is unverified (nobody could press keys). Closes UX-064; opens UX-065.
- 2026-11-10 — Second pass on `3b2144c`, re-measured on the real daemon: scores and step counts above. Still open: UX-010 (partly), UX-031, UX-032, UX-055 to UX-059, UX-062, UX-063.
- 2026-11-10 — A denial's note shows on the finished item; permission titles drop the diff count (C-028, U-077); "in the project folder" and "Session activity" wording. Closes UX-053, UX-054, UX-060, UX-061.
- 2026-11-10 — The review's fixes (U-059 to U-076): auto-advance, `j` / `k`, **Done** and `e`, popover rows with what is asked plus **Allow** and **Deny**, deny with a note, clean decided cards, titles, an 11px type floor, pixel-sized icons, one row of tabs, a one-line context strip, Settings clean-up, a shortcut list on `?`, a sticky History header. Closes UX-001 to UX-005, UX-011 to UX-027, UX-030, UX-040, UX-050 to UX-052.
- 2026-11-10 — History and search (G-032, C-027, D-096, D-097, U-052 to U-058). Closes UX-006.
- 2026-11-10 — First review pass on the build at `79a7376`: scorecard, step log and findings. The demo (`scripts/demo.ts`) now waits on its seeded requests like a real hook, so they stay answerable while you review, and seeds finished items across several days for History.

## Method notes

- Type sizes, icon sizes, radii, unnamed controls and small targets come from a script run in the page (computed styles over every visible element), not from eyeballing screenshots. Contrast is checked the same way against WCAG 4.5:1.
- The review used the seeded demo daemon, so wording that depends on this Mac's real setup (the Setup check, the beta notice in Settings) was read from the fake client or the code.
- Native surfaces (the menu-bar icon, notification banners, the window frame) can't be seen from the review tooling; those rows say so.
