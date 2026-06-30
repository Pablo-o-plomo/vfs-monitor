-- 004_supervisor.sql
-- Расширение системы наблюдения: supervisor-метрики, browser pool, retry-логика

-- ─── worker_status: расширенные метрики ──────────────────────────
ALTER TABLE worker_status
  ADD COLUMN IF NOT EXISTS version            TEXT,
  ADD COLUMN IF NOT EXISTS mem_rss_mb         NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS mem_heap_mb        NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS cpu_user_ms        BIGINT,
  ADD COLUMN IF NOT EXISTS cpu_sys_ms         BIGINT,
  ADD COLUMN IF NOT EXISTS last_crash_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_crash_reason  TEXT,
  ADD COLUMN IF NOT EXISTS browser_pid        INTEGER,
  ADD COLUMN IF NOT EXISTS browser_pages      INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS browser_checks     INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS browser_started_at TIMESTAMPTZ;

-- ─── monitoring_jobs: state-машина и retry-логика ─────────────────
-- state: waiting | running | retry | error | paused | completed
ALTER TABLE monitoring_jobs
  ADD COLUMN IF NOT EXISTS state       VARCHAR(20) NOT NULL DEFAULT 'waiting',
  ADD COLUMN IF NOT EXISTS retry_count INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retry_at    TIMESTAMPTZ;

-- Быстрая выборка по state
CREATE INDEX IF NOT EXISTS idx_mj_state ON monitoring_jobs(state);
