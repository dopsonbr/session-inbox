---
title: GA and beta channels
description: Run a beta build of Session Inbox beside your everyday install, compare them, choose which one holds tool calls, and remove the beta again.
nav: GA and beta channels
order: 6
section: Guides
---

# GA and beta channels

You can run two copies of Session Inbox on one Mac. **GA** is the everyday install. **Beta** is a second install built from a working checkout, so you can try a branch while GA keeps doing its job. This is mostly for people working on Session Inbox itself.

Beta is installed from source, so it needs Bun and Rust as described in [Install from source](install.md#install-from-source).

## What each channel has of its own

| | GA | Beta |
| --- | --- | --- |
| Data | `~/Library/Application Support/SessionInbox` | `~/Library/Application Support/SessionInbox-beta` |
| launchd agent | `com.sessioninbox.inboxd` | `com.sessioninbox.inboxd.beta` |
| App | `~/Applications/Session Inbox.app` | `~/Applications/Session Inbox Beta.app` |
| Deep links | `sessioninbox://` | `sessioninbox-beta://` |
| Open the inbox | <kbd>⌘</kbd><kbd>⇧</kbd><kbd>I</kbd> | <kbd>⌘</kbd><kbd>⌥</kbd><kbd>⇧</kbd><kbd>I</kbd> |
| Port | random, per install | random, per install |

Both channels put their hooks in `~/.claude/settings.json`, so both see every session. Each install leaves the other's hooks alone.

## Install a beta

From the branch you want to try:

```bash
git switch my-branch
```

```bash
bun scripts/install.ts --channel beta --yes --app
```

Then see the state of both channels: whether each is running, its build, whether it holds, and its URL:

```bash
bun scripts/channels.ts
```

## Only one channel holds

If both channels held tool calls, each would wait for its own answer, and one of them would always be waiting for nothing. So only one **holds**. A channel installed while the other's hooks are present starts as an **observer**: it shows the same items and sends notifications too, but never pauses Claude. An observer's permission items aren't answerable, so answer them in the channel that holds.

That means you can compare the two inboxes side by side, and they match. A held call shows up in both, live only in the holder.

To swap roles:

```bash
bun scripts/channels.ts holds beta
```

Beta now holds and GA observes. Switch back with `holds ga`. Swapping restarts both daemons, so anything being held at that moment falls back to Claude's own prompt. Do it when nothing is waiting.

Open a channel's inbox in the browser:

```bash
bun scripts/channels.ts open beta
```

## Remove the beta

```bash
bun scripts/uninstall.ts --channel beta --yes --app
```

This removes only beta's hooks, launchd agent and app. GA's hooks are left alone.
