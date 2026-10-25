-- Waktu selalu dari jam DB (ms), supaya semua instance API memakai satu sumber waktu
CREATE FUNCTION now_ms() RETURNS BIGINT AS $$
  SELECT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT $$ LANGUAGE sql;

CREATE TABLE events (
  id INT PRIMARY KEY, name TEXT NOT NULL, venue TEXT NOT NULL, event_date TEXT NOT NULL
);

CREATE TABLE seats (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES events(id),
  label TEXT NOT NULL, price INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','held','sold')),
  held_by TEXT, hold_until BIGINT,
  UNIQUE (event_id, label),
  -- invarian: status 'held' <=> punya pemegang DAN batas waktu
  CHECK ((status = 'held') = (held_by IS NOT NULL AND hold_until IS NOT NULL))
);
CREATE INDEX idx_seats_held ON seats(held_by) WHERE status = 'held';

CREATE TABLE queue_tokens (
  token TEXT PRIMARY KEY, label TEXT,
  joined_at BIGINT NOT NULL DEFAULT now_ms(),
  admitted_at BIGINT
);
CREATE INDEX idx_queue_waiting ON queue_tokens(joined_at) WHERE admitted_at IS NULL;

CREATE TABLE payments (
  id TEXT PRIMARY KEY, user_token TEXT NOT NULL, amount INT NOT NULL, method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','failed','void','refunded')),
  created_at BIGINT NOT NULL DEFAULT now_ms(), confirmed_at BIGINT
);

CREATE TABLE bookings (
  id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL,
  event_id INT NOT NULL REFERENCES events(id),
  seat_id INT NOT NULL REFERENCES seats(id),
  user_token TEXT NOT NULL, payment_id TEXT REFERENCES payments(id),
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','refunded')),
  created_at BIGINT NOT NULL DEFAULT now_ms(), paid_at BIGINT, refunded_at BIGINT
);
CREATE INDEX idx_bookings_user ON bookings(user_token);
-- anti double-booking: satu kursi hanya boleh punya satu booking berstatus paid
CREATE UNIQUE INDEX idx_bookings_seat_paid ON bookings(seat_id) WHERE status = 'paid';

CREATE TABLE idempotency (
  key TEXT PRIMARY KEY, response TEXT NOT NULL, created_at BIGINT NOT NULL DEFAULT now_ms()
);
CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY, ts BIGINT NOT NULL DEFAULT now_ms(),
  actor TEXT, action TEXT NOT NULL, detail TEXT
);

INSERT INTO events VALUES (1, 'Konser Nusantara Live 2026', 'Gelora Arena Surabaya', '2026-12-12 19:00');
INSERT INTO seats (event_id, label, price)
SELECT 1, r.rw || n, r.price
FROM (VALUES ('V',1500000),('A',750000),('B',750000),('C',500000),('D',500000),('E',250000)) AS r(rw, price),
     generate_series(1, 10) AS n
ORDER BY r.price DESC, r.rw, n;
