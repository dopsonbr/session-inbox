/**
 * Where the daemon keeps its files. Everything hangs off one home directory so
 * tests and the dev loop can point SESSION_INBOX_HOME at a scratch dir.
 * Node/Bun only — import from "@session-inbox/contracts/paths", never from the UI.
 */
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_HOME = join(homedir(), "Library", "Application Support", "SessionInbox")

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
