---
title: A visual tour of Session Inbox
description: Every Session Inbox feature in one screenshot each, from the inbox window and approvals to History, Settings, the menu-bar popover and the update banner.
nav: Tour
order: 2.5
section: Get started
---

# A visual tour

One picture per feature, each with what it is, how you get there and what its controls do. The pictures come from the real app: `scripts/screenshots.ts` runs a seeded demo daemon and drives the UI in headless Chrome, so they are regenerated whenever the UI changes. The sessions, projects and commands in them are made up. A few states the demo daemon can't reach on demand (the update banner, the Setup check's warnings and welcome, an empty popover) are shown with the app's built-in sample data instead.

## The inbox window

The window has three columns: the session tree on the left (project, then session, then subagent), the queue in the middle and the selected item on the right. It opens on **Needs you**: questions, permission requests and failures. Here a question is selected; pick an option for each question, or type under **Other…**, then **Send answers**. See [the inbox window](using-it.md#the-inbox-window) and [answering questions](using-it.md#answering-questions).

[[screenshot inbox-light.png,inbox-dark.png 1440x900 The inbox window on Needs you. The left column lists projects with their sessions and subagents; the middle column lists items that need you, each with a kind badge such as 2 questions or Permission, the project, the session title and what is asked; the right column shows the selected item, Claude has 2 questions for you, with option buttons and an Other field for each question and a Send answers button.]]

## Approving a file edit

A permission request for **Edit**, **MultiEdit**, **Write** or **NotebookEdit** shows what Claude said just before it asked, then the diff with line numbers and the count of added and removed lines. **Allow once** lets the call run, **Always allow** adds a rule as well, and **Deny** stops it. See [approving a tool call](using-it.md#approving-a-tool-call).

[[screenshot approval-diff.png 1440x900 A permission request for an edit to src/window.ts: the sentence Claude wrote before asking, the file path with +2 and −1, a diff with red removed and green added lines, and the Allow once, Always allow and Deny buttons with a Tell Claude why (optional) field.]]

## Approving a command, and denying with a note

For **Bash** the card shows the command, its description and the folder it runs in. To tell Claude why you're saying no, type in **Tell Claude why (optional)** beside **Deny** and press <kbd>↵</kbd> or **Deny**; Claude gets your words with the denial. <kbd>⌘</kbd><kbd>↵</kbd> is **Allow once** and <kbd>⌘</kbd><kbd>⌫</kbd> is **Deny**.

[[screenshot tour-approval-bash.png 1440x900 A permission request to run bun run migrate, described as Apply the new migration, in the project folder. The Tell Claude why (optional) field beside Deny holds the note Run it after the nightly backup.]]

## Approving a web fetch

For **WebFetch** the card shows the URL and what Claude wants to learn from it, after "Asks:". The line above the buttons says Claude is asking in its own window too, whichever is answered first wins, and how much longer the inbox can answer.

[[screenshot tour-approval-fetch.png 1440x900 A permission request to fetch https://keepachangelog.com/en/1.1.0/, with the line Asks: Which section headings does the format use?, the Allow once, Always allow and Deny buttons, and the sentence Always allow adds WebFetch(domain:keepachangelog.com) in this project's .claude/settings.local.json.]]

## Always allow

**Always allow** lets the call run and adds one narrow rule, so Claude doesn't ask again for this kind of call. The sentence under the buttons says exactly which rule and where it is saved; for a new file it is that one file. When no narrow rule fits, the button isn't shown. See [what each answer does](holds.md#what-each-answer-does).

[[screenshot tour-always-allow.png 721x291 A permission card for creating scripts/changelog.ts, marked new file with +3 −0 and a three-line diff, and under the buttons the sentence Always allow adds Write(…/scripts/changelog.ts) in this project's .claude/settings.local.json.]]

## A decided approval

Once a request is decided, its card loses the buttons and says what was decided, as "Decided here: …" with the time. A denial with a note also shows "Sent with the denial: …". Finished items like this one are in [History](using-it.md#history).

[[screenshot tour-decided.png 721x137 A finished permission card for ./gradlew test --tests KeyRotationTest, in the project folder, with the line Decided here: Allowed once at a time of day, and no buttons.]]

## Waiting in Claude

When the inbox can no longer answer a request (its wait ran out, or the hook that asked is gone), the row says **Waiting in Claude** instead of how long it has waited. Answer it in Claude; **Open in Claude** takes you there. See [How approvals work](holds.md).

[[screenshot tour-waiting-in-claude.png 402x102 A queue row for a permission request in order-up-api, Clean up old feature flags, Wants to run git branch -D feature/old-flags, marked Waiting in Claude where other rows say how long they have waited.]]

## Ready to review

When a session stops cleanly it lands in **Review** as **Ready to review**. The item shows **Claude's last message**, formatted as Markdown, so you can check the result without opening Claude. **Done** (or <kbd>E</kbd>) clears it once you've looked. See [snooze, dismiss and mute](using-it.md#snooze-dismiss-and-mute). The second row here is a tool call that has been running too long, such as "Running npm run dev"; see [when a command hangs](using-it.md#when-a-command-hangs).

[[screenshot tour-review.png 1440x900 The Review tab with Add receipt reprint button selected and a second row, Try the receipt layout in the browser, Running npm run dev. On the right, Ready for your review with the Done, Snooze and Open in Claude buttons, a Claude's last message box reading Added a Reprint button; tests pass., a Short reply box and the session's activity.]]

## Stopped with errors

A turn that ended on an error comes to **Needs you** as **Stopped with errors**, with Claude's last message so you can see what went wrong. It has the same **Done** button and reply box.

[[screenshot tour-failed.png 1440x900 A Stopped with errors item, Flaky checkout test, selected: the title Session stopped with errors, Claude's last message showing an API Error 529 overloaded_error, a Short reply box, and the project marked failed in the session tree.]]

## Replying to a session

Under **Short reply**, type a message and choose **Send reply** (or <kbd>⌘</kbd><kbd>↵</kbd>). When the session is idle it is sent with `claude --resume`, as a new message to that same session. See [Replies](using-it.md#replies).

[[screenshot tour-reply.png 721x172 The Short reply box with the text Looks good. Open the PR and ask Sam to review., the note Sent with claude --resume when the session is idle. For anything bigger, open it in Claude., and the Send reply button.]]

## Working

**Working** lists the sessions running right now. Nothing there needs you; select one to see its state, and the session shows up again in **Needs you** when it asks, stops or fails.

[[screenshot tour-working.png 1440x900 The Working tab listing the sessions running now, with Session tree parser in agent-kit selected. The right column says Working, This Mac, desktop app, and Nothing here needs you. Routine progress stays quiet.]]

## Snoozing

**Snooze** in an item's header puts it aside: **Snooze 15 minutes**, **Snooze 1 hour** or **Snooze until tomorrow 9:00**. The same menu has **Dismiss** for a question or permission request, and **Mute** for the item's project.

[[screenshot tour-snooze-menu.png 1440x900 The Snooze menu open on a permission request, listing Snooze 15 minutes, Snooze 1 hour, Snooze until tomorrow 9:00, Dismiss and Mute ravelo-insights.]]

**Snoozed** holds what you put aside, each row saying when it comes back. The item returns to its queue, with one notification, when the time is up.

[[screenshot tour-snoozed.png 1440x900 The Snoozed tab with one item, Tidy the README examples, marked Snoozed until a time later today, and its detail on the right with Claude's last message.]]

## Jump to session

<kbd>⌘</kbd><kbd>K</kbd>, or **Jump to session** in the header, finds a session or project by name. Type part of a name, move with the arrow keys and press <kbd>↵</kbd> to open it; each match shows its project and state.

[[screenshot tour-jump.png 1440x900 The Jump to session dialog over the inbox with order typed, listing three sessions in order-up-api, each marked needs you.]]

## Keyboard shortcuts

<kbd>?</kbd>, or **Shortcuts** at the bottom of the left column, lists every shortcut with its current key. They follow what you set in Settings. See [Keyboard shortcuts](using-it.md#keyboard-shortcuts).

[[screenshot tour-shortcuts.png 1440x900 The Keyboard shortcuts dialog: Open the inbox from any app, Jump to a session, Main action, Deny, Next and Previous item in the list, Done, Open Settings, Show the shortcut list, Move in the session tree and Close a dialog or menu, each with its key.]]

## History

**History** in the left column lists finished items, newest first and grouped by day, each with how it ended: **Answered**, **Allowed**, **Denied**, **Session moved on**, **Dismissed** and so on. Select one to see it as it was. See [History](using-it.md#history).

[[screenshot tour-history.png 1440x900 The History view: a Search history field and the kind chips All, Questions, Permissions, Reviews and Errors above entries grouped under Today, Yesterday and a date, each with its outcome, kind and time.]]

[[screenshot history.png 1440x900 A History entry selected: a denied git push --force origin main, with the line Decided here: Denied and the session's activity.]]

Type in **Search history** to narrow the list. Every word has to match, and when a word matched somewhere the row doesn't show, the row adds a line such as "Matched in question: …".

[[screenshot tour-history-search.png 1440x900 History searched for vitest: one answered question, Which test runner should the kit ship with?, with the line Matched in question: Vitest.]]

The chips filter by kind: **All**, **Questions**, **Permissions**, **Reviews** and **Errors**.

[[screenshot tour-history-kind.png 1440x900 History with the Permissions chip selected, listing only permission requests: allowed, denied and handled in Claude, grouped by day.]]

## Settings: approvals

<kbd>⌘</kbd><kbd>,</kbd> or the gear in the header opens **Settings**. Changes apply as you make them; there is no Save button. **Approvals** decides how approvals reach the inbox. See [Settings](settings.md#approvals).

[[screenshot settings.png 1440x900 The Settings dialog on the Approvals group with the recommended mode, Answer Claude's own prompt (recommended), selected and its Wait for an answer setting in minutes.]]

In the classic mode, **Hold the tool call before Claude asks (classic)**, the group adds the settings that only apply there: **Tools that can be held**, **Wait for an answer** in seconds and **Bash commands never held**.

[[screenshot tour-settings-classic.png 1440x900 The Approvals group with Hold the tool call before Claude asks (classic) selected, showing the Tools that can be held chips, Wait for an answer of 120 seconds and the list of Bash commands never held.]]

## Settings: notifications, sessions, storage and updates

The rest of the groups: **Notifications**, **Sessions** (short session titles and **Muted projects**), **Storage** (**Keep history for**) and **Updates**. See [Settings](settings.md#notifications).

[[screenshot tour-settings-more.png 1440x900 The Settings dialog scrolled to Notifications, Sessions, Storage and Updates: Notify even when the menu-bar app isn't running, Group finished sessions, Generate short session titles, Muted projects, Keep history for, Check for new versions and Install updates automatically.]]

## Settings: shortcuts

**Shortcuts** lists every shortcut with **Change** and **Clear**. Choose **Change** and the row reads "Press the new shortcut…" until you press the keys you want; **Cancel** or <kbd>Esc</kbd> leaves it as it was. See [Shortcuts](settings.md#shortcuts).

[[screenshot tour-settings-shortcuts.png 1440x900 The Shortcuts group in Settings with the Next item in the list row recording: it reads Press the new shortcut… with a Cancel button, while the other rows show their keys with Change and Clear.]]

## The Setup check

**Setup check** in the left column checks the install and says what is wrong with each line, with the fix to copy. See [the setup check](troubleshooting.md#the-setup-check-in-the-app).

[[screenshot setup.png 1440x900 The Setup check page listing checks with their status, some needing attention, each with what is wrong and a fix to copy.]]

On a fresh install the page starts with a short **Welcome**.

[[screenshot tour-setup-welcome.png 1145x172 The Welcome box at the top of the Setup page: Session Inbox collects what your Claude Code sessions need from you, then three steps: allow notifications, restart Claude sessions that were already open, and try it.]]

## The menu-bar popover

Click the menu-bar icon for the popover. It lists what needs you, one row each, with what is asked; a tool call waiting right now has **Allow** and **Deny** on its row. Click a row to open it in the inbox window, or **Open inbox**. See [Menu bar and popover](using-it.md#menu-bar-and-popover).

[[screenshot tour-popover.png 480x600 The menu-bar popover: 7 need you, a Setup row saying 3 checks need attention, then one row per item with its session title, what is asked and the project; the waiting tool calls have Allow and Deny buttons; Open inbox at the bottom.]]

When nothing needs you, it says "Nothing needs you right now." and lists up to five items **Ready to review**.

[[screenshot tour-popover-empty.png 480x600 The popover with 0 need you, the line Nothing needs you right now., and a Ready to review list with two finished sessions and their summaries.]]

## The update banner

When a new version is out, a banner under the header says so. **Update now** installs it, **Release notes** opens them and **Not now** hides the banner. With automatic installs on, it installs by itself when no session is waiting. See [Updating](updating.md).

[[screenshot tour-update.png 1440x37 The update banner: Session Inbox 0.3.0 is available. It installs by itself when no session is waiting., with Update now, Release notes and Not now.]]

## Not pictured

The macOS notification banners and their buttons, the menu-bar icon and its right-click menu are drawn by macOS, not by the page, so the script can't capture them. [Notifications](using-it.md#notifications) describes them.
