#!/usr/bin/env bash
# dr-test.sh — DR test: Redis, API, dan Postgres gagal saat hold + booking berjalan.
# Prasyarat: docker compose up -d --build, jq, curl. Jalankan dari folder proyek (WSL).
set -u
B=${B:-http://localhost:8080}
PSQL=(docker compose exec -T postgres psql -U ticket -d ticketing -tA -c)
PASS=0; FAIL=0
code(){ curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$@"; }
cek(){ if [ "$2" = "$3" ]; then echo "  PASS  $1"; PASS=$((PASS+1)); else echo "  FAIL  $1 (dapat: $2, harusnya: $3)"; FAIL=$((FAIL+1)); fi; }
join(){ curl -s -XPOST $B/api/queue/join -H 'content-type: application/json' -d "{\"label\":\"$1\"}" | jq -r .token; }
admit(){ until [ "$(curl -s $B/api/queue/status/$1 | jq -r .admitted)" = true ]; do sleep 1; done; }
hold(){ code -XPOST $B/api/seats/$2/hold -H "x-queue-token: $1"; }
wait_ready(){ until [ "$(code $B/ready)" = 200 ]; do sleep 0.5; done; }
wait_healthy(){ until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q $1)" 2>/dev/null)" = healthy ]; do sleep 1; done; }
detik(){ awk -v a="$1" -v b="$2" 'BEGIN{printf "%.1f", b-a}'; }

echo "== Persiapan (data uji direset)"
"${PSQL[@]}" "DELETE FROM bookings; DELETE FROM payments; DELETE FROM idempotency; UPDATE seats SET status='available', held_by=NULL, hold_until=NULL;" >/dev/null
wait_ready
A=$(join Budi); C=$(join Ali); admit "$A"; admit "$C"
cek "Budi dan Ali masuk lewat nginx" "$([ -n "$A" ] && [ -n "$C" ] && echo ok)" ok

echo "== 1. Rebutan kursi"
cek "Budi hold kursi 1" "$(hold $A 1)" 200
cek "Budi hold kursi 2" "$(hold $A 2)" 200
cek "Ali gagal rebut kursi 1" "$(hold $C 1)" 409

echo "== 2. Redis macet (simulasi jaringan putus)"
docker compose pause redis >/dev/null
cek "Ali tetap gagal rebut kursi 1" "$(hold $C 1)" 409
cek "Ali hold kursi 3 (booking tetap jalan)" "$(hold $C 3)" 200
cek "antrean baru tetap diterima" "$(code -XPOST $B/api/queue/join -H 'content-type: application/json' -d '{}')" 201
docker compose unpause redis >/dev/null

echo "== 3. Redis crash (SIGKILL) + data hilang"
T0=$(date +%s.%N)
docker compose kill redis >/dev/null 2>&1
cek "Ali hold kursi 4 saat Redis mati" "$(hold $C 4)" 200
cek "/ready tetap 200 (degraded)" "$(code $B/ready)" 200
docker compose start redis >/dev/null 2>&1
until [ "$(curl -s $B/ready | jq -r .degraded)" = false ]; do sleep 0.5; done
echo "  RTO Redis: $(detik $T0 $(date +%s.%N)) detik"
cek "kursi Budi tetap milik Budi" "$(hold $C 2)" 409

echo "== 4. Satu instance API crash"
docker compose kill api1 >/dev/null 2>&1
OK=0; for i in $(seq 1 10); do [ "$(code $B/health)" = 200 ] && OK=$((OK+1)); done
cek "10 request lewat nginx tetap sukses" "$OK" 10
cek "Ali hold kursi 5 saat api1 mati" "$(hold $C 5)" 200
docker compose start api1 >/dev/null 2>&1; wait_healthy api1
docker compose exec -T nginx nginx -s reload >/dev/null 2>&1   # nginx baca ulang IP container

echo "== 5. Postgres crash (SIGKILL) saat Budi sudah punya tagihan"
R=$(curl -s -XPOST $B/api/payments -H "x-queue-token: $A" -H 'content-type: application/json' -d '{"method":"qris"}')
P=$(echo "$R" | jq -r .paymentId)
cek "tagihan Budi dibuat (2 kursi)" "$(echo "$R" | jq -r '.seats|length')" 2
T0=$(date +%s.%N)
docker compose kill postgres >/dev/null 2>&1; sleep 1
cek "hold saat DB mati -> 503" "$(hold $C 6)" 503
cek "/ready saat DB mati -> 503" "$(code $B/ready)" 503
docker compose start postgres >/dev/null 2>&1
wait_ready
echo "  RTO Postgres: $(detik $T0 $(date +%s.%N)) detik"
cek "kursi 1 TIDAK direbut Ali setelah recovery" "$(hold $C 1)" 409
cek "kursi 2 TIDAK direbut Ali setelah recovery" "$(hold $C 2)" 409
cek "Budi bayar setelah recovery" "$(code -XPOST $B/api/payments/$P/confirm -H "x-queue-token: $A")" 200
cek "kursi 1 kini terjual, tetap 409" "$(hold $C 1)" 409
cek "Ali bayar kursi miliknya" "$(
  P2=$(curl -s -XPOST $B/api/payments -H "x-queue-token: $C" -H 'content-type: application/json' -d '{"method":"qris"}' | jq -r .paymentId)
  code -XPOST $B/api/payments/$P2/confirm -H "x-queue-token: $C")" 200

echo "== 6. Konsistensi akhir"
SOLD=$("${PSQL[@]}" "SELECT COUNT(*) FROM seats WHERE status='sold'")
PAID=$("${PSQL[@]}" "SELECT COUNT(*) FROM bookings WHERE status='paid'")
cek "jumlah kursi sold = jumlah booking paid ($SOLD vs $PAID)" "$SOLD" "$PAID"
cek "/api/admin/consistency ok" "$(curl -s $B/api/admin/consistency | jq -r .ok)" true

echo; echo "HASIL: $PASS lulus, $FAIL gagal"
[ "$FAIL" -eq 0 ]