'use strict';
const { q, ah } = require('./infra');

const cache = new Map();            // token -> kedaluwarsa cache (ms)
const CACHE_MS = 5000;              // singkat: token yang sudah leave tidak lama dianggap valid

const requireAdmitted = ah(async (req, res, next) => {
  const token = req.get('x-queue-token');
  if (!token) return res.status(403).json({ error: 'Belum masuk dari antrean' });
  const hit = cache.get(token);
  if (!(hit && hit > Date.now())) {
    const { rows: [r] } = await q('SELECT admitted_at FROM queue_tokens WHERE token = $1', [token]);
    if (!r || !r.admitted_at) return res.status(403).json({ error: 'Belum diizinkan masuk (antrean belum tiba)' });
    cache.set(token, Date.now() + CACHE_MS);
  }
  req.token = token;
  next();
});

setInterval(() => {
  const t = Date.now();
  for (const [k, v] of cache) if (v < t) cache.delete(k);
}, 30_000).unref();

module.exports = { requireAdmitted };
