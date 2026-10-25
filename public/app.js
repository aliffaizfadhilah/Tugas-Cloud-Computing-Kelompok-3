/* Konser Ticketing — frontend Kelompok 3 (multi-session) */
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ---------- API client (token diganti saat switch sesi) ---------- */
const api = {
  token: '',
  async req(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['x-queue-token'] = this.token;
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    let res;
    try { res = await fetch(path, { ...opts, headers }); }
    catch { markDown(true); const e = new Error('Server tidak terjangkau'); e.status = 0; throw e; }
    markDown(res.status === 503);
    let data = null; try { data = await res.json(); } catch {}
    if (!res.ok) { const e = new Error((data && data.error) || res.statusText); e.status = res.status; e.data = data; throw e; }
    return data;
  },
};

/* ---------- State ---------- */
const state = {
  sessions: [],           // [{token, label}]
  admitted: false,
  event: null,
  seats: [],
  myTickets: [],
  seatTimer: null, clockTimer: null, queueTimer: null, ticketTimer: null, sysTimer: null,
  pendingIntent: null,
};

/* ---------- Session storage ---------- */
function loadSessions() {
  try { return JSON.parse(localStorage.getItem('k3.sessions') || '[]'); } catch { return []; }
}
function saveSessions(list) { localStorage.setItem('k3.sessions', JSON.stringify(list)); }

function upsertSession(token, label) {
  const list = loadSessions();
  const idx = list.findIndex(s => s.token === token);
  if (idx >= 0) list[idx].label = label || list[idx].label;
  else list.push({ token, label: label || null });
  saveSessions(list);
  state.sessions = list;
}

function deleteSession(token) {
  const list = loadSessions().filter(s => s.token !== token);
  saveSessions(list);
  state.sessions = list;
  if (api.token === token) {
    // fallback ke sesi lain
    const next = list[0]?.token || '';
    api.token = next;
    localStorage.setItem('k3.token', next);
    switchSession(next);
  } else {
    renderSessions();
  }
}

/* ---------- UI helpers ---------- */
function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg;
  $('toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3200);
}
function setPill(text, kind) {
  const p = $('sessionPill');
  p.textContent = text;
  p.className = 'pill' + (kind ? ' ' + kind : '');
}
function fmtRp(n) { return 'Rp' + (n || 0).toLocaleString('id-ID'); }
function fmtTime(ms) {
  if (ms == null) return '—';
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
}
function currentSession() { return state.sessions.find(s => s.token === api.token); }

/* ---------- Session list ---------- */
function renderSessions() {
  const list = $('sessionList');
  if (!state.sessions.length) {
    list.innerHTML = '<p class="muted small">Belum ada sesi. Buat sesi baru di bawah ↓</p>';
    return;
  }
  list.innerHTML = '';
  state.sessions.forEach((s, i) => {
    const isActive = s.token === api.token;
    const el = document.createElement('div');
    el.className = 'session-item' + (isActive ? ' active' : '');
    el.innerHTML = `
      <div>
        <strong>${escapeHtml(s.label || `Sesi ${i+1}`)}</strong>
        <div class="muted small">${escapeHtml(s.token.slice(0,8))}…</div>
      </div>
      <div class="row">
        ${isActive
          ? '<span class="pill ok small">Aktif</span>'
          : '<button class="ghost small" data-act="switch">Aktifkan</button>'}
        <button class="ghost small" data-act="del">Hapus</button>
      </div>`;
    el.querySelector('[data-act="switch"]')?.addEventListener('click', () => switchSession(s.token));
    el.querySelector('[data-act="del"]')?.addEventListener('click', () => deleteSession(s.token));
    list.appendChild(el);
  });
}

/* ---------- Queue ---------- */
async function createSession(label) {
  try {
    const { token } = await api.req('/api/queue/join', {
      method: 'POST',
      body: JSON.stringify({ label }),
    });
    upsertSession(token, label);
    await switchSession(token);
    toast('Sesi baru dibuat', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function switchSession(token) {
  stopAllTimers();
  api.token = token || '';
  if (token) localStorage.setItem('k3.token', token);
  else localStorage.removeItem('k3.token');

  // reset visual state
  state.admitted = false;
  $('holdbar').hidden = true;
  $('ticketList').innerHTML = '<p class="muted">Belum ada tiket.</p>';
  renderSessions();

  if (!token) {
    setPill('Tanpa sesi', '');
    $('queueMsg').textContent = 'Pilih sesi atau buat sesi baru.';
    $('joinBtn').disabled = true;
    $('leaveBtn').hidden = true;
    updateSpectatorMode();
    await loadSeats(); // spectator
    return;
  }

  setPill('Memeriksa sesi…', 'warn');
  $('joinBtn').disabled = false;
  $('leaveBtn').hidden = false;
  try {
    const s = await api.req('/api/queue/status/' + token);
    if (s.admitted) onAdmitted();
    else onWaiting(s);
  } catch (e) {
    if (e.status === 404) {
      // token expired (server restart dgn DB baru / session TTL)
      onExpired();
    } else {
      toast(e.message, 'err');
    }
  }
  await loadSeats();
  updateSpectatorMode();
}

function onAdmitted() {
  state.admitted = true;
  setPill('Sesi aktif', 'ok');
  $('queueMsg').textContent = '✅ Anda boleh memilih kursi.';
  $('queueBar').style.width = '100%';
  $('joinBtn').disabled = true;
  $('joinBtn').textContent = 'Masuk Antrean';
  updateSpectatorMode();
  loadTickets();
  startSeatPolling();
  startClock();
  startTicketPolling();
}

function onWaiting(s) {
  state.admitted = false;
  setPill('Menunggu antrean', 'warn');
  $('queueMsg').textContent = `Posisi: #${s.position} dari ${s.total} · ETA ${s.etaSec}s`;
  $('queueStat').textContent = `menunggu ${s.total} orang`;
  const pct = s.total > 1 ? Math.min(100, Math.max(4, 100 - ((s.position - 1) / s.total) * 100)) : 100;
  $('queueBar').style.width = pct + '%';
  $('joinBtn').disabled = true;
  updateSpectatorMode();
  startQueuePolling();
}

function onExpired() {
  state.admitted = false;
  setPill('Sesi kedaluwarsa', 'bad');
  $('queueMsg').textContent = 'Sesi ini sudah tidak dikenal server. Hapus dan buat sesi baru.';
  $('joinBtn').disabled = true;
  updateSpectatorMode();
}

function startQueuePolling() {
  stopQueuePolling();
  state.queueTimer = setInterval(async () => {
    try {
      const s = await api.req('/api/queue/status/' + api.token);
      if (s.admitted) { stopQueuePolling(); onAdmitted(); }
      else onWaiting(s);
    } catch (e) {
      if (e.status === 404) { stopQueuePolling(); onExpired(); }
    }
  }, 1200);
}
function stopQueuePolling() { if (state.queueTimer) clearInterval(state.queueTimer); state.queueTimer = null; }

async function leaveActiveSession() {
  if (!confirm('Keluar dari antrean & lepas semua hold sesi ini?')) return;
  try { await api.req('/api/queue/leave', { method: 'POST' }); } catch {}
  const tok = api.token;
  deleteSession(tok);
}

/* ---------- Seats ---------- */
function updateSpectatorMode() {
  const notice = $('spectatorNotice');
  if (state.admitted) notice.hidden = true;
  else notice.hidden = false;
}

async function loadSeats() {
  try {
    const d = await api.req('/api/events/1/seats');
    state.event = d.event;
    state.seats = d.seats;
    $('eventTitle').textContent = d.event.name;
    $('eventVenue').textContent = d.event.venue + ' · ' + d.event.event_date;
    renderSeats();
    if (state.admitted) updateHoldBar();
  } catch (e) { console.error(e); }
}

function seatTitle(s) {
  const parts = [`${s.label} · ${fmtRp(s.price)}`];
  if (s.status === 'sold') parts.push('Terjual');
  else if (s.status === 'held') {
    const who = s.mine ? 'Anda' : (s.heldByLabel || 'pengguna lain');
    parts.push(`Di-hold oleh ${who}`);
    if (s.holdUntil) parts.push(`sisa ${fmtTime(s.holdUntil - Date.now())}`);
  } else parts.push('Tersedia');
  return parts.join(' · ');
}

function renderSeats() {
  const map = $('seatmap');
  const rows = {};
  for (const s of state.seats) (rows[s.label[0]] ||= []).push(s);
  map.innerHTML = '';
  for (const row of Object.keys(rows).sort()) {
    const wrap = document.createElement('div'); wrap.className = 'seatrow';
    const price = rows[row][0].price;
    const lab = document.createElement('div'); lab.className = 'rowlabel';
    lab.innerHTML = `<div style="font-weight:700;color:var(--text)">${row}</div><div>${fmtRp(price)}</div>`;
    wrap.appendChild(lab);

    const seatsEl = document.createElement('div'); seatsEl.className = 'seats';
    for (const s of rows[row]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'seat ' + (s.mine && s.status === 'held' ? 'mine' : s.status);
      btn.textContent = s.label.slice(1);
      btn.title = seatTitle(s);

      // indikator pemegang hold (kalau bukan mine)
      if (s.status === 'held' && !s.mine && s.heldByLabel) {
        btn.dataset.holder = s.heldByLabel.slice(0, 1).toUpperCase();
      }

      // semua tombol selalu bisa diklik supaya bisa kasih feedback
      btn.onclick = () => handleSeatClick(s);
      seatsEl.appendChild(btn);
    }
    wrap.appendChild(seatsEl);
    map.appendChild(wrap);
  }
}

async function handleSeatClick(s) {
  if (!state.admitted) {
    toast('Masuk antrean dulu untuk memilih kursi', 'warn');
    return;
  }
  try {
    if (s.status === 'sold') { toast('Kursi sudah terjual', 'warn'); return; }
    if (s.status === 'held' && !s.mine) {
      toast(`Di-hold oleh ${s.heldByLabel || 'pengguna lain'}`, 'warn'); return;
    }
    if (s.mine && s.status === 'held') {
      await api.req(`/api/seats/${s.id}/release`, { method: 'POST' });
      toast(`Kursi ${s.label} dilepas`, 'info');
    } else {
      await api.req(`/api/seats/${s.id}/hold`, { method: 'POST' });
      toast(`Kursi ${s.label} di-hold`, 'ok');
    }
    await loadSeats();
  } catch (e) { toast(e.message, 'err'); }
}

function myHolds() { return state.seats.filter(s => s.mine && s.status === 'held'); }

function updateHoldBar() {
  const holds = myHolds();
  if (!holds.length) { $('holdbar').hidden = true; return; }
  $('holdbar').hidden = false;
  $('holdCount').textContent = holds.length;
  $('holdLabels').textContent = holds.map(s => s.label).join(', ');
  updateHoldTimer();
}

function updateHoldTimer() {
  const holds = myHolds();
  if (!holds.length) return;
  const minUntil = Math.min(...holds.map(s => s.holdUntil || 0));
  const remaining = minUntil - Date.now();
  const el = $('holdTimer');
  el.textContent = fmtTime(remaining);
  el.classList.toggle('urgent', remaining < 60_000);
  if (remaining <= 0) loadSeats();
}

/* ---------- Checkout ---------- */
function openCheckout() {
  const holds = myHolds();
  if (!holds.length) return toast('Tidak ada kursi dipilih', 'warn');
  const total = holds.reduce((a, s) => a + s.price, 0);
  $('checkoutSummary').innerHTML =
    holds.map(s => `<div class="line"><span>${s.label}</span><span>${fmtRp(s.price)}</span></div>`).join('') +
    `<div class="line total"><span>Total</span><span>${fmtRp(total)}</span></div>`;
  $('checkoutMsg').textContent = '';
  $('confirmPayBtn').disabled = false;
  state.pendingIntent = { idempotencyKey: crypto.randomUUID() };
  $('checkoutModal').hidden = false;
}

async function payNow() {
  const method = document.querySelector('input[name="pm"]:checked').value;
  const btn = $('confirmPayBtn'); btn.disabled = true;
  $('checkoutMsg').textContent = 'Menghubungi gateway…';
  try {
    const intent = await api.req('/api/payments', {
      method: 'POST', body: JSON.stringify({ method }),
      idempotencyKey: state.pendingIntent.idempotencyKey,
    });
    $('checkoutMsg').textContent = `Memproses ${fmtRp(intent.amount)} via ${intent.method.toUpperCase()}…`;
    const res = await api.req(`/api/payments/${intent.paymentId}/confirm`, { method: 'POST', body: '{}' });
    $('checkoutModal').hidden = true;
    toast('Pembayaran berhasil: ' + res.bookings.map(b => b.seat).join(', '), 'ok');
    await loadSeats(); await loadTickets();
  } catch (e) {
    $('checkoutMsg').textContent = e.message;
    toast(e.message, 'err');
    btn.disabled = false;
  }
}

/* ---------- Tickets ---------- */
async function loadTickets() {
  if (!state.admitted) return;
  try {
    const { bookings } = await api.req('/api/bookings');
    state.myTickets = bookings;
    renderTickets();
  } catch (e) { if (e.status === 403) onExpired(); }
}

function renderTickets() {
  const box = $('ticketList');
  if (!state.myTickets.length) { box.innerHTML = '<p class="muted">Belum ada tiket.</p>'; return; }
  box.innerHTML = '';
  for (const b of state.myTickets) {
    const card = document.createElement('div');
    card.className = 'ticket' + (b.status === 'refunded' ? ' refunded' : '');
    card.innerHTML = `
      <span class="badge">${b.status.toUpperCase()}</span>
      <div class="code">${b.code}</div>
      <div class="seat">${b.seat}</div>
      <div class="meta">${fmtRp(b.price)} · ${new Date(b.paid_at || b.created_at).toLocaleString('id-ID')}</div>`;
    card.onclick = () => showTicket(b);
    box.appendChild(card);
  }
}

/* ---------- Pseudo-QR ---------- */
function qrDataURL(text, size = 25) {
  const grid = Array.from({ length: size }, () => Array(size).fill(0));
  const finder = (ox, oy) => {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const on = x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
      grid[oy + y][ox + x] = on ? 1 : 0;
    }
  };
  const inFinder = (x, y) => (x < 8 && y < 8) || (x >= size - 8 && y < 8) || (x < 8 && y >= size - 8);
  finder(0, 0); finder(size - 7, 0); finder(0, size - 7);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h; };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (inFinder(x, y)) continue;
    grid[y][x] = rnd() & 1;
  }
  let rects = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
    if (grid[y][x]) rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#0f172a">${rects}</g></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function showTicket(b) {
  const canRefund = b.status === 'paid';
  $('ticketDetail').innerHTML = `
    <h3>E-Tiket</h3>
    <img class="qr" alt="QR" src="${qrDataURL(b.code)}">
    <div class="code" style="font-family:ui-monospace;font-weight:700">${b.code}</div>
    <div class="seat" style="font-size:22px;font-weight:700;margin:8px 0">${b.seat}</div>
    <div class="muted">${b.event}<br>${b.venue} · ${b.event_date}</div>
    <div style="margin-top:8px">${fmtRp(b.price)}</div>
    ${canRefund ? '<button id="refundBtn" class="ghost" style="margin-top:12px">Refund Tiket</button>' : '<p class="muted small">Tiket sudah direfund</p>'}`;
  $('ticketModal').hidden = false;
  const r = $('refundBtn');
  if (r) r.onclick = async () => {
    if (!confirm('Yakin refund tiket ' + b.code + '?')) return;
    try {
      await api.req(`/api/bookings/${b.code}/refund`, { method: 'POST' });
      toast('Refund berhasil', 'ok');
      $('ticketModal').hidden = true;
      await loadTickets(); await loadSeats();
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ---------- System panel ---------- */
async function refreshSystem() {
  try {
    const h = await fetch('/health').then(r => r.json());
    $('sysHealth').innerHTML = h.status === 'ok'
      ? `<span class="ok">OK</span> · uptime ${Math.round(h.uptime)}s`
      : `<span class="bad">${h.status}</span>`;
    const m = await fetch('/api/admin/metrics').then(r => r.json()).catch(() => null);
    if (m) {
      $('sysQueue').textContent = `${m.queue.waiting ?? 0} / ${m.queue.admitted ?? 0}`;
      $('sysSeats').textContent = `${m.seats.available ?? 0} / ${m.seats.held ?? 0} / ${m.seats.sold ?? 0}`;
    }
    const c = await fetch('/api/admin/consistency').then(r => r.json());
    $('sysConsistency').innerHTML = c.ok
      ? '<span class="ok">Konsisten</span>'
      : `<span class="warn">${c.issues.length} isu</span>`;
  } catch {
    $('sysHealth').innerHTML = '<span class="bad">gagal</span>';
  }
}

/* ---------- Polling ---------- */
function startSeatPolling() {
  if (state.seatTimer) clearInterval(state.seatTimer);
  state.seatTimer = setInterval(() => { if (!document.hidden) loadSeats(); }, 2500);
}
function startTicketPolling() {
  if (state.ticketTimer) clearInterval(state.ticketTimer);
  state.ticketTimer = setInterval(loadTickets, 8000);
}
function startClock() {
  if (state.clockTimer) clearInterval(state.clockTimer);
  state.clockTimer = setInterval(() => {
    updateHoldTimer();
    // refresh judul kursi (sisa hold)
    document.querySelectorAll('.seat.mine').forEach(el => {
      const seatId = el.textContent;
      // cukup update via re-render ringan dari state
    });
  }, 1000);
}
function startSysPolling() {
  if (state.sysTimer) clearInterval(state.sysTimer);
  state.sysTimer = setInterval(refreshSystem, 15000);
}
function stopAllTimers() {
  [state.seatTimer, state.ticketTimer, state.clockTimer, state.queueTimer, state.sysTimer].forEach(t => t && clearInterval(t));
  state.seatTimer = state.ticketTimer = state.clockTimer = state.queueTimer = state.sysTimer = null;
}

/* ---------- Boot ---------- */
async function boot() {
  // muat info event dulu
  try {
    const d = await api.req('/api/events/1/seats');
    state.event = d.event;
    $('eventTitle').textContent = d.event.name;
    $('eventVenue').textContent = d.event.venue + ' · ' + d.event.event_date;
    state.seats = d.seats;
    renderSeats();
  } catch {}

  state.sessions = loadSessions();
  api.token = localStorage.getItem('k3.token') || (state.sessions[0]?.token || '');

  renderSessions();
  await switchSession(api.token);

  // events
  $('newSessionForm').onsubmit = (e) => {
    e.preventDefault();
    const label = $('newSessionLabel').value.trim();
    if (!label) return toast('Isi nama sesi dulu', 'warn');
    createSession(label);
    $('newSessionLabel').value = '';
  };
  $('joinBtn').onclick = () => {
    // join queue untuk sesi aktif yang belum admitted (mis. sesi lama yang belum masuk)
    if (!api.token) return toast('Buat sesi dulu', 'warn');
    // panggil ulang status (buat trigger ulang)
    switchSession(api.token);
  };
  $('leaveBtn').onclick = leaveActiveSession;
  $('checkoutBtn').onclick = openCheckout;
  $('confirmPayBtn').onclick = payNow;
  $('cancelPayBtn').onclick = () => { $('checkoutModal').hidden = true; };
  $('refreshTicketsBtn').onclick = loadTickets;
  $('refreshSysBtn2').onclick = refreshSystem;
  $('closeTicketBtn').onclick = () => { $('ticketModal').hidden = true; };
  $('ticketModal').onclick = (e) => { if (e.target.id === 'ticketModal') $('ticketModal').hidden = true; };
  $('checkoutModal').onclick = (e) => { if (e.target.id === 'checkoutModal') $('checkoutModal').hidden = true; };

  refreshSystem();
  startSysPolling();
}
boot();

// ---------- Indikator koneksi ----------
function markDown(down) {
  if (down === !!api.down) return;
  api.down = down;
  if (down) { setPill('Menyambung ulang…', 'warn'); return; }
  if (!api.token) setPill('Tanpa sesi', '');
  else if (state.admitted) setPill('Sesi aktif', 'ok');
  else setPill('Menunggu antrean', 'warn');
}
