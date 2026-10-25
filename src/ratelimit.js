'use strict';
const buckets = new Map();

function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const key = name + ':' + (req.get('x-queue-token') || req.ip);
    const t = Date.now();
    let b = buckets.get(key);
    if (!b || t - b.start > windowMs) { b = { start: t, count: 0 }; buckets.set(key, b); }
    if (++b.count > max) {
      res.set('Retry-After', Math.ceil((b.start + windowMs - t) / 1000));
      return res.status(429).json({ error: 'Terlalu banyak permintaan, coba lagi nanti' });
    }
    next();
  };
}
setInterval(() => {                       // bersihkan bucket lama supaya memori tidak membengkak
  const t = Date.now();
  for (const [k, v] of buckets) if (t - v.start > 60_000) buckets.delete(k);
}, 60_000).unref();

module.exports = { rateLimit };
