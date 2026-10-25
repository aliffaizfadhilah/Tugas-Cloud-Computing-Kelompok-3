'use strict';
const { Router } = require('express');
const { q, ah } = require('./infra');
const { tx } = require('./tx');
const { requireAdmitted } = require('./auth');

const r = Router();
const BASE = `SELECT b.code, b.status, b.created_at, b.paid_at, b.refunded_at,
                     s.label AS seat, s.price, e.name AS event, e.venue, e.event_date
              FROM bookings b
              JOIN seats s ON s.id = b.seat_id
              JOIN events e ON e.id = b.event_id`;

r.get('/api/bookings', requireAdmitted, ah(async (req, res) => {
  const { rows } = await q(`${BASE} WHERE b.user_token = $1 ORDER BY b.created_at DESC, b.id DESC`, [req.token]);
  res.json({ bookings: rows });
}));

r.get('/api/bookings/:code', requireAdmitted, ah(async (req, res) => {
  const { rows: [b] } = await q(`${BASE} WHERE b.code = $1 AND b.user_token = $2`, [req.params.code, req.token]);
  if (!b) return res.status(404).json({ error: 'Tiket tidak ditemukan' });
  res.json({ booking: b });
}));

r.post('/api/bookings/:code/refund', requireAdmitted, ah(async (req, res) => {
  const out = await tx(async (c) => {
    const { rows: [b] } = await c.query('SELECT * FROM bookings WHERE code = $1 FOR UPDATE', [req.params.code]);
    if (!b) return { status: 404, body: { error: 'Tiket tidak ditemukan' }, rollback: true };
    if (b.user_token !== req.token) return { status: 403, body: { error: 'Bukan milik Anda' }, rollback: true };
    if (b.status !== 'paid') return { status: 409, body: { error: 'Tiket tidak bisa direfund' }, rollback: true };

    await c.query("UPDATE bookings SET status = 'refunded', refunded_at = now_ms() WHERE id = $1", [b.id]);
    await c.query(
      "UPDATE seats SET status = 'available', held_by = NULL, hold_until = NULL WHERE id = $1 AND status = 'sold'", [b.seat_id]);
    if (b.payment_id) {      // payment baru 'refunded' kalau SEMUA tiketnya sudah direfund
      await c.query(
        `UPDATE payments SET status = 'refunded'
         WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM bookings WHERE payment_id = $1 AND status = 'paid')`,
        [b.payment_id]);
    }
    return { status: 200, body: { ok: true } };
  });
  res.status(out.status).json(out.body);
}));

module.exports = r;
