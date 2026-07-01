-- 009_live_frame.sql
-- Хранение live-скриншота браузера в БД (общий доступ между web и worker)

ALTER TABLE monitoring_jobs
  ADD COLUMN IF NOT EXISTS live_frame     TEXT,          -- base64 JPEG (~30-50 KB)
  ADD COLUMN IF NOT EXISTS live_frame_url TEXT,          -- текущий URL страницы
  ADD COLUMN IF NOT EXISTS live_frame_at  TIMESTAMPTZ;   -- время последнего кадра
