/**
 * Where the daemon keeps its files. Everything hangs off one home directory so
 * tests and the dev loop can point SESSION_INBOX_HOME at a scratch dir.
 * Node/Bun only — import from "@session-inbox/contracts/paths", never from the UI.
 */
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

const APP_SUPPORT = join(homedir(), "Library", "Application Support")
export const DEFAULT_HOME = join(APP_SUPPORT, "SessionInbox")

/**
 * Install channels (H-014). GA is the everyday install; beta runs side by side from a
 * working checkout with its own home, launchd label, port and menu-bar app.
 */
export type Channel = "ga" | "beta"
export const CHANNELS: Record<Channel, { home: string; label: string; title: string }> = {
  ga: { home: DEFAULT_HOME, label: "com.sessioninbox.inboxd", title: "Session Inbox" },
  beta: {
    home: join(APP_SUPPORT, "SessionInbox-beta"),
    label: "com.sessioninbox.inboxd.beta",
    title: "Session Inbox Beta",
  },
}
export const isChannel = (s: unknown): s is Channel => s === "ga" || s === "beta"

/** `<home>/bin/inbox-hook` → `<home>`: an installed hook finds its own daemon (H-015). */
export const homeOfExecutable = (execPath: string): string | null =>
  basename(execPath) === "inbox-hook" && basename(dirname(execPath)) === "bin"
    ? dirname(dirname(execPath))
    : null

/** Set on any `claude` process the daemon spawns that must NOT be ingested (e.g. title generation). */
export const INTERNAL_ENV = "SESSION_INBOX_INTERNAL"

export const paths = (home: string = process.env.SESSION_INBOX_HOME ?? DEFAULT_HOME) => ({
  home,
  socket: join(home, "inboxd.sock"),
  db: join(home, "inbox.db"),
  /** 0600 JSON: Connection. Read by the shell and the UI bootstrap. */
  connection: join(home, "connection.json"),
  log: join(home, "inboxd.log"),
  /** inbox-hook record mode writes raw payloads here. */
  fixtures: join(home, "fixtures"),
})
