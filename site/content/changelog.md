---
title: Changelog
description: What changed in each Session Inbox release, newest first.
order: 11
section: Reference
---

# Changelog

What changed in each release, newest first. Versions are tagged on [GitHub Releases](https://github.com/dopsonbr/session-inbox/releases), where you can download them.

## 0.2.0

The first packaged release. Before this, Session Inbox was installed from a source checkout.

- **One-line installer.** `curl … | sh` downloads the latest release, verifies its SHA-256 and installs it. No Bun or Rust needed on Apple silicon. See [Install](install.md). The `session-inbox` command comes with it.
- **Automatic updates.** The daemon checks GitHub Releases every few hours and installs a new version by itself when no tool call is held and nothing is in flight. An **Update now** banner and `session-inbox update` are there when you'd rather decide. See [Updating](updating.md).
- **Settings pane.** Open it with <kbd>⌘</kbd><kbd>,</kbd>. Approvals, notifications, sessions and updates in one place, applied live. See [Settings](settings.md).
- **Approval preview.** A permission request shows the diff for an edit, the full command for Bash, and what Claude said before it asked. See [Using it](using-it.md#approving-a-tool-call).
- **Setup check.** `session-inbox doctor` looks at the daemon, the hooks, which channel holds, `claude` and notifications. See [Troubleshooting](troubleshooting.md).
- **GA and beta channels.** Install a beta beside your everyday install, with its own data, launchd agent and app. Only one channel holds tool calls; the other observes. See [GA and beta channels](channels.md).
