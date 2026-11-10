-- 006: tool calls in flight (D-099). One row from a call's PreToolUse until its PostToolUse or
-- PostToolUseFailure, the end of the turn, or the same agent's next batch of calls. The tick
-- reads it to notice a call that has been running for too long. No foreign key: retention
-- deletes sessions, and stale rows are swept by age.
CREATE TABLE tool_calls (
  session_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  agent_id TEXT,
  tool TEXT NOT NULL,
  input_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, tool_use_id)
);
CREATE INDEX tool_calls_by_start ON tool_calls(started_at);
