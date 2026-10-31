'use strict';
const { Router } = require('express');
const { pool, q, ah } = require('./infra');
const { tx } = require('./tx');
const { invalidateSeatMap } = require('./seat-cache');

const ADMIN_KEY = process.env.ADMIN_KEY || '';
const GRACE_MS = 30_000;     // hold kedaluwarsa baru dianggap isu kalau lewat 30 dtk (sweeper jalan tiap 2 dtk)
const r = Router();

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY || req.get('x-admin-key') === ADMIN_KEY) return next();   // ADMIN_KEY kosong = terbuka (hanya demo!)
  res.status(403).json({ error: 'Admin key diperlukan' });
}
r.use('/api/admin', requireAdmin);

r.get('/api/admin/metrics', ah(async (_req, res) => {
  const [seats, queue, bookings, revenue, payments, now] = await Promise.all([
    q(`SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status = 'available') AS available,
              COUNT(*) FILTER (WHERE status = 'held') AS held,
              COUNT(*) FILTER (WHERE status = 'sold') AS sold,
              COUNT(*) FILTER (WHERE status = 'held' AND hold_until < now_ms()) AS expired
       FROM seats`),
    q(`SELECT COUNT(*) FILTER (WHERE admitted_at IS NULL) AS waiting,
              COUNT(*) FILTER (WHERE admitted_at IS NOT NULL) AS admitted
       FROM queue_tokens`),
    q(`SELECT COUNT(*) FILTER (WHERE status = 'paid') AS paid,
              COUNT(*) FILTER (WHERE status = 'refunded') AS refunded
       FROM bookings`),
    q(`SELECT COALESCE(SUM(s.price), 0) AS total
       FROM bookings b JOIN seats s ON s.id = b.seat_id WHERE b.status = 'paid'`),
    q('SELECT status, COUNT(*) AS c FROM payments GROUP BY status'),
    q('SELECT now_ms() AS now'),
  ]);
  res.json({
    now: now.rows[0].now, queue: queue.rows[0], seats: seats.rows[0], bookings: bookings.rows[0],
    revenue: revenue.rows[0].total, payments: payments.rows, uptime: process.uptime(),
  });
}));

r.get('/api/admin/consistency', ah(async (_req, res) => {
  const checks = {
    expired_holds: `SELECT id, label, held_by FROM seats
                    WHERE status = 'held' AND hold_until < now_ms() - ${GRACE_MS}`,
    sold_without_booking: `SELECT s.id, s.label FROM seats s
                           LEFT JOIN bookings b ON b.seat_id = s.id AND b.status = 'paid'
                           WHERE s.status = 'sold' AND b.id IS NULL`,
    paid_but_not_sold: `SELECT b.code, b.seat_id FROM bookings b JOIN seats s ON s.id = b.seat_id
                        WHERE b.status = 'paid' AND s.status <> 'sold'`,
    multi_paid_per_seat: `SELECT seat_id, COUNT(*) AS n FROM bookings WHERE status = 'paid'
                          GROUP BY seat_id HAVING COUNT(*) > 1`,
    paid_payment_without_booking: `SELECT p.id FROM payments p
                                   WHERE p.status = 'paid'
                                     AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.payment_id = p.id)`,
    booking_with_unpaid_payment: `SELECT b.code, b.payment_id FROM bookings b JOIN payments p ON p.id = b.payment_id
                                  WHERE b.status = 'paid' AND p.status NOT IN ('paid', 'refunded')`,
  };
  const issues = [];
  for (const [type, sql] of Object.entries(checks)) {
    const { rows } = await q(sql);
    if (rows.length) issues.push({ type, count: rows.length, sample: rows.slice(0, 5) });
  }
  const { rows: [{ now }] } = await q('SELECT now_ms() AS now');
  res.json({ ok: issues.length === 0, issues, serverTime: now });
}));

// Perbaiki isu: arah perbaikan selalu MELINDUNGI user yang sudah membayar.
r.post('/api/admin/reconcile', ah(async (_req, res) => {
  const out = await tx(async (c) => {
    const expired = (await c.query(
      `UPDATE seats SET status = 'available', held_by = NULL, hold_until = NULL
       WHERE status = 'held' AND hold_until < now_ms()`)).rowCount;
    const paidFix = (await c.query(
      `UPDATE seats SET status = 'sold', held_by = NULL, hold_until = NULL
       WHERE status <> 'sold' AND id IN (SELECT seat_id FROM bookings WHERE status = 'paid')`)).rowCount;
    const soldFix = (await c.query(
      `UPDATE seats SET status = 'available', held_by = NULL, hold_until = NULL
       WHERE status = 'sold' AND id NOT IN (SELECT seat_id FROM bookings WHERE status = 'paid')`)).rowCount;
    return { status: 200, body: { ok: true, released: expired, paidFixed: paidFix, soldFixed: soldFix } };
  });
  if (out.status === 200 && out.body.released + out.body.paidFixed + out.body.soldFixed > 0) invalidateSeatMap();
  res.status(out.status).json(out.body);
}));

module.exports = r;

// ---- Metrik runtime per instance (untuk analisis bottleneck saat stress test) ----
const { monitorEventLoopDelay } = require('perf_hooks');
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

r.get('/api/admin/runtime', (_req, res) => {
  const mem = process.memoryUsage();
  const ms = (ns) => +Math.max(0, ns / 1e6 - 20).toFixed(2);   // kurangi resolusi timer 20 ms (nilai idle = 20)
  const out = {
    instance: require('os').hostname(),
    pool: { max: pool.options.max, total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    eventLoop: { meanMs: ms(loopDelay.mean), p99Ms: ms(loopDelay.percentile(99)), maxMs: ms(loopDelay.max) },
    memory: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576) },
    uptimeS: Math.round(process.uptime()),
  };
  loopDelay.reset();
  res.json(out);
});
