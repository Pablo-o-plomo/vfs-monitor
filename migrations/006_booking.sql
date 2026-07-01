-- 006_booking.sql: поля автобронирования

ALTER TABLE visa_requests
  ADD COLUMN IF NOT EXISTS appointment_date     DATE,
  ADD COLUMN IF NOT EXISTS appointment_time     TEXT,
  ADD COLUMN IF NOT EXISTS booking_ref          TEXT,
  ADD COLUMN IF NOT EXISTS booked_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS booking_failed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS booking_fail_reason  TEXT;
