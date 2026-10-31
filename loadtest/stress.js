// loadtest/stress.js — k6: stress test antrean dan booking kursi
//   FLOW=booking (default): join -> tunggu diizinkan -> lihat peta kursi / hold / release
//   FLOW=queue            : join -> polling status saja (ruang tunggu saat lonjakan)
//   MODE=stage (default)  : naik ke VUS dalam RAMP, tahan HOLD
//   MODE=ramp             : tangga 10,100,250,500,750,1000 VU, masing-masing 1 menit
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://nginx';
const VUS = parseInt(__ENV.VUS || '10', 10);
const FLOW = __ENV.FLOW || 'booking';
const MODE = __ENV.MODE || 'stage';
const RAMP = __ENV.RAMP || '30s';
const HOLD = __ENV.HOLD || '2m';
const TAG = __ENV.TAG || 'base';
const OUT_DIR = __ENV.OUT_DIR || '/out';
const SEATS = 60;

// 409 (kursi sudah diambil) dan 429 (rate limit) adalah respons NORMAL, bukan kegagalan sistem.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409, 429));

const serverErrors = new Rate('server_errors');   // 5xx atau timeout/koneksi gagal
const err500 = new Counter('err_500');
const err503 = new Counter('err_503');
const err5xxOther = new Counter('err_5xx_other');
const errTimeout = new Counter('err_timeout');    // status 0: timeout, reset, atau koneksi ditolak
const holdOk = new Counter('hold_ok');
const holdConflict = new Counter('hold_conflict');

const stages = MODE === 'ramp'
  ? [10, 100, 250, 500, 750, 1000].map((t) => ({ duration: '1m', target: t }))
  : [{ duration: RAMP, target: VUS }, { duration: HOLD, target: VUS }, { duration: '10s', target: 0 }];

const thresholds = {
  http_req_failed: ['rate<0.01'],
  server_errors: ['rate<0.01'],
  http_req_duration: ['p(95)<1000'],
  'http_req_duration{name:join}': ['p(95)<1000'],
  'http_req_duration{name:status}': ['p(95)<1000'],
};
if (FLOW === 'booking') {
  thresholds['http_req_duration{name:seats}'] = ['p(95)<1000'];
  thresholds['http_req_duration{name:hold}'] = ['p(95)<1500'];
}

export const options = {
  scenarios: { load: { executor: 'ramping-vus', startVUs: 0, stages, gracefulRampDown: '10s', gracefulStop: '30s' } },
  thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  userAgent: 'k6-konser-stress',
};

function call(method, path, name, token, body) {
  const params = { tags: { name }, headers: {}, timeout: '10s' };
  if (token) params.headers['x-queue-token'] = token;
  if (body) params.headers['content-type'] = 'application/json';
  const url = BASE + path;
  const res = method === 'GET' ? http.get(url, params) : http.post(url, body ? JSON.stringify(body) : null, params);
  serverErrors.add(res.status >= 500 || res.status === 0);
  if (res.status === 500) err500.add(1);
  else if (res.status === 503) err503.add(1);
  else if (res.status > 500) err5xxOther.add(1);
  else if (res.status === 0) errTimeout.add(1);
  return res;
}

// Status per VU (variabel level modul dibuat sekali per VU dan bertahan antar iterasi)
let token = null;
let admitted = false;

export default function () {
  if (!token) {
    const r = call('POST', '/api/queue/join', 'join', null, { label: `vu${__VU}` });
    check(r, { 'join 201': (x) => x.status === 201 });
    if (r.status === 201) token = r.json('token');
    sleep(1);
    return;
  }

  if (!admitted || FLOW === 'queue') {
    const r = call('GET', `/api/queue/status/${token}`, 'status', null);
    check(r, { 'status 200': (x) => x.status === 200 });
    if (r.status === 200 && r.json('admitted') === true) admitted = true;
    else if (r.status === 404) { token = null; admitted = false; }   // token hilang (mis. DB di-reset)
    if (FLOW === 'queue' || !admitted) { sleep(1); return; }
  }

  const dice = Math.random();
  if (dice < 0.6) {                                    // 60%: lihat peta kursi
    const r = call('GET', '/api/events/1/seats', 'seats', token);
    check(r, { 'seats 200': (x) => x.status === 200 });
  } else if (dice < 0.95) {                            // 35%: coba hold, lalu lepas bila berhasil
    const id = 1 + Math.floor(Math.random() * SEATS);
    const h = call('POST', `/api/seats/${id}/hold`, 'hold', token);
    if (h.status === 200) {
      holdOk.add(1);
      sleep(0.5);
      call('POST', `/api/seats/${id}/release`, 'release', token);
    } else if (h.status === 409) holdConflict.add(1);
    else if (h.status === 403) admitted = false;       // token tidak lagi sah
  } else {                                             // 5%: cek status sendiri
    call('GET', `/api/queue/status/${token}`, 'status', null);
  }
  sleep(1 + Math.random() * 2);                        // waktu berpikir pengguna
}

const val = (m, k) => (m && m.values && m.values[k] !== undefined ? m.values[k] : null);
const cnt = (m) => val(m, 'count') || 0;
const fx = (n, d = 0) => (n === null || n === undefined ? '-' : Number(n).toFixed(d));

export function handleSummary(data) {
  const M = data.metrics;
  const D = M.http_req_duration;
  const endpoints = {};
  for (const n of ['join', 'status', 'seats', 'hold', 'release']) {
    const s = M[`http_req_duration{name:${n}}`];
    if (s) endpoints[n] = { avg: val(s, 'avg'), p95: val(s, 'p(95)'), max: val(s, 'max') };
  }
  const failedThresholds = Object.entries(M)
    .filter(([, v]) => v.thresholds && Object.values(v.thresholds).some((t) => t.ok === false))
    .map(([k]) => k);
  const out = {
    tag: TAG, flow: FLOW, mode: MODE, vus: VUS,
    reqs: cnt(M.http_reqs), rps: val(M.http_reqs, 'rate'),
    avg: val(D, 'avg'), p50: val(D, 'med'), p90: val(D, 'p(90)'), p95: val(D, 'p(95)'), p99: val(D, 'p(99)'), max: val(D, 'max'),
    failed_rate: val(M.http_req_failed, 'rate'), server_error_rate: val(M.server_errors, 'rate'),
    err_500: cnt(M.err_500), err_503: cnt(M.err_503), err_5xx_other: cnt(M.err_5xx_other), err_timeout: cnt(M.err_timeout),
    hold_ok: cnt(M.hold_ok), hold_conflict: cnt(M.hold_conflict),
    iterations: cnt(M.iterations), endpoints, thresholds_failed: failedThresholds,
  };
  const sloOk = (out.server_error_rate || 0) < 0.01 && (out.p95 || 0) < 1000;
  const text = [
    '',
    `=== [${TAG}] ${FLOW} @ ${VUS} VU : ${sloOk ? 'MEMENUHI SLO' : 'MELANGGAR SLO'} (p95 < 1000 ms, error < 1%) ===`,
    `request      : ${out.reqs}  (${fx(out.rps, 1)} req/s)`,
    `latensi (ms) : avg ${fx(out.avg)}  p50 ${fx(out.p50)}  p95 ${fx(out.p95)}  p99 ${fx(out.p99)}  max ${fx(out.max)}`,
    `error server : ${fx((out.server_error_rate || 0) * 100, 2)}%  (500: ${out.err_500}, 503: ${out.err_503}, 5xx lain: ${out.err_5xx_other}, timeout/koneksi: ${out.err_timeout})`,
    `hold         : berhasil ${out.hold_ok}, bentrok(409) ${out.hold_conflict}`,
    ...Object.entries(endpoints).map(([n, e]) => `  ${n.padEnd(8)} avg ${fx(e.avg).padStart(6)} ms   p95 ${fx(e.p95).padStart(6)} ms`),
    out.thresholds_failed.length ? `threshold gagal: ${out.thresholds_failed.join(', ')}` : 'semua threshold terpenuhi',
    '',
  ].join('\n');
  return { [`${OUT_DIR}/summary-${TAG}-${FLOW}-${VUS}.json`]: JSON.stringify(out, null, 2), stdout: text };
}
