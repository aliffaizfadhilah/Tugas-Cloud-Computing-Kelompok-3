#!/usr/bin/env bash
# dr-test.sh
# Disaster Recovery test pada lingkungan Docker terisolasi: konser-dr.
# Database target: ticketing_drtest
# URL target: http://localhost:8081

set -Eeuo pipefail

cd "$(dirname "$0")"

COMPOSE=(docker compose -f docker-compose.dr.yml)
B="${B:-http://localhost:8081}"
DB_NAME="ticketing_drtest"

PASS=0
FAIL=0

API1="konser-dr-api-1"
API2="konser-dr-api-2"
REDIS="konser-dr-redis-1"
PG="konser-dr-postgres-1"

# --------------------------------------------------
# Fungsi dasar
# --------------------------------------------------

code() {
  curl -sS --connect-timeout 2 --max-time 5 \
    -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || true
}

cek() {
  if [ "$2" = "$3" ]; then
    echo "  PASS  $1"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $1 (dapat: $2, harusnya: $3)"
    FAIL=$((FAIL + 1))
  fi
}

psql_dr() {
  "${COMPOSE[@]}" exec -T postgres \
    psql -U ticket -d "$DB_NAME" -tA -c "$1"
}

join() {
  curl -sS --max-time 10 -X POST "$B/api/queue/join" \
    -H 'content-type: application/json' \
    -d "{\"label\":\"$1\"}" 2>/dev/null |
    jq -r '.token // empty' || true
}

admit() {
  local token="$1"
  local i=0
  local result=""

  while [ "$i" -lt 60 ]; do
    result=$(curl -sS --max-time 5 \
      "$B/api/queue/status/$token" 2>/dev/null |
      jq -r '.admitted // false' 2>/dev/null || true)

    if [ "$result" = "true" ]; then
      return 0
    fi

    sleep 1
    i=$((i + 1))
  done

  echo "ERROR: Token tidak admitted setelah 60 detik: $token" >&2
  return 1
}

hold() {
  code -X POST "$B/api/seats/$2/hold" \
    -H "x-queue-token: $1"
}

wait_ready() {
  local i=0

  while [ "$i" -lt 60 ]; do
    if [ "$(code "$B/ready")" = "200" ]; then
      return 0
    fi

    sleep 1
    i=$((i + 1))
  done

  echo "ERROR: API belum ready setelah 60 detik" >&2
  return 1
}

wait_healthy_container() {
  local container="$1"
  local i=0
  local status=""

  while [ "$i" -lt 60 ]; do
    status=$(docker inspect \
      -f '{{.State.Health.Status}}' "$container" 2>/dev/null || true)

    if [ "$status" = "healthy" ]; then
      return 0
    fi

    sleep 1
    i=$((i + 1))
  done

  echo "ERROR: Container tidak healthy: $container" >&2
  return 1
}

wait_redis_recovered() {
  local i=0
  local degraded=""
  local response=""
  local http_code=""

  while [ "$i" -lt 60 ]; do
    response=$(curl -sS \
      --max-time 5 \
      -w '\n%{http_code}' \
      "$B/ready" 2>/dev/null || true)

    http_code=$(echo "$response" | tail -n 1)
    body=$(echo "$response" | sed '$d')

    degraded=$(echo "$body" |
  jq -r 'if has("degraded") then (.degraded | tostring) else "unknown" end' \
  2>/dev/null || true)

    if [ "$http_code" = "200" ] && [ "$degraded" = "false" ]; then
      echo "  Redis pulih setelah $i detik."
      return 0
    fi

    if [ $((i % 10)) -eq 0 ]; then
      echo "  Menunggu Redis: HTTP=$http_code degraded=$degraded"
    fi

    sleep 1
    i=$((i + 1))
  done

  echo "ERROR: Redis belum terdeteksi pulih setelah 60 detik." >&2
  echo "HTTP terakhir: $http_code" >&2
  echo "Respons terakhir: $body" >&2
  return 1
}

detik() {
  awk -v a="$1" -v b="$2" \
    'BEGIN { printf "%.1f", b-a }'
}

# --------------------------------------------------
# Simulasi crash tanpa restart otomatis
# --------------------------------------------------

kill_no_restart() {
  local container="$1"

  docker update --restart=no "$container" >/dev/null
  docker kill "$container" >/dev/null
}

start_with_restart() {
  local container="$1"

  docker start "$container" >/dev/null
  docker update --restart=unless-stopped "$container" >/dev/null
}

# --------------------------------------------------
# Pemulihan otomatis jika skrip terhenti
# --------------------------------------------------

restore_container() {
  local container="$1"
  local running=""

  docker inspect "$container" >/dev/null 2>&1 || return 0

  running=$(docker inspect -f '{{.State.Running}}' \
    "$container" 2>/dev/null || true)

  if [ "$running" != "true" ]; then
    docker start "$container" >/dev/null 2>&1 || true
  fi

  docker update --restart=unless-stopped \
    "$container" >/dev/null 2>&1 || true
}

cleanup() {
  echo
  echo "== Pemulihan kondisi container DR =="

  docker unpause "$REDIS" >/dev/null 2>&1 || true

  restore_container "$REDIS"
  restore_container "$PG"
  restore_container "$API1"

  echo "  Pemeriksaan pemulihan selesai."
}

trap cleanup EXIT

# --------------------------------------------------
# Pemeriksaan keamanan sebelum pengujian
# --------------------------------------------------

echo "== Pemeriksaan lingkungan DR =="

for container in "$API1" "$API2" "$REDIS" "$PG"; do
  if ! docker inspect "$container" >/dev/null 2>&1; then
    echo "ERROR: Container DR tidak ditemukan: $container"
    exit 1
  fi
done

CURRENT_DB=$(psql_dr "SELECT current_database();")

if [ "$CURRENT_DB" != "$DB_NAME" ]; then
  echo "ERROR: Database bukan $DB_NAME. Pengujian dibatalkan."
  exit 1
fi

echo "  Database terverifikasi: $CURRENT_DB"
echo "  URL pengujian: $B"

wait_ready

# --------------------------------------------------
# Persiapan data pengujian
# Hanya mengubah database DR.
# --------------------------------------------------

echo
echo "== Persiapan (reset data pengujian DR) =="

psql_dr "
DELETE FROM bookings;
DELETE FROM idempotency;
DELETE FROM payments;
UPDATE seats
SET status='available',
    held_by=NULL,
    hold_until=NULL;
" >/dev/null

wait_ready

A=$(join "Budi")
C=$(join "Ali")

if [ -z "$A" ] || [ -z "$C" ]; then
  echo "ERROR: Gagal mendapatkan token antrean."
  exit 1
fi

admit "$A"
admit "$C"

cek "Budi dan Ali masuk lewat nginx" \
  "$([ -n "$A" ] && [ -n "$C" ] && echo ok)" "ok"

# --------------------------------------------------
# 1. Rebutan kursi
# --------------------------------------------------

echo
echo "== 1. Rebutan kursi =="

cek "Budi hold kursi 1" "$(hold "$A" 1)" 200
cek "Budi hold kursi 2" "$(hold "$A" 2)" 200
cek "Ali gagal rebut kursi 1" "$(hold "$C" 1)" 409

# --------------------------------------------------
# 2. Redis pause
# --------------------------------------------------

echo
echo "== 2. Redis macet (simulasi jaringan putus) =="

"${COMPOSE[@]}" pause redis >/dev/null

cek "Ali tetap gagal rebut kursi 1" "$(hold "$C" 1)" 409
cek "Ali hold kursi 3 (booking tetap jalan)" "$(hold "$C" 3)" 200

cek "Antrean baru tetap diterima" "$(
  code -X POST "$B/api/queue/join" \
    -H 'content-type: application/json' -d '{}'
)" 201

"${COMPOSE[@]}" unpause redis >/dev/null

# --------------------------------------------------
# 3. Redis crash
# --------------------------------------------------

echo
echo "== 3. Redis crash (SIGKILL) + recovery =="

T0=$(date +%s.%N)

kill_no_restart "$REDIS"
sleep 1

cek "Ali hold kursi 4 saat Redis mati" "$(hold "$C" 4)" 200
cek "/ready tetap 200 saat Redis mati" "$(code "$B/ready")" 200

DEGRADED=$(curl -sS --max-time 5 "$B/ready" |
  jq -r '.degraded // false' 2>/dev/null || true)

cek "API menandai Redis degraded" "$DEGRADED" true

start_with_restart "$REDIS"
wait_healthy_container "$REDIS"
wait_redis_recovered

echo "  RTO Redis: $(detik "$T0" "$(date +%s.%N)") detik"

cek "Kursi Budi tetap milik Budi" "$(hold "$C" 2)" 409

# --------------------------------------------------
# 4. Satu instance API crash
# --------------------------------------------------

echo
echo "== 4. Satu instance API crash =="

kill_no_restart "$API1"
sleep 1

OK=0

for i in $(seq 1 10); do
  if [ "$(code "$B/health")" = "200" ]; then
    OK=$((OK + 1))
  fi
  sleep 0.2
done

cek "10 request lewat nginx tetap sukses" "$OK" 10

cek "Ali hold kursi 5 saat API 1 mati" "$(hold "$C" 5)" 200

start_with_restart "$API1"
wait_healthy_container "$API1"

# Nginx menggunakan resolver Docker dinamis.
# Tidak perlu reload manual.

# --------------------------------------------------
# 5. PostgreSQL crash
# --------------------------------------------------

echo
echo "== 5. PostgreSQL crash saat Budi sudah punya tagihan =="

R=$(curl -sS --max-time 15 -X POST "$B/api/payments" \
  -H "x-queue-token: $A" \
  -H 'content-type: application/json' \
  -d '{"method":"qris"}' 2>/dev/null || true)

P=$(echo "$R" | jq -r '.paymentId // empty' 2>/dev/null || true)
SEATS_BUDI=$(echo "$R" | jq -r '.seats | length' 2>/dev/null || echo 0)

cek "Tagihan Budi dibuat (2 kursi)" "$SEATS_BUDI" 2

if [ -z "$P" ]; then
  echo "ERROR: Payment Budi tidak berhasil dibuat."
  exit 1
fi

T0=$(date +%s.%N)

kill_no_restart "$PG"
sleep 1

cek "Hold saat DB mati -> 503" "$(hold "$C" 6)" 503
cek "/ready saat DB mati -> 503" "$(code "$B/ready")" 503

start_with_restart "$PG"
wait_healthy_container "$PG"
wait_ready

echo "  RTO PostgreSQL: $(detik "$T0" "$(date +%s.%N)") detik"

cek "Kursi 1 tidak direbut Ali setelah recovery" "$(hold "$C" 1)" 409
cek "Kursi 2 tidak direbut Ali setelah recovery" "$(hold "$C" 2)" 409

cek "Budi bayar setelah recovery" "$(
  code -X POST "$B/api/payments/$P/confirm" \
    -H "x-queue-token: $A"
)" 200

cek "Kursi 1 kini terjual, tetap 409" "$(hold "$C" 1)" 409

# Pembayaran Ali harus menggunakan payment ID milik Ali.
R2=$(curl -sS --max-time 15 -X POST "$B/api/payments" \
  -H "x-queue-token: $C" \
  -H 'content-type: application/json' \
  -d '{"method":"qris"}' 2>/dev/null || true)

P2=$(echo "$R2" | jq -r '.paymentId // empty' 2>/dev/null || true)
SEATS_ALI=$(echo "$R2" | jq -r '.seats | length' 2>/dev/null || echo 0)

cek "Tagihan Ali dibuat (3 kursi)" "$SEATS_ALI" 3

if [ -z "$P2" ]; then
  echo "ERROR: Payment Ali tidak berhasil dibuat."
  exit 1
fi

cek "Ali bayar kursi miliknya" "$(
  code -X POST "$B/api/payments/$P2/confirm" \
    -H "x-queue-token: $C"
)" 200

# --------------------------------------------------
# 6. Konsistensi akhir
# --------------------------------------------------

echo
echo "== 6. Konsistensi akhir =="

SOLD=$(psql_dr \
  "SELECT COUNT(*) FROM seats WHERE status='sold'")

PAID=$(psql_dr \
  "SELECT COUNT(*) FROM bookings WHERE status='paid'")

cek "Jumlah kursi sold = jumlah booking paid ($SOLD vs $PAID)" \
  "$SOLD" "$PAID"

CONSISTENCY=$(curl -sS --max-time 10 \
  "$B/api/admin/consistency" |
  jq -r '.ok // false' 2>/dev/null || true)

cek "/api/admin/consistency ok" "$CONSISTENCY" true

# --------------------------------------------------
# Ringkasan
# --------------------------------------------------

echo
echo "===================================="
echo "HASIL PENGUJIAN DR"
echo "Database : $DB_NAME"
echo "URL      : $B"
echo "LULUS    : $PASS"
echo "GAGAL    : $FAIL"
echo "===================================="

[ "$FAIL" -eq 0 ]
