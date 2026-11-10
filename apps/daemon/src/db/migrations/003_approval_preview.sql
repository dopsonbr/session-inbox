-- 003: approval previews (D-056). Computed when the hold is created, because the file on
-- disk changes as soon as the call is allowed. preview_json is an ApprovalPreview (C-019);
-- context is Claude's last text before the call. Both NULL for older rows or on failure.
ALTER TABLE approvals ADD COLUMN preview_json TEXT;
ALTER TABLE approvals ADD COLUMN context TEXT;
