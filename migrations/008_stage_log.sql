-- 008_stage_log.sql: лог шагов каждой проверки

CREATE TABLE IF NOT EXISTS stage_log (
  id         BIGSERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES visa_requests(id) ON DELETE CASCADE,
  job_id     INTEGER,
  stage      VARCHAR(30),
  message    TEXT,
  logged_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stage_log_req_idx ON stage_log(request_id, logged_at DESC);
