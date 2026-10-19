'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ---------- Konfigurasi ----------
const PORT = process.env.PORT || 3000;
const HOLD_SECONDS = +(process.env.HOLD_SECONDS || 300);
const ADMIT_PER_TICK = +(process.env.ADMIT_PER_TICK || 5);
const ADMIT_INTERVAL_MS = +(process.env.ADMIT_INTERVAL_MS || 2000);
const SESSION_TTL_MS = +(process.env.SESSION_TTL_MS || 30 * 60 * 1000);
const MAX_SEATS_PER_USER = +(process.env.MAX_SEATS_PER_USER || 4);
const CLEANUP_INTERVAL_MS = +(process.env.CLEANUP_INTERVAL_MS || 2000);
const ADMIN_KEY = process.env.ADMIN_KEY || '';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'ticketing.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, venue TEXT NOT NULL, event_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seats (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  label TEXT NOT NULL, price INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','held','sold')),
  held_by TEXT, hold_until INTEGER,
  UNIQUE(event_id, label)
);
CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);
CREATE INDEX IF NOT EXISTS idx_seats_held ON seats(held_by);

CREATE TABLE IF NOT EXISTS queue_tokens (
  token TEXT PRIMARY KEY,
  joined_at INTEGER NOT NULL,
  admitted_at INTEGER,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_waiting ON queue_tokens(admitted_at, joined_at);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_token TEXT NOT NULL,
  amount INTEGER NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed','void','refunded')),
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  event_id INTEGER NOT NULL REFERENCES events(id),
  seat_id INTEGER NOT NULL REFERENCES seats(id),
  user_token TEXT NOT NULL,
  payment_id TEXT REFERENCES payments(id),
  status TEXT NOT NULL DEFAULT 'paid' CHECK(status IN ('paid','refunded')),
  created_at INTEGER NOT NULL,
  paid_at INTEGER, refunded_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_token);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY, endpoint TEXT NOT NULL,
  response TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, detail TEXT
);
`);

// ---------- Migrasi 1: kolom label di queue_tokens ----------
try { db.exec("ALTER TABLE queue_tokens ADD COLUMN label TEXT"); } catch { /* sudah ada */ }

// ---------- Migrasi 2: bookings.seat_id UNIQUE full -> partial UNIQUE (status='paid') ----------
(function migrateBookingsSeatUnique() {
  const idxs = db.prepare("PRAGMA index_list('bookings')").all();
  const hasFullUnique = idxs.some(idx => {
    if (!idx.unique) return false;
    if (idx.origin === 'pk') return false;
    const cols = db.prepare(`PRAGMA index_info('${idx.name}')`).all();
    return cols.length === 1 && cols[0].name === 'seat_id';
  });

  if (hasFullUnique) {
    console.log('[migrate] bookings: rebuild tanpa UNIQUE(seat_id), tambah partial unique status=paid');

    const cols = db.prepare("PRAGMA table_info('bookings')").all().map(c => c.name);
    const hasPayment    = cols.includes('payment_id');
    const hasStatus     = cols.includes('status');
    const hasPaidAt     = cols.includes('paid_at');
    const hasRefundedAt = cols.includes('refunded_at');

    db.exec(`
      BEGIN;
      CREATE TABLE bookings_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        event_id INTEGER NOT NULL REFERENCES events(id),
        seat_id INTEGER NOT NULL REFERENCES seats(id),
        user_token TEXT NOT NULL,
        payment_id TEXT REFERENCES payments(id),
        status TEXT NOT NULL DEFAULT 'paid' CHECK(status IN ('paid','refunded')),
        created_at INTEGER NOT NULL,
        paid_at INTEGER, refunded_at INTEGER
      );
    `);

    const selectCols = [
      'id', 'code', 'event_id', 'seat_id', 'user_token',
      hasPayment    ? 'payment_id'  : 'NULL AS payment_id',
      hasStatus     ? 'status'      : "'paid' AS status",
      'created_at',
      hasPaidAt     ? 'paid_at'     : 'NULL AS paid_at',
      hasRefundedAt ? 'refunded_at' : 'NULL AS refunded_at',
    ].join(', ');

    db.exec(`INSERT INTO bookings_new SELECT ${selectCols} FROM bookings`);
    db.exec(`DROP TABLE bookings`);
    db.exec(`ALTER TABLE bookings_new RENAME TO bookings`);
    db.exec(`COMMIT;`);
    console.log('[migrate] bookings: selesai');
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_seat_paid
      ON bookings(seat_id) WHERE status = 'paid';
  `);
})();

// ---------- Seed event + kursi ----------
if (!db.prepare('SELECT 1 FROM events').get()) {
  db.transaction(() => {
    db.prepare('INSERT INTO events (id,name,venue,event_date) VALUES (?,?,?,?)')
      .run(1, 'Konser Nusantara Live 2026', 'Gelora Arena Surabaya', '2026-12-12 19:00');
    const ins = db.prepare('INSERT INTO seats (event_id,label,price) VALUES (1,?,?)');
    for (const [row, price] of [['V', 1500000], ['A', 750000], ['B', 750000], ['C', 500000], ['D', 500000], ['E', 250000]])
      for (let n = 1; n <= 10; n++) ins.run(row + n, price);
  })();
}

// ---------- Util ----------
const now = () => Date.now();
const newToken = () => crypto.randomUUID();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const audit = (actor, action, detail) =>
  db.prepare('INSERT INTO audit_log (ts,actor,action,detail) VALUES (?,?,?,?)')
    .run(now(), actor || null, action, detail ? JSON.stringify(detail) : null);

// ---------- Rate limit (in-memory) ----------
const buckets = new Map();
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const key = name + ':' + (req.get('x-queue-token') || req.ip);
    const t = now();
    let b = buckets.get(key);
    if (!b || t - b.start > windowMs) { b = { start: t, count: 0 }; buckets.set(key, b); }
    b.count++;
    if (b.count > max) return res.status(429).json({ error: 'Terlalu banyak permintaan, coba lagi nanti' });
    next();
  };
}
setInterval(() => {
  const t = now();
  for (const [k, v] of buckets) if (t - v.start > 60_000) buckets.delete(k);
}, 60_000).unref();

// ---------- Tick: admit, expire sesi, release hold ----------
function tick() {
  const t = now();
  const next = db.prepare(
    'SELECT token FROM queue_tokens WHERE admitted_at IS NULL ORDER BY joined_at ASC LIMIT ?'
  ).all(ADMIT_PER_TICK);
  if (next.length) {
    const upd = db.prepare('UPDATE queue_tokens SET admitted_at=? WHERE token=?');
    db.transaction((rows) => { for (const r of rows) upd.run(t, r.token); })(next);
  }
  db.prepare('DELETE FROM queue_tokens WHERE admitted_at IS NOT NULL AND last_seen < ?')
    .run(t - SESSION_TTL_MS);
  db.prepare(`UPDATE seats SET status='available', held_by=NULL, hold_until=NULL
    WHERE status='held' AND (
      hold_until < ? OR held_by IS NULL OR
      NOT EXISTS (SELECT 1 FROM queue_tokens qt WHERE qt.token = seats.held_by AND qt.admitted_at IS NOT NULL)
    )`).run(t);
}
const tickTimer = setInterval(tick, Math.min(ADMIT_INTERVAL_MS, CLEANUP_INTERVAL_MS));
tickTimer.unref();

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------- Middleware auth ----------
function requireAdmitted(req, res, next) {
  const token = req.get('x-queue-token');
  if (!token) return res.status(403).json({ error: 'Belum masuk dari antrean' });
  const row = db.prepare('SELECT admitted_at FROM queue_tokens WHERE token=?').get(token);
  if (!row || !row.admitted_at) return res.status(403).json({ error: 'Belum diizinkan masuk (antrean belum tiba)' });
  db.prepare('UPDATE queue_tokens SET last_seen=? WHERE token=?').run(now(), token);
  req.token = token; next();
}
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return next();
  if (req.get('x-admin-key') === ADMIN_KEY) return next();
  res.status(403).json({ error: 'Admin key diperlukan' });
}

// ---------- Health ----------
app.get('/health', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', uptime: process.uptime(), now: now() });
  } catch { res.status(503).json({ status: 'db_down' }); }
});
app.get('/ready', (_req, res) => {
  const t = now();
  const issues = db.prepare(
    `SELECT (SELECT COUNT(*) FROM seats WHERE status='held' AND hold_until < ?) AS expired,
            (SELECT COUNT(*) FROM seats WHERE status='held' AND held_by IS NULL) AS orphan`
  ).get(t);
  res.json({ ready: true, expiredHolds: issues.expired, orphanHolds: issues.orphan });
});

// ---------- Queue ----------
app.post('/api/queue/join', rateLimit('join', 30, 60_000), (req, res) => {
  const token = newToken();
  const t = now();
  const label = String(req.body?.label || '').trim().slice(0, 40) || null;
  db.prepare('INSERT INTO queue_tokens (token,joined_at,last_seen,label) VALUES (?,?,?,?)')
    .run(token, t, t, label);
  audit(token, 'queue.join', { label });
  res.status(201).json({ token, label });
});

app.get('/api/queue/status/:token', (req, res) => {
  const t = now();
  const row = db.prepare('SELECT * FROM queue_tokens WHERE token=?').get(req.params.token);
  if (!row) return res.status(404).json({ error: 'Token tidak dikenal' });
  db.prepare('UPDATE queue_tokens SET last_seen=? WHERE token=?').run(t, row.token);
  if (row.admitted_at) return res.json({ admitted: true, admittedAt: row.admitted_at, label: row.label });
  const position = db.prepare(
    'SELECT COUNT(*) c FROM queue_tokens WHERE admitted_at IS NULL AND joined_at < ?'
  ).get(row.joined_at).c + 1;
  const total = db.prepare('SELECT COUNT(*) c FROM queue_tokens WHERE admitted_at IS NULL').get().c;
  const etaSec = Math.ceil(position / ADMIT_PER_TICK) * Math.round(ADMIT_INTERVAL_MS / 1000);
  res.json({ admitted: false, position, total, etaSec, label: row.label });
});

app.post('/api/queue/leave', (req, res) => {
  const token = req.get('x-queue-token');
  if (token) {
    db.transaction(() => {
      db.prepare('DELETE FROM queue_tokens WHERE token=?').run(token);
      db.prepare(`UPDATE seats SET status='available', held_by=NULL, hold_until=NULL
                  WHERE held_by=? AND status='held'`).run(token);
    })();
    audit(token, 'queue.leave');
  }
  res.json({ ok: true });
});

// ---------- Event & Seats ----------
app.get('/api/events', (_req, res) => {
  res.json({ events: db.prepare('SELECT * FROM events ORDER BY id').all() });
});

app.get('/api/events/:id/seats', (req, res) => {
  const t = now();
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event tidak ada' });
  const reqToken = req.get('x-queue-token');

  const seats = db.prepare(`
    SELECT s.id, s.label, s.price, s.status, s.held_by, s.hold_until,
           qt.label AS holder_label
    FROM seats s
    LEFT JOIN queue_tokens qt ON qt.token = s.held_by
    WHERE s.event_id=? ORDER BY s.id
  `).all(event.id).map(s => {
    const expired = s.status === 'held' && s.hold_until != null && s.hold_until < t;
    return {
      id: s.id, label: s.label, price: s.price,
      status: expired ? 'available' : s.status,
      holdUntil: !expired && s.status === 'held' ? s.hold_until : null,
      mine: !expired && s.held_by === reqToken && s.status === 'held',
      heldByLabel: !expired && s.status === 'held' ? (s.holder_label || null) : null,
    };
  });
  res.json({ event, seats, serverTime: t });
});

// ---------- Hold ----------
app.post('/api/seats/:id/hold', requireAdmitted, rateLimit('hold', 60, 60_000), (req, res) => {
  const t = now();
  const mine = db.prepare(
    "SELECT COUNT(*) c FROM seats WHERE held_by=? AND status='held' AND hold_until>?"
  ).get(req.token, t).c;
  if (mine >= MAX_SEATS_PER_USER) {
    return res.status(409).json({ error: `Maksimal ${MAX_SEATS_PER_USER} kursi per pengguna` });
  }
  const r = db.prepare(`UPDATE seats SET status='held', held_by=?, hold_until=?
    WHERE id=? AND (status='available' OR (status='held' AND hold_until<?))`)
    .run(req.token, t + HOLD_SECONDS * 1000, req.params.id, t);
  if (r.changes !== 1) {
    return res.status(409).json({ error: 'Kursi sudah dipesan / di-hold orang lain' });
  }
  audit(req.token, 'seat.hold', { seatId: +req.params.id, holdSeconds: HOLD_SECONDS });
  res.json({ ok: true, holdSeconds: HOLD_SECONDS });
});

app.post('/api/seats/:id/release', requireAdmitted, (req, res) => {
  db.prepare(`UPDATE seats SET status='available', held_by=NULL, hold_until=NULL
              WHERE id=? AND held_by=? AND status='held'`).run(req.params.id, req.token);
  audit(req.token, 'seat.release', { seatId: +req.params.id });
  res.json({ ok: true });
});

// ---------- Payment ----------
app.post('/api/payments', requireAdmitted, rateLimit('pay', 20, 60_000), (req, res) => {
  const idem = req.get('idempotency-key');
  if (idem) {
    const cached = db.prepare('SELECT response FROM idempotency WHERE key=?').get(idem);
    if (cached) return res.json(JSON.parse(cached.response));
  }
  const t = now();
  const seats = db.prepare(
    "SELECT id,label,price FROM seats WHERE held_by=? AND status='held' AND hold_until>?"
  ).all(req.token, t);
  if (!seats.length) return res.status(409).json({ error: 'Tidak ada kursi valid untuk dibayar' });

  const amount = seats.reduce((a, s) => a + s.price, 0);
  const method = String(req.body?.method || 'qris');
  const id = 'PAY-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  db.prepare('INSERT INTO payments (id,user_token,amount,method,status,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, req.token, amount, method, 'pending', t);

  const response = {
    paymentId: id, amount, method,
    seats: seats.map(s => ({ id: s.id, label: s.label, price: s.price })),
  };
  if (idem) {
    db.prepare('INSERT INTO idempotency (key,endpoint,response,created_at) VALUES (?,?,?,?)')
      .run(idem, '/api/payments', JSON.stringify(response), t);
  }
  audit(req.token, 'payment.intent', { paymentId: id, amount, method });
  res.status(201).json(response);
});

app.post('/api/payments/:id/confirm', requireAdmitted, asyncHandler(async (req, res) => {
  const id = req.params.id;
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(id);
  if (!p) return res.status(404).json({ error: 'Payment tidak ditemukan' });
  if (p.user_token !== req.token) return res.status(403).json({ error: 'Bukan milik Anda' });

  if (p.status === 'paid') {
    const existing = db.prepare(
      `SELECT b.code, s.label AS seat FROM bookings b JOIN seats s ON s.id=b.seat_id
       WHERE b.payment_id=?`
    ).all(id);
    return res.json({ ok: true, bookings: existing, replay: true });
  }
  if (p.status !== 'pending') {
    return res.status(409).json({ error: `Status payment: ${p.status}` });
  }

  await new Promise(r => setTimeout(r, 600));
  if (p.method === 'test_fail') {
    db.prepare('UPDATE payments SET status=? WHERE id=?').run('failed', id);
    audit(req.token, 'payment.failed', { paymentId: id });
    return res.status(402).json({ error: 'Pembayaran ditolak oleh gateway (simulasi)' });
  }

  const t = now();
  try {
    const bookings = db.transaction(() => {
      const seats = db.prepare(
        "SELECT id,event_id,label,price FROM seats WHERE held_by=? AND status='held' AND hold_until>?"
      ).all(req.token, t);
      if (!seats.length) {
        const e = new Error('Kursi sudah tidak valid (hold kedaluwarsa). Silakan pilih ulang.');
        e.http = 409; e.code = 'NO_HOLDS'; throw e;
      }
      const out = [];
      for (const s of seats) {
        const code = 'TIX-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        db.prepare("UPDATE seats SET status='sold', held_by=NULL, hold_until=NULL WHERE id=?").run(s.id);
        db.prepare(`INSERT INTO bookings (code,event_id,seat_id,user_token,payment_id,status,created_at,paid_at)
                    VALUES (?,?,?,?,?,'paid',?,?)`).run(code, s.event_id, s.id, req.token, id, t, t);
        out.push({ code, seat: s.label, price: s.price });
      }
      db.prepare('UPDATE payments SET status=?, confirmed_at=? WHERE id=?').run('paid', t, id);
      return out;
    })();
    audit(req.token, 'payment.paid', { paymentId: id, codes: bookings.map(b => b.code) });
    res.json({ ok: true, bookings });
  } catch (e) {
    if (e.code === 'NO_HOLDS') {
      db.prepare('UPDATE payments SET status=? WHERE id=?').run('void', id);
      return res.status(e.http || 409).json({ error: e.message });
    }
    throw e;
  }
}));

// ---------- Bookings / e-Tiket / refund ----------
app.get('/api/bookings', requireAdmitted, (req, res) => {
  const rows = db.prepare(`
    SELECT b.code, b.status, b.created_at, b.paid_at, b.refunded_at,
           s.label AS seat, s.price,
           e.name AS event, e.venue, e.event_date
    FROM bookings b
    JOIN seats s ON s.id = b.seat_id
    JOIN events e ON e.id = b.event_id
    WHERE b.user_token = ?
    ORDER BY b.created_at DESC
  `).all(req.token);
  res.json({ bookings: rows });
});

app.get('/api/bookings/:code', requireAdmitted, (req, res) => {
  const b = db.prepare(`
    SELECT b.code, b.status, b.created_at, b.paid_at, b.refunded_at,
           s.label AS seat, s.price,
           e.name AS event, e.venue, e.event_date
    FROM bookings b JOIN seats s ON s.id=b.seat_id JOIN events e ON e.id=b.event_id
    WHERE b.code=?`).get(req.params.code);
  if (!b) return res.status(404).json({ error: 'Tiket tidak ditemukan' });
  res.json({ booking: b });
});

app.post('/api/bookings/:code/refund', requireAdmitted, (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE code=?').get(req.params.code);
  if (!b) return res.status(404).json({ error: 'Tiket tidak ditemukan' });
  if (b.user_token !== req.token) return res.status(403).json({ error: 'Bukan milik Anda' });
  if (b.status !== 'paid') return res.status(409).json({ error: 'Tiket tidak bisa direfund' });
  const t = now();
  db.transaction(() => {
    db.prepare("UPDATE bookings SET status='refunded', refunded_at=? WHERE code=?").run(t, b.code);
    db.prepare("UPDATE seats SET status='available', held_by=NULL, hold_until=NULL WHERE id=?").run(b.seat_id);
    if (b.payment_id) db.prepare("UPDATE payments SET status='refunded' WHERE id=?").run(b.payment_id);
  })();
  audit(req.token, 'booking.refund', { code: b.code });
  res.json({ ok: true });
});

// ---------- Admin & DR ----------
app.get('/api/admin/metrics', requireAdmin, (_req, res) => {
  const t = now();
  const seats = db.prepare(`
    SELECT
      COUNT(*) total,
      SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) available,
      SUM(CASE WHEN status='held'      THEN 1 ELSE 0 END) held,
      SUM(CASE WHEN status='sold'      THEN 1 ELSE 0 END) sold,
      SUM(CASE WHEN status='held' AND hold_until<? THEN 1 ELSE 0 END) expired
    FROM seats`).get(t);
  const queue = db.prepare(`
    SELECT
      SUM(CASE WHEN admitted_at IS NULL     THEN 1 ELSE 0 END) waiting,
      SUM(CASE WHEN admitted_at IS NOT NULL THEN 1 ELSE 0 END) admitted
    FROM queue_tokens`).get();
  const bookings = db.prepare(`
    SELECT
      SUM(CASE WHEN status='paid'     THEN 1 ELSE 0 END) paid,
      SUM(CASE WHEN status='refunded' THEN 1 ELSE 0 END) refunded
    FROM bookings`).get();
  const revenue = db.prepare(`
    SELECT COALESCE(SUM(s.price),0) total FROM bookings b JOIN seats s ON s.id=b.seat_id
    WHERE b.status='paid'`).get().total;
  const payments = db.prepare(`
    SELECT status, COUNT(*) c FROM payments GROUP BY status`).all();
  res.json({ now: t, queue, seats, bookings, revenue, payments, uptime: process.uptime() });
});

app.get('/api/admin/consistency', requireAdmin, (_req, res) => {
  const t = now();
  const issues = [];

  const expired = db.prepare(
    "SELECT id,label,held_by,hold_until FROM seats WHERE status='held' AND hold_until<?"
  ).all(t);
  if (expired.length) issues.push({ type: 'expired_holds', count: expired.length, sample: expired.slice(0, 5) });

  const orphan = db.prepare(`
    SELECT id,label,held_by FROM seats
    WHERE status='held' AND held_by IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM queue_tokens qt WHERE qt.token = seats.held_by AND qt.admitted_at IS NOT NULL
    )`).all();
  if (orphan.length) issues.push({ type: 'orphan_holds', count: orphan.length, sample: orphan.slice(0, 5) });

  const soldNoBooking = db.prepare(`
    SELECT s.id, s.label FROM seats s
    LEFT JOIN bookings b ON b.seat_id = s.id AND b.status='paid'
    WHERE s.status='sold' AND b.id IS NULL`).all();
  if (soldNoBooking.length) issues.push({ type: 'sold_without_booking', count: soldNoBooking.length, sample: soldNoBooking.slice(0, 5) });

  const paidNotSold = db.prepare(`
    SELECT b.code, b.seat_id FROM bookings b JOIN seats s ON s.id=b.seat_id
    WHERE b.status='paid' AND s.status!='sold'`).all();
  if (paidNotSold.length) issues.push({ type: 'paid_but_not_sold', count: paidNotSold.length, sample: paidNotSold.slice(0, 5) });

  const multiPaid = db.prepare(`
    SELECT seat_id, COUNT(*) c FROM bookings WHERE status='paid' GROUP BY seat_id HAVING c>1`).all();
  if (multiPaid.length) issues.push({ type: 'multi_paid_per_seat', count: multiPaid.length, sample: multiPaid.slice(0, 5) });

  res.json({ ok: issues.length === 0, issues, serverTime: t });
});

app.post('/api/admin/reconcile', requireAdmin, (_req, res) => {
  const t = now();
  const r = db.transaction(() => {
    const expired = db.prepare(
      "UPDATE seats SET status='available', held_by=NULL, hold_until=NULL WHERE status='held' AND hold_until<?"
    ).run(t).changes;
    const orphan = db.prepare(`
      UPDATE seats SET status='available', held_by=NULL, hold_until=NULL
      WHERE status='held' AND held_by IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM queue_tokens qt WHERE qt.token = seats.held_by AND qt.admitted_at IS NOT NULL
      )`).run().changes;
    const soldFix = db.prepare(`
      UPDATE seats SET status='available', held_by=NULL, hold_until=NULL
      WHERE status='sold' AND id NOT IN (SELECT seat_id FROM bookings WHERE status='paid')`).run().changes;
    return { expired, orphan, soldFix };
  })();
  audit(null, 'admin.reconcile', r);
  res.json({ ok: true, released: r.expired, orphanReleased: r.orphan, soldFixed: r.soldFix });
});

// ---------- Error handler ----------
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal error', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
});

// ---------- Start & graceful shutdown ----------
const server = app.listen(PORT, () => console.log(`Ticketing berjalan di http://localhost:${PORT}`));

function shutdown(sig) {
  console.log(`[${sig}] shutting down...`);
  clearInterval(tickTimer);
  server.close(() => {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch {}
    console.log('DB closed. Bye.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));