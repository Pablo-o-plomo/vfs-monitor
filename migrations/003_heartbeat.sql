-- 003_heartbeat.sql
-- Singleton-строка для отслеживания состояния worker-процесса в реальном времени.
-- id всегда = 1. Используется UPSERT из worker.

CREATE TABLE IF NOT EXISTS worker_status (
  id               INTEGER PRIMARY KEY DEFAULT 1,
  pid              INTEGER,
  started_at       TIMESTAMPTZ,
  last_beat        TIMESTAMPTZ,
  beat_count       INTEGER NOT NULL DEFAULT 0,
  current_job_id   INTEGER,
  current_job_desc TEXT
);

-- Вставляем единственную строку-заглушку, если её ещё нет
INSERT INTO worker_status(id) VALUES(1) ON CONFLICT (id) DO NOTHING;
