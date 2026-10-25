'use strict';
const { pool } = require('./infra');

// Jalankan fn(client) dalam satu transaksi. fn mengembalikan { status, body, rollback? }.
// Respons baru dikirim SETELAH commit/rollback selesai, jadi klien tidak pernah menerima
// "sukses" untuk transaksi yang ternyata gagal commit (misal DB mati di tengah jalan).
async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query(out.rollback ? 'ROLLBACK' : 'COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

module.exports = { tx };
