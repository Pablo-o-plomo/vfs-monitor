-- Migration 011: full browser state (localStorage + sessionStorage + userAgent)
-- Safe: ADD COLUMN IF NOT EXISTS, no data loss

ALTER TABLE vfs_sessions ADD COLUMN IF NOT EXISTS local_storage_json  TEXT;
ALTER TABLE vfs_sessions ADD COLUMN IF NOT EXISTS session_storage_json TEXT;
ALTER TABLE vfs_sessions ADD COLUMN IF NOT EXISTS user_agent           TEXT;
ALTER TABLE vfs_sessions ADD COLUMN IF NOT EXISTS origin_url           TEXT;
