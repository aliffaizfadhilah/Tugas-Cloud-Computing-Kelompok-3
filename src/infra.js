'use strict';
const { Pool } = require('pg');
const Redis = require('ioredis');
require('pg').types.setTypeParser(20, (v) => Number(v));   // BIGINT (ms epoch) -> number

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: +(process.env.PG_POOL_MAX || 15),
  connectionTimeoutMillis: 3000,
  statement_timeout: 5000,
});
pool.on('error', (e) => console.error('[pg idle]', e.message)); // tanpa ini, error koneksi idle mematikan proses

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,            // Redis mati -> gagal cepat, jangan antre
  commandTimeout: 1000,
  retryStrategy: (n) => Math.min(n * 200, 2000),
});
let lastRedisErr = '';
redis.on('error', (e) => {              // log sekali per jenis error, bukan banjir log
  if (e.message !== lastRedisErr) { lastRedisErr = e.message; console.error('[redis]', e.message); }
});
redis.on('ready', () => { if (lastRedisErr) console.log('[redis] pulih'); lastRedisErr = ''; });

const q = (text, params) => pool.query(text, params);
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const INFRA = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '57P01', '57P03', '08006', '08001']);
function errorHandler(err, _req, res, _next) {
  console.error('[err]', err.code || '', err.message);
  if (INFRA.has(err.code) || /Connection terminated|timeout/i.test(err.message)) {
    res.set('Retry-After', '2');
    return res.status(503).json({ error: 'Layanan sedang pemulihan, coba lagi sebentar' });
  }
  res.status(500).json({ error: 'Internal error' });
}

module.exports = { pool, redis, q, ah, errorHandler };
