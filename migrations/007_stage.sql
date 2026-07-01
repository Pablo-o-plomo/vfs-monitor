-- 007_stage.sql: stage tracking per monitoring job

ALTER TABLE monitoring_jobs
  ADD COLUMN IF NOT EXISTS job_stage        VARCHAR(30),
  ADD COLUMN IF NOT EXISTS stage_updated_at TIMESTAMPTZ;
