-- 010_vfs_sessions.sql
-- Хранение VFS-сессии (cookies) в БД.
-- Позволяет передавать сессию от local-login.js (локальный браузер) к Railway worker.

CREATE TABLE IF NOT EXISTS vfs_sessions (
  id           SERIAL      PRIMARY KEY,
  country_code TEXT        NOT NULL DEFAULT 'hun',
  cookies_json TEXT        NOT NULL,
  saved_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  saved_by     TEXT        NOT NULL DEFAULT 'local'   -- 'local' | 'worker'
);

CREATE INDEX IF NOT EXISTS idx_vfs_sessions_saved_at ON vfs_sessions(saved_at DESC);
