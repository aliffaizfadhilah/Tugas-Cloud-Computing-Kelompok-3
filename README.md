# Konser Ticketing — Praktikum Cloud Computing (Kelompok 3)

## Menjalankan di localhost
```bash
npm install
npm start          # http://localhost:3000
```
Opsional (env): `PORT`, `HOLD_SECONDS` (300), `ADMIT_PER_TICK` (5), `ADMIT_INTERVAL_MS` (2000), `DB_PATH`.
Butuh Node.js 18+.

## Push ke Git
```bash
git init && git add . && git commit -m "Pertemuan 1: arsitektur, DRP awal, aplikasi ticketing"
git branch -M main
git remote add origin <URL_REPO>
git push -u origin main
```

## Isi
- `docs/01-arsitektur.md` — Spesifikasi arsitektur
- `docs/02-drp-awal.md` — DRP awal (RTO/RPO)
- `docs/03-prompt-ai.md` — Prompt AI
- `server.js`, `public/index.html` — Aplikasi

## Uji cepat double booking
Dua token masuk antrean lalu hold kursi yang sama: yang kedua harus mendapat HTTP 409.
