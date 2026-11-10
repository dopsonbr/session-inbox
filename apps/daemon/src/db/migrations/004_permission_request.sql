-- 004: approvals raised by Claude's PermissionRequest hook (D-068..D-071).
-- via: NULL for a held PreToolUse, 'permissionRequest' otherwise.
-- input_key: sha256 of tool_name + canonical tool_input, to match the call's PostToolUse when
--   no tool_use_id could be recovered (PermissionRequest payloads carry none).
-- suggestions_json: Claude's permission_suggestions, raw; updated_permissions_json: what an
--   "Always allow" echoed back of them.
ALTER TABLE approvals ADD COLUMN via TEXT;
ALTER TABLE approvals ADD COLUMN input_key TEXT;
ALTER TABLE approvals ADD COLUMN suggestions_json TEXT;
ALTER TABLE approvals ADD COLUMN updated_permissions_json TEXT;
