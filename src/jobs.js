'use strict';
const { pool, redis, q } = require('./infra');

const ADMIT_PER_TICK = +(process.env.ADMIT_PER_TICK || 5);
const ADMIT_INTERVAL_MS = +(process.env.ADMIT_INTERVAL_MS || 2000);
const QKEY = process.env.QUEUE_KEY || 'queue:waiting';

const pendingZrem = new Set();    // token yang sudah admitted tapi belum terhapus dari Redis
let timer = null;
let busy = false;

async function admitTick() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [lock] } = await c.query('SELECT pg_try_advisory_xact_lock(42) AS ok');
    if (!lock.ok) { await c.query('ROLLBACK'); return; }     // instance lain yang sedang admit
    const { rows } = await c.query(
      `UPDATE queue_tokens SET admitted_at = now_ms() WHERE token IN (
         SELECT token FROM queue_tokens WHERE admitted_at IS NULL
         ORDER BY joined_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING token`, [ADMIT_PER_TICK]);
    await c.query('COMMIT');
    rows.forEach((r) => pendingZrem.add(r.token));
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('[admit]', e.message);
  } finally { c.release(); }

  if (pendingZrem.size) {                                    // bersihkan Redis; gagal? coba lagi tick berikutnya
    const batch = [...pendingZrem];
    try { await redis.zrem(QKEY, ...batch); batch.forEach((t) => pendingZrem.delete(t)); } catch {}
  }
}

async function sweepExpired() {
  await q(`UPDATE seats SET status='available', held_by=NULL, hold_until=NULL
           WHERE status='held' AND hold_until < now_ms()`);
}

async function tick() {
  if (busy) return;               // jangan tumpuk tick kalau DB sedang lambat
  busy = true;
  try { await admitTick(); await sweepExpired(); }
  catch (e) { console.error('[tick]', e.message); }
  finally { busy = false; }
}

module.exports = {
  start() { timer = setInterval(tick, ADMIT_INTERVAL_MS); },
  stop() { clearInterval(timer); },
};
