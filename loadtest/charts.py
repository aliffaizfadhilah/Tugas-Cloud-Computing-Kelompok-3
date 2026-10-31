#!/usr/bin/env python3
"""Grafik hasil stress test. Pemakaian: python3 loadtest/charts.py <flow> [tag ...]
   contoh: python3 loadtest/charts.py booking base tuned"""
import csv, glob, json, os, re, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get('OUT_DIR', os.path.join(HERE, 'out'))
FLOW = sys.argv[1] if len(sys.argv) > 1 else 'booking'
TAGS = sys.argv[2:] or ['base']
SLO_P95_MS, SLO_ERR = 1000.0, 0.01
LIMITS = {'api': 0.5, 'postgres': 1.0, 'redis': 0.25, 'nginx': 0.5}   # samakan dengan docker-compose.loadtest.yml


def load(tag):
    runs = []
    for f in glob.glob(f'{OUT}/summary-{tag}-{FLOW}-*.json'):
        with open(f) as fh:
            runs.append(json.load(fh))
    return sorted(runs, key=lambda r: r['vus'])


def component(name):
    m = re.match(r'^konser(?:-scale)?-(api|postgres|redis|nginx|pg-backup)', name)
    if m:
        return m.group(1)
    return 'k6' if re.match(r'^[a-z]+_[a-z]+$', name) or name.startswith('k6') else None


def peaks(tag, vu):
    """Puncak per komponen dari stats-<tag>-<flow>-<vu>.csv."""
    f = f'{OUT}/stats-{tag}-{FLOW}-{vu}.csv'
    res = {}
    if not os.path.exists(f):
        return res
    with open(f) as fh:
        for row in csv.DictReader(fh):
            try:
                v = float(row['value'])
            except ValueError:
                continue
            kind, name = row['kind'], row['name']
            if kind == 'cpu':
                comp = component(name)
                if comp and comp != 'pg-backup':
                    key = 'cpu_' + comp
                    res[key] = max(res.get(key, 0.0), v)
            elif kind in ('pg_conns', 'pool_waiting', 'loop_lag_ms'):
                res[kind] = max(res.get(kind, 0.0), v)
    return res


data = {t: load(t) for t in TAGS}
if not any(data.values()):
    sys.exit(f'Tidak ada {OUT}/summary-<tag>-{FLOW}-*.json')


def figure(title, ylabel, fn, fname, logy=False, hline=None, bar=False):
    fig, ax = plt.subplots(figsize=(7.5, 4.5))
    n = len(data)
    for i, (tag, runs) in enumerate(data.items()):
        if not runs:
            continue
        xs = [r['vus'] for r in runs]
        series = fn(runs)
        for label, ys, style in series:
            lab = f'{tag}: {label}' if n > 1 else label
            if bar:
                pos = [j + (i - (n - 1) / 2) * 0.35 / n * 2 for j in range(len(xs))]
                ax.bar(pos, ys, width=0.7 / n, label=lab)
                ax.set_xticks(range(len(xs)))
                ax.set_xticklabels(xs)
            else:
                ax.plot(xs, ys, style, marker='o', label=lab)
    if hline:
        ax.axhline(hline[0], color='red', linestyle=':', label=hline[1])
    if logy:
        ax.set_yscale('log')
    ax.set_title(f'{title} ({FLOW})')
    ax.set_xlabel('Virtual Users (VU)')
    ax.set_ylabel(ylabel)
    ax.grid(alpha=0.3)
    ax.legend(fontsize=8)
    fig.tight_layout()
    path = f'{OUT}/grafik-{FLOW}-{fname}.png'
    fig.savefig(path, dpi=130)
    plt.close(fig)
    print('tersimpan:', path)


figure('Throughput', 'request per detik', lambda rs: [('req/s', [r['rps'] for r in rs], '-')], 'throughput')
figure('Response time', 'ms (skala log)', lambda rs: [('p50', [r['p50'] for r in rs], '-'), ('p95', [r['p95'] for r in rs], '-'),
       ('p99', [r['p99'] for r in rs], '--')], 'latensi', logy=True, hline=(SLO_P95_MS, 'SLO p95 = 1000 ms'))
figure('Error rate server (5xx + timeout)', 'persen', lambda rs: [('error %', [100 * (r['server_error_rate'] or 0) for r in rs], '-')],
       'error', bar=True, hline=(100 * SLO_ERR, 'batas 1%'))

# Utilisasi sumber daya terhadap limit (tag pertama)
t0 = TAGS[0]
if data[t0]:
    comps = ['api', 'postgres', 'redis', 'nginx']
    fig, ax = plt.subplots(figsize=(7.5, 4.5))
    xs = [r['vus'] for r in data[t0]]
    any_data = False
    for comp in comps:
        ys = [100 * peaks(t0, r['vus']).get('cpu_' + comp, 0) / (LIMITS[comp] * 100) for r in data[t0]]
        if any(ys):
            any_data = True
            ax.plot(xs, ys, marker='o', label=f'{comp} (limit {LIMITS[comp]} CPU)')
    k6 = [peaks(t0, r['vus']).get('cpu_k6', 0) for r in data[t0]]
    if any(k6):
        ax.plot(xs, [v / 100 for v in k6], marker='x', linestyle='--', color='gray', label='k6 (jumlah core terpakai)')
    if any_data:
        ax.axhline(100, color='red', linestyle=':', label='100% limit')
        ax.set_title(f'Utilisasi CPU puncak terhadap limit ({FLOW}, {t0})')
        ax.set_xlabel('Virtual Users (VU)'); ax.set_ylabel('% dari limit CPU'); ax.grid(alpha=0.3); ax.legend(fontsize=8)
        fig.tight_layout(); fig.savefig(f'{OUT}/grafik-{FLOW}-cpu.png', dpi=130); print('tersimpan:', f'{OUT}/grafik-{FLOW}-cpu.png')
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(7.5, 4.5))
    drew = False
    for key, lab in (('pg_conns', 'koneksi Postgres'), ('pool_waiting', 'antrean pool (waiting)'), ('loop_lag_ms', 'event-loop lag p99 (ms)')):
        ys = [peaks(t0, r['vus']).get(key) for r in data[t0]]
        if any(v is not None for v in ys):
            drew = True
            ax.plot(xs, [v or 0 for v in ys], marker='o', label=lab)
    if drew:
        ax.set_title(f'Indikator bottleneck aplikasi ({FLOW}, {t0})'); ax.set_xlabel('Virtual Users (VU)'); ax.grid(alpha=0.3); ax.legend(fontsize=8)
        fig.tight_layout(); fig.savefig(f'{OUT}/grafik-{FLOW}-bottleneck.png', dpi=130); print('tersimpan:', f'{OUT}/grafik-{FLOW}-bottleneck.png')
    plt.close(fig)

# Tabel ringkasan dan titik gagal pertama
print(f'\n{"tag":8}{"VU":>6}{"req/s":>9}{"p95 ms":>9}{"p99 ms":>9}{"err %":>8}{"500":>6}{"503":>6}{"timeout":>9}  status')
for tag, runs in data.items():
    first = None
    for r in runs:
        err = r['server_error_rate'] or 0
        status = 'OK'
        if err >= SLO_ERR:
            status = 'GAGAL (error >= 1%)'
        elif (r['p95'] or 0) >= SLO_P95_MS:
            status = 'LAMBAT (p95 >= 1000 ms)'
        if status != 'OK' and first is None:
            first = (r, status)
        print(f'{tag:8}{r["vus"]:>6}{r["rps"]:>9.1f}{r["p95"]:>9.0f}{r["p99"]:>9.0f}{100*err:>8.2f}{r["err_500"]:>6}{r["err_503"]:>6}{r["err_timeout"]:>9}  {status}')
    print(f'>> [{tag}] titik gagal pertama: ' + (f'{first[0]["vus"]} VU - {first[1]}' if first else 'tidak ada hingga VU tertinggi yang diuji') + '\n')

# Grafik auto scaling (bila ada)
alog = f'{OUT}/autoscale.csv'
if os.path.exists(alog):
    ts, rep, util = [], [], []
    with open(alog) as fh:
        for row in csv.DictReader(fh):
            ts.append(int(row['ts'])); rep.append(int(row['replicas'])); util.append(float(row['avg_util_pct']))
    if ts:
        t0s = ts[0]; xs = [(t - t0s) for t in ts]
        fig, ax = plt.subplots(figsize=(8, 4.5)); ax2 = ax.twinx()
        ax.step(xs, rep, where='post', color='tab:blue', label='replika API'); ax.set_ylabel('jumlah replika API'); ax.set_xlabel('detik sejak mulai')
        ax2.plot(xs, util, color='tab:orange', label='utilisasi CPU rata-rata (%)'); ax2.set_ylabel('% dari limit CPU')
        ax.set_title('Auto scaling: replika dan utilisasi CPU'); ax.grid(alpha=0.3)
        fig.tight_layout(); fig.savefig(f'{OUT}/grafik-autoscale.png', dpi=130); print('tersimpan:', f'{OUT}/grafik-autoscale.png')
