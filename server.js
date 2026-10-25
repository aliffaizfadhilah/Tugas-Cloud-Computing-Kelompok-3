'use strict';
const express = require('express');
const path = require('path');
const { pool, redis, q, errorHandler } = require('./src/infra');

const PORT = +(process.env.PORT || 3000);
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// liveness: proses hidup? (tidak menyentuh dependensi)
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// readiness: siap melayani? DB wajib; Redis mati = degraded (masih jalan lewat fallback PG)
app.get('/ready', async (_req, res) => {
  const out = { db: false, redis: false };
  try { await q('SELECT 1'); out.db = true; } catch {}
  try { out.redis = (await redis.ping()) === 'PONG'; } catch {}
  res.status(out.db ? 200 : 503).json({ ready: out.db, degraded: !out.redis, ...out });
});

app.use(require('./src/queue'));
// ---- rute lain ditambahkan di sub-tahap berikutnya (4b dst.) ----

app.use(errorHandler);

const server = app.listen(PORT, () => console.log(`API :${PORT}`));
const jobs = require('./src/jobs');
jobs.start();
function shutdown(sig) {
  jobs.stop();
  console.log(`[${sig}] shutting down`);
  server.close(async () => {
    await pool.end().catch(() => {});
    redis.disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
