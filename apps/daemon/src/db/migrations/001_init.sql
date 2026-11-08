-- 001: initial schema. Starts from the implementation doc's schema; additions are
-- marked "+" (see DECISIONS.md D-entries).

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  root_path TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- Claude session_id
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT,
  title_source TEXT,                   -- + prompt | generated
  runtime TEXT NOT NULL,               -- desktop | cli | cloud | unknown
  host_session_id TEXT,                -- + Claude desktop's local_<uuid>
  cwd TEXT,
  branch TEXT,
  worktree TEXT,
  transcript_path TEXT,
  permission_mode TEXT,                -- + last seen permission_mode
  state TEXT NOT NULL,                 -- running | waiting | idle | ended
  created_at INTEGER NOT NULL,         -- +
  last_event_at INTEGER NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  parent_agent_id TEXT REFERENCES agents(id),
  name TEXT NOT NULL,
  state TEXT NOT NULL,                 -- running | waiting | done | failed
  started_at INTEGER,
  ended_at INTEGER
);
CREATE INDEX agents_by_session ON agents(session_id);

CREATE TABLE events (                  -- append-only
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  agent_id TEXT,
  hook TEXT NOT NULL,                  -- hook event name, or daemon:<intent>
  payload_json TEXT NOT NULL,
  env_json TEXT,                       -- + envelope env
  decode_error TEXT,                   -- + set when the payload failed to decode
  received_at INTEGER NOT NULL
);
CREATE INDEX events_by_session ON events(session_id, seq);

CREATE TABLE attention_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  agent_id TEXT REFERENCES agents(id),
  kind TEXT NOT NULL,                  -- question | permission | failed | review
  state TEXT NOT NULL,                 -- open | snoozed | answered | resolved | expired | dismissed
  dedupe_key TEXT NOT NULL,
  summary TEXT,
  source_seq INTEGER REFERENCES events(seq),
  snooze_until INTEGER,
  unread INTEGER NOT NULL DEFAULT 1,   -- +
  unconfirmed INTEGER NOT NULL DEFAULT 0, -- +
  answered_at INTEGER,                 -- + start of the 5-minute confirmation window
  answered_seq INTEGER,                -- + seq of the answer intent
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_open_item ON attention_items(dedupe_key)
  WHERE state IN ('open','snoozed');
CREATE INDEX items_by_session ON attention_items(session_id, state);

CREATE TABLE questions (
  item_id TEXT NOT NULL REFERENCES attention_items(id),
  idx INTEGER NOT NULL,
  header TEXT,                         -- +
  text TEXT NOT NULL,
  options_json TEXT,
  multi INTEGER NOT NULL DEFAULT 0,
  answer_json TEXT,
  PRIMARY KEY (item_id, idx)
);

CREATE TABLE approvals (
  item_id TEXT PRIMARY KEY REFERENCES attention_items(id),
  hook_request_id TEXT UNIQUE NOT NULL,
  tool TEXT NOT NULL,
  input_json TEXT NOT NULL,
  tool_use_id TEXT,                    -- +
  decision TEXT,                       -- allow | allow-always | deny | ask
  reason TEXT,                         -- + deny reason sent back through the hook
  updated_input_json TEXT,             -- + AskUserQuestion answers via updatedInput
  live INTEGER NOT NULL DEFAULT 1,     -- + 1 while the PreToolUse hook is held
  decided_at INTEGER,
  expires_at INTEGER NOT NULL
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  item_id TEXT REFERENCES attention_items(id),
  body TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  state TEXT NOT NULL,                 -- queued | sending | delivered | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0, -- +
  delivered_at INTEGER,                -- +
  created_at INTEGER NOT NULL
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES attention_items(id),
  state TEXT NOT NULL,                 -- pending | posted | clicked | acted | cleared
  title TEXT NOT NULL,                 -- +
  body TEXT NOT NULL,                  -- +
  actions_json TEXT NOT NULL,          -- +
  critical INTEGER NOT NULL DEFAULT 0, -- +
  channel TEXT,                        -- + shell | osascript
  created_at INTEGER NOT NULL,         -- +
  posted_at INTEGER,
  acted_at INTEGER,
  action TEXT
);

CREATE TABLE drafts (
  item_id TEXT PRIMARY KEY REFERENCES attention_items(id),
  body_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);

-- + Idempotency for UI mutations that don't create an outbox row (decision, etc.).
CREATE TABLE intents (
  idempotency_key TEXT PRIMARY KEY,
  item_id TEXT,
  kind TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
