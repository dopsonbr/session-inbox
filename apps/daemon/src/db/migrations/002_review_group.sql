-- 002: pending review-notification group (D-031). One row per review item waiting for the
-- trailing window to close; the window opened at MIN(added_at). Survives daemon restarts.
CREATE TABLE review_group (
  item_id TEXT PRIMARY KEY REFERENCES attention_items(id),
  added_at INTEGER NOT NULL
);
