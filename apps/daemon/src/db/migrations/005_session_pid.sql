-- 005: the Claude process a session's hooks came from (the hook envelope's claudePid, D-090),
-- so a session whose process is gone without a SessionEnd can be ended.
ALTER TABLE sessions ADD COLUMN claude_pid INTEGER;
