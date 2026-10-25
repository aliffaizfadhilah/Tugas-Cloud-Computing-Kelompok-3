'use strict';
const { Router } = require('express');
const { pool, q, ah } = require('./infra');
const { requireAdmitted } = require('./auth');
const { rateLimit } = require('./ratelimit');

const HOLD_SECONDS = +(process.env.HOLD_SECONDS || 300);
const MAX_SEATS_PER_USER = +(process.env.MAX_SEATS_PER_USER || 4);
const r = Router();

const intParam = (v) => { const n = Number.parseInt(v, 10); return Number.isInteger(n) ? n : null; };

r.get('/api/events', ah(async (_req, res) => {
  const { rows } = await q('SELECT * FROM events ORDER BY id');
  res.json({ events: rows });
}));

r.get('/api/events/:id/seats', ah(async (req, res) => {
  const id = intParam(req.params.id);
  if (id === null) return res.status(400).json({ error: 'ID event tidak valid' });
  const { rows: [event] } = await q('SELECT * FROM events WHERE id = $1', [id]);
  if (!event) return res.status(404).json({ error: 'Event tidak ada' });

  const { rows: [{ now }] } = await q('SELECT now_ms() AS now');   // satu jam untuk semua: jam DB
  const reqToken = req.get('x-queue-token');
  const { rows } = await q(
    `SELECT s.id, s.label, s.price, s.status, s.held_by, s.hold_until, qt.label AS holder_label
     FROM seats s LEFT JOIN queue_tokens qt ON qt.token = s.held_by
     WHERE s.event_id = $1 ORDER BY s.id`, [id]);

  const seats = rows.map((s) => {
    const expired = s.status === 'held' && s.hold_until < now;   // kedaluwarsa tapi belum disapu -> tampil tersedia
    const held = s.status === 'held' && !expired;
    return {
      id: s.id, label: s.label, price: s.price,
      status: expired ? 'available' : s.status,
      holdUntil: held ? s.hold_until : null,
      mine: held && s.held_by === reqToken,
      heldByLabel: held ? (s.holder_label || null) : null,
    };
  });
  res.json({ event, seats, serverTime: now });
}));

r.post('/api/seats/:id/hold', requireAdmitted, rateLimit('hold', 60, 60_000), ah(async (req, res) => {
  const seatId = intParam(req.params.id);
  if (seatId === null) return res.status(400).json({ error: 'ID kursi tidak valid' });

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [req.token]);   // serialkan request per user
    const { rows: [m] } = await c.query(
      `SELECT COUNT(*)::int AS n FROM seats
       WHERE held_by = $1 AND status = 'held' AND hold_until > now_ms()`, [req.token]);
    if (m.n >= MAX_SEATS_PER_USER) {
      await c.query('ROLLBACK');
      return res.status(409).json({ error: `Maksimal ${MAX_SEATS_PER_USER} kursi per pengguna` });
    }
    const upd = await c.query(
      `UPDATE seats SET status = 'held', held_by = $1, hold_until = now_ms() + $2
       WHERE id = $3 AND (status = 'available' OR (status = 'held' AND hold_until < now_ms()))`,
      [req.token, HOLD_SECONDS * 1000, seatId]);
    if (upd.rowCount !== 1) {
      await c.query('ROLLBACK');
      return res.status(409).json({ error: 'Kursi sudah dipesan / di-hold orang lain' });
    }
    await c.query('COMMIT');
    res.json({ ok: true, holdSeconds: HOLD_SECONDS });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}));

r.post('/api/seats/:id/release', requireAdmitted, ah(async (req, res) => {
  const seatId = intParam(req.params.id);
  if (seatId === null) return res.status(400).json({ error: 'ID kursi tidak valid' });
  await q(`UPDATE seats SET status = 'available', held_by = NULL, hold_until = NULL
           WHERE id = $1 AND held_by = $2 AND status = 'held'`, [seatId, req.token]);
  res.json({ ok: true });
}));

module.exports = r;
