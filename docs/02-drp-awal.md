# Disaster Recovery Plan (DRP) Awal
**Sistem:** Platform Booking Tiket Konser — Kelompok 3
**Versi:** 0.1 (Pertemuan 1) — akan disempurnakan di Pertemuan 4

## 1. Tujuan & Ruang Lingkup
Memastikan layanan booking dapat pulih cepat setelah kegagalan, tanpa merusak konsistensi kursi (tidak ada double booking dan hold tidak hilang/direbut).
Cakupan: container App, Queue (Redis), Database, dan data backup.

## 2. Aset Kritis
| Aset | Tingkat Kritis | Alasan |
|---|---|---|
| Database (seats, bookings) | Sangat tinggi | Sumber kebenaran status kursi dan pembelian |
| Queue (Redis) | Sedang | Hanya urutan antrean; dapat dibangun ulang |
| App Server | Tinggi | Stateless, mudah di-restart |
| File backup | Tinggi | Satu-satunya jalan pulih jika DB rusak |

## 3. Skenario Bencana & Dampak
| ID | Skenario | Dampak | Prioritas |
|---|---|---|---|
| S1 | Container Redis/queue crash saat war tiket | Antrean hilang; pengguna harus antre ulang | Sedang |
| S2 | Container database crash saat booking berjalan | Booking gagal, risiko status hold/sold tidak konsisten | Tinggi |
| S3 | Volume database hilang/rusak | Seluruh data booking hilang | Tinggi |
| S4 | App server crash | Layanan tidak bisa diakses sementara | Sedang |

## 4. Target RTO & RPO (awal)
| Komponen | RTO (maks. mati) | RPO (maks. data hilang) | Catatan |
|---|---|---|---|
| Database | ≤ 15 menit | ≤ 5 menit | Backup dump tiap 5 menit saat penjualan aktif |
| Queue (Redis) | ≤ 5 menit | Boleh hilang | Hold tetap di DB, antrean dibangun ulang |
| App Server | ≤ 2 menit | 0 (stateless) | Restart container / `restart: always` |

Target ini akan diverifikasi dengan pengukuran nyata pada Pertemuan 4.

## 5. Strategi Backup
1. **Persistensi:** Docker Volume untuk database (Pertemuan 2).
2. **Backup logis:** skrip bash + cron melakukan `pg_dump` (SQLite: `.backup`) berkala ke folder terpisah dari volume DB.
3. **Retensi:** 12 backup terakhir (±1 jam) + 1 backup harian.
4. **Verifikasi:** backup diuji restore ke database sementara, bukan hanya dianggap berhasil.
5. **Desain anti-kehilangan hold:** status hold ada di DB sehingga ikut ter-backup dan tidak bergantung pada Redis.

## 6. Prosedur Recovery (ringkas)
**Redis crash (S1):** restart container → antrean kosong → pengguna yang sudah masuk tetap bisa lanjut (token admitted) atau join ulang → cek kursi hold tidak berubah.
**Database crash (S2/S3):**
1. Hentikan traffic baru (mode maintenance atau stop app).
2. Restart container DB; jika data rusak, restore dump terbaru ke volume baru.
3. Jalankan query validasi (bagian 8).
4. Hapus hold yang kedaluwarsa, lalu nyalakan kembali app.
5. Catat waktu mulai dan selesai untuk menghitung RTO aktual.

## 7. Rencana DR Test Kelompok 3 (dieksekusi di Pertemuan 4)
Simulasikan *container crash* pada Redis atau Database saat proses booking berjalan (beban dari k6/Locust), lalu recovery.
**Kriteria sukses:**
- Kursi berstatus *held* tetap atas nama pemegang semula dan tidak direbut pengguna lain.
- Tidak ada kursi dengan lebih dari satu booking.
- RTO aktual ≤ target; kehilangan data ≤ RPO.

## 8. Query Validasi Pasca-Recovery
```sql
-- 1. Tidak boleh ada kursi terjual ganda (harus 0 baris)
SELECT seat_id, COUNT(*) FROM bookings GROUP BY seat_id HAVING COUNT(*) > 1;
-- 2. Kursi 'sold' harus punya booking (harus 0 baris)
SELECT s.id FROM seats s LEFT JOIN bookings b ON b.seat_id = s.id WHERE s.status='sold' AND b.id IS NULL;
-- 3. Booking harus menunjuk kursi 'sold' (harus 0 baris)
SELECT b.id FROM bookings b JOIN seats s ON s.id=b.seat_id WHERE s.status <> 'sold';
-- 4. Bandingkan daftar hold sebelum dan sesudah crash
SELECT id, label, held_by, hold_until FROM seats WHERE status='held';
```

## 9. Peran
| Peran | Tugas |
|---|---|
| Incident Commander | Memutuskan dimulainya recovery |
| DB/Backup Engineer | Menjalankan restore dan validasi |
| App/Queue Engineer | Restart layanan, cek antrean |
| Dokumentator | Mencatat timeline, screenshot, RTO/RPO aktual |
(Isi nama anggota sesuai pembagian kelompok.)
