# Platform Booking Tiket Konser

Aplikasi booking tiket konser berbasis web dengan fitur pemilihan kursi, antrean pengguna, booking, pembayaran, dan pengelolaan tiket.

Proyek ini dikembangkan oleh **Kelompok 3 — Praktikum Cloud Computing** dengan menerapkan Docker, PostgreSQL, Redis, Nginx, Disaster Recovery Plan, Auto Scaling, dan Stress Testing.

## Teknologi

- **Backend:** Node.js
- **Frontend:** HTML, CSS, JavaScript
- **Database:** PostgreSQL 16
- **Cache & Queue:** Redis 7
- **Load Balancer:** Nginx
- **Containerization:** Docker & Docker Compose
- **Load Testing:** k6
- **Automation:** Bash & Python

## Arsitektur

```text
Browser
   |
   v
Nginx :8080
   |
   v
API Service (2–6 Replicas)
   |
   +------ PostgreSQL
   |
   +------ Redis

Autoscaler --> Monitoring CPU --> Docker Compose

k6 --> Stress Testing
```

Nginx berfungsi sebagai reverse proxy dan load balancer. API berjalan dalam beberapa replika, PostgreSQL menyimpan data utama, sedangkan Redis membantu pengelolaan indeks antrean.

## Menjalankan Aplikasi

Pastikan Docker dan Docker Compose sudah terpasang.

```bash
git clone https://github.com/aliffaizfadhilah/Tugas-Cloud-Computing-Kelompok-3.git

cd Tugas-Cloud-Computing-Kelompok-3

docker compose up -d --build --scale api=2
```

Periksa container:

```bash
docker compose ps
```

Akses aplikasi melalui:

**http://localhost:8080**

## Auto Scaling

Proyek menggunakan `autoscaler.sh` untuk memantau penggunaan CPU API dan menyesuaikan jumlah replika secara otomatis.

| Parameter | Nilai |
|---|---:|
| Minimum replicas | 2 |
| Maximum replicas | 6 |
| Scale-out CPU | 60% |
| Scale-in CPU | 25% |
| Monitoring interval | 10 detik |
| Cooldown | 30 detik |

Jalankan autoscaler pada terminal terpisah:

```bash
chmod +x autoscaler.sh
./autoscaler.sh
```

Hasil pengujian menunjukkan scale-out berhasil dari **2 hingga 6 replika API**.

## Stress Testing

Pengujian menggunakan k6 pada endpoint:

```text
GET /api/events/1/seats
```

Tahapan pengujian dilakukan pada 10, 100, 500, dan 1.000 Virtual Users.

**Ringkasan hasil pengujian:**

| Metrik | Hasil |
|---|---:|
| Total requests | 332.010 |
| Throughput agregat | ±1.049,77 req/s |
| Average response time | 339,42 ms |
| P95 | 1.579,85 ms |
| P99 | 2.098,17 ms |
| Error rate | 1,41% |
| Maximum VU | 1.000 |

Pengujian berhasil mencapai 1.000 VU, tetapi error rate masih melebihi target kurang dari 1%. Log Nginx menunjukkan adanya upstream timeout (HTTP 504) pada beban tinggi.

## Disaster Recovery & Data Persistence

Proyek menerapkan beberapa mekanisme pemulihan:

- PostgreSQL sebagai sumber kebenaran data.
- Docker Volumes untuk persistensi database dan Redis.
- Backup PostgreSQL berkala menggunakan `pg_dump`.
- Pemulihan antrean Redis dari PostgreSQL.
- Pemeriksaan konsistensi booking dan kursi.
- Prosedur restore database dari backup.

## Struktur Proyek

```text
konser-ticketing/
├── src/
├── public/
├── db/
├── docs/
├── tests/
│   └── k6/
├── loadtest/
├── benchmark-results/
├── backups/
├── Dockerfile
├── docker-compose.yml
├── docker-compose.loadtest.yml
├── nginx.conf
├── autoscaler.sh
└── server.js
```

## Dokumentasi

Dokumentasi arsitektur dan hasil praktikum tersedia di folder `docs/`, meliputi:

- Dokumen Spesifikasi Arsitektur.
- Dokumen Disaster Recovery Plan.
- Dokumentasi Stress Testing dan Auto Scaling.

## Tim Pengembang

**Kelompok 3 — Praktikum Cloud Computing**

| Nama | NIM |
|---|---|
| Davin Rahmada Adkha | 09020623021 |
| Ali Rohmat | 09020624021 |
| Alif Faiz Fadhilah | 09040624080 |
| Muhammad Cavin Fathurrizqi | 09020624048 |