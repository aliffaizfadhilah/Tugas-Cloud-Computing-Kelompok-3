# Konser Ticketing — Praktikum Cloud Computing (Kelompok 3)

Platform booking tiket konser yang dirancang tahan terhadap lonjakan akses (war tiket) dan kegagalan komponen. Fokus tugas: pengamanan antrean (queue), pemulihan cepat status booking, dan memastikan kursi yang sedang di-hold tetap konsisten setelah Redis, API, atau database gagal.

## Arsitektur

```text
Browser ──► nginx :8080 ──┬──► api1 ┐
                          └──► api2 ┤──► PostgreSQL  (sumber kebenaran: kursi, hold, antrean, payment, booking)
                                    └──► Redis       (indeks urutan antrean, bukan sumber kebenaran)
PostgreSQL ──► pg-backup  (dump berkala ke ./backups)
```

Prinsip utama:

- **PostgreSQL adalah satu-satunya sumber kebenaran.** Redis boleh hilang tanpa menghilangkan data. Posisi antrean otomatis dibangun ulang dari Postgres.
- **Hold kursi hanya dilepas karena waktunya habis** (atau dilepas pemiliknya), tidak pernah karena status antrean.
- **Hold atomik.** Satu `UPDATE` bersyarat plus kunci basis data membuat dua pengguna tidak mungkin memegang kursi yang sama, termasuk lintas instance API.
- **Kegagalan sementara dilaporkan sebagai HTTP 503** dengan `Retry-After`, bukan 500.

Detail lengkap ada di `docs/01-arsitektur.md` dan `docs/02-drp-awal.md`.

## Prasyarat

- WSL2 Debian (atau Linux) dengan Docker Engine dan Docker Compose v2
- `curl` dan `jq` (untuk skrip pengujian)
- Node.js tidak diperlukan di host, karena aplikasi berjalan di dalam container

## Menjalankan

```bash
docker compose up -d --build
docker compose ps                      # api1, api2, postgres, redis: healthy
curl -s localhost:8080/ready | jq .    # {"ready":true,"degraded":false,...}
```

Buka **http://localhost:8080**.

Menghentikan layanan:

```bash
docker compose down        # data tetap aman di volume
docker compose down -v     # PERINGATAN: menghapus volume, seluruh data database hilang
```
## Volume dan persistensi data

| Volume | Jenis | Isi | Bertahan setelah |
|---|---|---|---|
| `konser_pgdata` | named volume | data PostgreSQL | `docker compose down`, container dibuat ulang, crash |
| `konser_redisdata` | named volume | file AOF Redis | `docker compose down`, container dibuat ulang |
| `./backups` | bind mount | dump `pg_dump` berkala | `docker compose down -v` |

- `docker compose down` aman: container dihapus, volume tetap.
- `docker compose down -v` **menghapus volume** dan seluruh data database. Pulihkan dari `./backups` (lihat bagian Backup dan restore).
- Skrip `db/init/` hanya dijalankan saat volume database masih kosong. Perubahan skema pada volume yang sudah berisi harus lewat `ALTER TABLE`.
- Data volume berada di penyimpanan Docker (bukan di folder proyek). Jangan diedit manual.

### Konfigurasi

`docker-compose.yml` meneruskan dua variabel dari shell. Contoh: `HOLD_SECONDS=60 docker compose up -d`.

| Variabel | Default | Fungsi |
|---|---|---|
| `HOLD_SECONDS` | 300 | Lama hold kursi (detik) |
| `ADMIT_PER_TICK` | 5 | Jumlah pengguna yang diizinkan masuk per siklus. `0` membekukan antrean (berguna untuk pengujian) |

Variabel lain punya nilai default di kode dan baru berlaku jika ditambahkan ke bagian `environment` di `docker-compose.yml`:

| Variabel | Default | Fungsi |
|---|---|---|
| `ADMIT_INTERVAL_MS` | 2000 | Jeda antar siklus pengizinan |
| `PAY_GRACE_SECONDS` | 600 | Hold diperpanjang sampai sejauh ini saat pengguna membayar |
| `MAX_SEATS_PER_USER` | 4 | Batas kursi per pengguna |
| `GATEWAY_MS` | 600 | Simulasi latensi gateway pembayaran |
| `ADMIN_KEY` | kosong | Jika diisi, endpoint `/api/admin/*` memerlukan header `x-admin-key` |

## Struktur proyek

```text
server.js              kerangka Express, /health, /ready, pemasangan rute
src/infra.js           koneksi Postgres dan Redis, penanganan error (503)
src/queue.js           antrean: join, status, leave
src/jobs.js            pengizinan antrean dan penyapu hold kedaluwarsa
src/seats.js           peta kursi, hold, release
src/payments.js        tagihan dan konfirmasi pembayaran
src/bookings.js        e-tiket dan refund
src/admin.js           metrics, consistency, reconcile
src/auth.js            pengecekan token yang sudah diizinkan
src/tx.js              pembungkus transaksi
src/ratelimit.js       pembatas laju permintaan
public/                frontend (HTML, CSS, JavaScript)
db/init/               skema dan data awal Postgres
nginx.conf             load balancer
docker-compose.yml     seluruh layanan
dr-test.sh             DR test otomatis
backups/               hasil dump (tidak masuk Git)
docs/                  dokumen arsitektur, DRP, prompt AI
```

## Endpoint utama

| Endpoint | Fungsi |
|---|---|
| `GET /health`, `GET /ready` | Liveness dan readiness (`/ready` memeriksa Postgres dan Redis) |
| `POST /api/queue/join`, `GET /api/queue/status/:token`, `POST /api/queue/leave` | Antrean |
| `GET /api/events/:id/seats` | Peta kursi |
| `POST /api/seats/:id/hold`, `POST /api/seats/:id/release` | Hold dan lepas kursi (header `x-queue-token`) |
| `POST /api/payments`, `POST /api/payments/:id/confirm` | Tagihan dan konfirmasi pembayaran |
| `GET /api/bookings`, `POST /api/bookings/:code/refund` | Tiket dan refund |
| `GET /api/admin/metrics`, `GET /api/admin/consistency`, `POST /api/admin/reconcile` | Pemantauan dan perbaikan konsistensi |

## Pengujian

### Uji cepat double booking

Dua pengguna masuk antrean lalu hold kursi yang sama. Yang kedua harus mendapat HTTP 409.

```bash
B=http://localhost:8080
join(){ curl -s -XPOST $B/api/queue/join -H 'content-type: application/json' -d '{}' | jq -r .token; }
A=$(join); C=$(join); sleep 5
curl -s -o /dev/null -w '%{http_code}\n' -XPOST $B/api/seats/1/hold -H "x-queue-token: $A"   # 200
curl -s -o /dev/null -w '%{http_code}\n' -XPOST $B/api/seats/1/hold -H "x-queue-token: $C"   # 409
```

### DR test otomatis

```bash
./dr-test.sh 2>&1 | tee dr-test-hasil.txt
```

Skrip ini **mereset data uji** (booking, payment, status kursi), jadi hanya untuk lingkungan lab. Skenarionya:

1. Rebutan kursi antara dua pengguna
2. Redis macet (`pause`)
3. Redis crash (`kill`) dan data hilang
4. Satu instance API crash
5. Postgres crash (`kill`) saat pengguna sudah punya tagihan
6. Pengecekan konsistensi akhir

Hasil yang diharapkan: seluruh 22 pemeriksaan `PASS`, plus angka RTO Redis dan Postgres. Skrip menyalakan ulang container dengan `docker compose start`, karena Docker tidak menyalakan ulang container yang dimatikan manual dengan `kill`.

### Konsistensi data

```bash
curl -s localhost:8080/api/admin/consistency | jq .    # "ok": true
```

## Pemulihan

Menyalakan komponen yang mati:

```bash
docker compose start api1 && docker compose exec nginx nginx -s reload
docker compose start redis
docker compose start postgres      # API pulih sendiri, tidak perlu restart
```

### Backup dan restore

Layanan `pg-backup` membuat dump setiap 5 menit ke `./backups` (retensi 120 menit). Backup manual dan restore setelah volume database hilang:

```bash
# backup manual
docker compose exec -T postgres pg_dump -U ticket -Fc ticketing > backups/manual.dump

# restore ke database kosong
docker compose stop api1 api2 nginx
docker compose exec -T postgres psql -U ticket -d ticketing -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
docker compose exec -T postgres pg_restore -U ticket -d ticketing --no-owner < backups/manual.dump
docker compose up -d
```

## Keterbatasan

- Postgres dan Redis masih satu instance. Failover otomatis belum ada, replika Postgres hanya opsi pengembangan lanjut.
- Pembatas laju disimpan di memori per instance, sehingga batas efektif berlipat saat instance API bertambah.
- `ADMIN_KEY` kosong secara default, artinya endpoint admin terbuka. Isi untuk lingkungan nyata.
- Kredensial database di `docker-compose.yml` hanya untuk demo.
- Backup tersimpan di mesin yang sama dengan layanan.
- Pembayaran memakai gateway simulasi.

## Alur Git

Pekerjaan dilakukan di branch terpisah dari `main`:

```bash
git switch -c <nama-branch>
git add -A && git commit -m "pesan commit"
git push -u origin <nama-branch>
```

Branch pengerjaan saat ini: `planning-and-application-setup` (judul PR: "Planning & Application Setup").