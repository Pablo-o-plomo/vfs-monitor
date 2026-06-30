-- 002_improvements.sql
-- Безопасное расширение схемы. Не удаляет существующие данные.
-- Все ALTER используют ADD COLUMN IF NOT EXISTS → idempotent.

-- ─── Настройки мониторинга на уровне заявки ───────────────────────────────────

ALTER TABLE visa_requests
  ADD COLUMN IF NOT EXISTS interval_minutes       INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS jitter_minutes         INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS notify_limit_per_day   INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS notify_client_telegram VARCHAR(50),
  ADD COLUMN IF NOT EXISTS work_night             BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS priority               INTEGER NOT NULL DEFAULT 0;

-- ─── Счётчик проверок ─────────────────────────────────────────────────────────

ALTER TABLE monitoring_jobs
  ADD COLUMN IF NOT EXISTS total_checks INTEGER NOT NULL DEFAULT 0;

-- ─── История каждой проверки ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS check_history (
  id          SERIAL PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES visa_requests(id) ON DELETE CASCADE,
  job_id      INTEGER REFERENCES monitoring_jobs(id),
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result      VARCHAR(20) NOT NULL,   -- slot_found | no_slots | error
  slots_count INTEGER NOT NULL DEFAULT 0,
  notified    BOOLEAN NOT NULL DEFAULT FALSE,
  error_msg   TEXT
);

CREATE INDEX IF NOT EXISTS idx_ch_request ON check_history(request_id);
CREATE INDEX IF NOT EXISTS idx_ch_checked ON check_history(checked_at DESC);
