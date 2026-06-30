-- ============================================================
-- Adria Travel Monitor — начальная схема БД
-- ============================================================

-- Клиенты агентства
CREATE TABLE IF NOT EXISTS clients (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  phone         VARCHAR(50),
  email         VARCHAR(255),
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Заявки на мониторинг виз
CREATE TABLE IF NOT EXISTS visa_requests (
  id            SERIAL PRIMARY KEY,
  client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  country_code  VARCHAR(10)  NOT NULL DEFAULT 'hun',   -- hun, deu, fra …
  country_name  VARCHAR(100) NOT NULL DEFAULT 'Венгрия',
  center        VARCHAR(255) NOT NULL,                 -- «Краснодар»
  category      VARCHAR(255) NOT NULL,                 -- «Краткосрочные визы»
  subcategory   VARCHAR(255) NOT NULL,                 -- «Туризм»
  date_from     DATE NOT NULL,
  date_to       DATE NOT NULL,
  status        VARCHAR(20)  NOT NULL DEFAULT 'active', -- active|paused|done|error
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Задания мониторинга (1 job на 1 request)
CREATE TABLE IF NOT EXISTS monitoring_jobs (
  id                      SERIAL PRIMARY KEY,
  request_id              INTEGER NOT NULL REFERENCES visa_requests(id) ON DELETE CASCADE,
  status                  VARCHAR(20) NOT NULL DEFAULT 'idle', -- idle|running|error
  last_check_at           TIMESTAMPTZ,
  next_check_at           TIMESTAMPTZ DEFAULT NOW(),
  check_interval_minutes  INTEGER NOT NULL DEFAULT 7,
  error_count             INTEGER NOT NULL DEFAULT 0,
  last_error              TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Найденные слоты
CREATE TABLE IF NOT EXISTS slot_events (
  id          SERIAL PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES visa_requests(id) ON DELETE CASCADE,
  job_id      INTEGER REFERENCES monitoring_jobs(id),
  slot_date   DATE NOT NULL,
  slot_time   VARCHAR(10),
  center      VARCHAR(255),
  raw_data    JSONB,
  found_at    TIMESTAMPTZ DEFAULT NOW()
);

-- История уведомлений
CREATE TABLE IF NOT EXISTS notifications (
  id             SERIAL PRIMARY KEY,
  request_id     INTEGER NOT NULL REFERENCES visa_requests(id) ON DELETE CASCADE,
  slot_event_id  INTEGER REFERENCES slot_events(id),
  channel        VARCHAR(20) NOT NULL DEFAULT 'telegram',
  message        TEXT,
  status         VARCHAR(20) NOT NULL DEFAULT 'sent', -- sent|failed
  sent_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_visa_requests_client   ON visa_requests(client_id);
CREATE INDEX IF NOT EXISTS idx_visa_requests_status   ON visa_requests(status);
CREATE INDEX IF NOT EXISTS idx_monitoring_jobs_req    ON monitoring_jobs(request_id);
CREATE INDEX IF NOT EXISTS idx_monitoring_jobs_next   ON monitoring_jobs(next_check_at) WHERE status != 'running';
CREATE INDEX IF NOT EXISTS idx_slot_events_request    ON slot_events(request_id);
CREATE INDEX IF NOT EXISTS idx_slot_events_date       ON slot_events(slot_date);
CREATE INDEX IF NOT EXISTS idx_notifications_request  ON notifications(request_id);
