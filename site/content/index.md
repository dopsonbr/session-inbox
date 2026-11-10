---
title: Session Inbox, a menu-bar inbox for Claude Code
description: Session Inbox is a macOS menu-bar inbox for your local Claude Code sessions. Answer a question or approve a tool call from a notification, without switching windows.
nav: Home
order: 0
section: Get started
toc: false
---

# A menu-bar inbox for your Claude Code sessions

<p class="lead">Session Inbox tells you when a Claude Code session needs you, and lets you answer a question or approve a tool call from the notification, without switching to Claude.</p>

[[include install-cmd]]

[[include flow]]

## What it does

### It stays quiet until something needs you

You hear about questions, permission requests, stops and failures. Routine tool activity never notifies. A badge in the menu bar counts the items waiting on you.

### You answer where you are

When Claude asks for permission, the same request shows up in the inbox at once, while Claude's own prompt stays on screen. Allow or Deny it with the diff or the full command in front of you, from the inbox or from the notification; whichever you answer first wins, and nothing is frozen while you decide. It covers every tool Claude asks about. Answer several of Claude's questions in one form and they reach the waiting session together.

### It follows Claude's own structure

Sessions are grouped by project, then session, then subagent. Worktrees of the same repository land under one project. **Open in Claude** takes you to the exact session when there is real work to do. Session titles come from the Claude desktop app's own title for the session.

### It gets out of the way when it's off

If the background daemon isn't running, every hook exits immediately with no output, and Claude behaves exactly as if Session Inbox were not installed.

[[screenshot inbox-light.png,inbox-dark.png 1440x900 The Session Inbox window: a project and session tree on the left, the Needs you queue in the middle, and the selected item's details and actions on the right.]]

## Where to go next

- [Install](install.md): the one-line installer, installing from a tarball or source, what it changes on your Mac, and how to remove it.
- [Using it](using-it.md): notifications, the menu bar, the inbox window and keyboard shortcuts.
- [How approvals work](holds.md): how Session Inbox answers Claude's permission prompts, the classic hold mode, and what happens if you don't answer.
- [Settings](settings.md) and [Updating](updating.md): tune it, and keep it current.
- [Troubleshooting](troubleshooting.md): the setup check, notification problems, logs, and what hasn't been verified by a person yet.
- [How it works](how-it-works.md): the architecture, the files on disk and the security model.

Session Inbox covers sessions on **this Mac** only: the Claude desktop app's Code tab and the `claude` CLI. There are no cloud sessions, no sync and no transcript viewer.
