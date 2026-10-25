'use strict';
const crypto = require('crypto');
const { Router } = require('express');
const { redis, q, ah } = require('./infra');
const { rateLimit } = require('./ratelimit');

const ADMIT_PER_TICK = +(process.env.ADMIT_PER_TICK || 5);
const ADMIT_INTERVAL_MS = +(process.env.ADMIT_INTERVAL_MS || 2000);
const QKEY = process.env.QUEUE_KEY || 'queue:waiting';
const r = Router();

let rehydrating = null;
function rehydrate() {            // pulihkan seluruh antrean Redis dari Postgres, urutan asli (joined_at)
  if (!rehydrating) {
    rehydrating = (async () => {
      try {
        const { rows } = await q('SELECT token, joined_at FROM queue_tokens WHERE admitted_at IS NULL');
        if (rows.length) {
          const args = [];
          for (const x of rows) args.push(x.joined_at, x.token);
          await redis.zadd(QKEY, ...args);
        }
      } finally { setTimeout(() => { rehydrating = null; }, 2000); }   // maksimal sekali per 2 detik
    })();
  }
  return rehydrating;
}
r.post('/api/queue/join', rateLimit('join', 30, 60_000), ah(async (req, res) => {
  const token = crypto.randomUUID();
  const label = String(req.body?.label || '').trim().slice(0, 40) || null;
  const { rows: [row] } = await q(
    'INSERT INTO queue_tokens (token, label) VALUES ($1, $2) RETURNING joined_at', [token, label]);
  redis.zadd(QKEY, row.joined_at, token).catch(() => {});   // Redis gagal? tidak masalah, status() memulihkannya
  res.status(201).json({ token, label });
}));

r.get('/api/queue/status/:token', ah(async (req, res) => {
  const { rows: [row] } = await q('SELECT * FROM queue_tokens WHERE token = $1', [req.params.token]);
  if (!row) return res.status(404).json({ error: 'Token tidak dikenal' });
  if (row.admitted_at) return res.json({ admitted: true, admittedAt: row.admitted_at, label: row.label });

  let position, total;
  try {
        let rank = await redis.zrank(QKEY, row.token);
    if (rank === null) { await rehydrate(); rank = await redis.zrank(QKEY, row.token); }
    if (rank === null) throw new Error('belum ada di Redis');   // jatuh ke fallback Postgres
    position = rank + 1;
    total = await redis.zcard(QKEY);
  } catch {                                                 // fallback: hitung dari Postgres
    const { rows: [c] } = await q(
      `SELECT (COUNT(*) FILTER (WHERE joined_at < $1))::int + 1 AS pos, COUNT(*)::int AS total
       FROM queue_tokens WHERE admitted_at IS NULL`, [row.joined_at]);
    position = c.pos; total = c.total;
  }
  const etaSec = Math.ceil(position / ADMIT_PER_TICK) * Math.round(ADMIT_INTERVAL_MS / 1000);
  res.json({ admitted: false, position, total, etaSec, label: row.label });
}));

r.post('/api/queue/leave', ah(async (req, res) => {
  const token = req.get('x-queue-token');
  if (token) {
    await q(`UPDATE seats SET status='available', held_by=NULL, hold_until=NULL
             WHERE held_by = $1 AND status = 'held'`, [token]);   // keluar sukarela -> hold dilepas
    await q('DELETE FROM queue_tokens WHERE token = $1', [token]);
    redis.zrem(QKEY, token).catch(() => {});
  }
  res.json({ ok: true });
}));

module.exports = r;
