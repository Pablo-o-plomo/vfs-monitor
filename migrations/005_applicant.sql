-- 005_applicant.sql: поля заявителя + флаг автобронирования

ALTER TABLE visa_requests
  ADD COLUMN IF NOT EXISTS first_name       TEXT,
  ADD COLUMN IF NOT EXISTS last_name        TEXT,
  ADD COLUMN IF NOT EXISTS birth_date       DATE,
  ADD COLUMN IF NOT EXISTS gender           VARCHAR(10),
  ADD COLUMN IF NOT EXISTS citizenship      TEXT,
  ADD COLUMN IF NOT EXISTS passport_num     TEXT,
  ADD COLUMN IF NOT EXISTS passport_exp     DATE,
  ADD COLUMN IF NOT EXISTS applicant_email  TEXT,
  ADD COLUMN IF NOT EXISTS applicant_phone  TEXT,
  ADD COLUMN IF NOT EXISTS comment          TEXT,
  ADD COLUMN IF NOT EXISTS auto_book        BOOLEAN NOT NULL DEFAULT FALSE;
