'use strict';
const crypto = require('crypto');
const { Router } = require('express');
const { ah } = require('./infra');
const { tx } = require('./tx');
const { requireAdmitted } = require('./auth');
const { rateLimit } = require('./ratelimit');

const PAY_GRACE_SECONDS = +(process.env.PAY_GRACE_SECONDS || 600);   // hold diperpanjang saat user bayar
const GATEWAY_MS = +(process.env.GATEWAY_MS || 600);                 // simulasi latensi gateway
const METHODS = ['qris', 'ewallet', 'va', 'cc', 'test_fail'];
const r = Router();

// ---- Intent: buat tagihan + perpanjang hold ----
r.post('/api/payments', requireAdmitted, rateLimit('pay', 20, 60_000), ah(async (req, res) => {
  const method = String(req.body?.method || 'qris');
  if (!METHODS.includes(method)) return res.status(400).json({ error: 'Metode pembayaran tidak dikenal' });
  const idem = req.get('idempotency-key');
  const idemKey = idem ? `${req.token}:${idem}` : null;     // scope per user: key sama antar user tidak bocor

  const out = await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [req.token]);   // serialkan per user (sama dgn hold)
    if (idemKey) {
      const { rows: [cached] } = await c.query('SELECT response FROM idempotency WHERE key = $1', [idemKey]);
      if (cached) return { status: 200, body: JSON.parse(cached.response) };
    }
    const { rows } = await c.query(
      `UPDATE seats SET hold_until = GREATEST(hold_until, now_ms() + $2)
       WHERE held_by = $1 AND status = 'held' AND hold_until > now_ms()
       RETURNING id, label, price`, [req.token, PAY_GRACE_SECONDS * 1000]);
    if (!rows.length) return { status: 409, body: { error: 'Tidak ada kursi valid untuk dibayar' }, rollback: true };

    const seats = rows.sort((a, b) => a.id - b.id);
    const amount = seats.reduce((sum, s) => sum + s.price, 0);
    const id = 'PAY-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    await c.query(
      'INSERT INTO payments (id, user_token, amount, method, seat_ids) VALUES ($1, $2, $3, $4, $5)',
      [id, req.token, amount, method, seats.map((s) => s.id)]);
    const body = { paymentId: id, amount, method, seats };
    if (idemKey) {
      await c.query('INSERT INTO idempotency (key, response) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [idemKey, JSON.stringify(body)]);
    }
    return { status: 201, body };
  });
  res.status(out.status).json(out.body);
}));

// ---- Confirm: atomik (semua kursi di tagihan atau tidak sama sekali) dan idempoten ----
r.post('/api/payments/:id/confirm', requireAdmitted, ah(async (req, res) => {
  await new Promise((s) => setTimeout(s, GATEWAY_MS));      // tunggu gateway DI LUAR transaksi: jangan pegang koneksi/lock
  const id = req.params.id;

  const out = await tx(async (c) => {
    const { rows: [p] } = await c.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id]);  // serialkan confirm ganda
    if (!p) return { status: 404, body: { error: 'Payment tidak ditemukan' }, rollback: true };
    if (p.user_token !== req.token) return { status: 403, body: { error: 'Bukan milik Anda' }, rollback: true };

    if (p.status === 'paid') {                               // replay: kembalikan hasil yang sama
      const { rows } = await c.query(
        `SELECT b.code, s.label AS seat, s.price FROM bookings b JOIN seats s ON s.id = b.seat_id
         WHERE b.payment_id = $1 ORDER BY s.id`, [id]);
      return { status: 200, body: { ok: true, bookings: rows, replay: true } };
    }
    if (p.status !== 'pending') return { status: 409, body: { error: `Status payment: ${p.status}` }, rollback: true };

    if (p.method === 'test_fail') {
      await c.query("UPDATE payments SET status = 'failed' WHERE id = $1", [id]);
      return { status: 402, body: { error: 'Pembayaran ditolak oleh gateway (simulasi)' } };
    }

    const { rows: seats } = await c.query(
      `SELECT id, event_id, label, price FROM seats
       WHERE id = ANY($1::int[]) AND held_by = $2 AND status = 'held' AND hold_until > now_ms()
       ORDER BY id FOR UPDATE`, [p.seat_ids, req.token]);
    if (seats.length !== p.seat_ids.length) {
      await c.query("UPDATE payments SET status = 'void' WHERE id = $1", [id]);
      return { status: 409, body: { error: 'Kursi sudah tidak valid (hold kedaluwarsa). Silakan pilih ulang.' } };
    }

    const bookings = [];
    for (const s of seats) {
      const code = 'TIX-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      await c.query("UPDATE seats SET status = 'sold', held_by = NULL, hold_until = NULL WHERE id = $1", [s.id]);
      await c.query(
        `INSERT INTO bookings (code, event_id, seat_id, user_token, payment_id, paid_at)
         VALUES ($1, $2, $3, $4, $5, now_ms())`, [code, s.event_id, s.id, req.token, id]);
      bookings.push({ code, seat: s.label, price: s.price });
    }
    await c.query("UPDATE payments SET status = 'paid', confirmed_at = now_ms() WHERE id = $1", [id]);
    return { status: 200, body: { ok: true, bookings } };
  });
  res.status(out.status).json(out.body);
}));

module.exports = r;
