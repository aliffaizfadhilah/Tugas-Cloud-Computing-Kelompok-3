#!/usr/bin/env bash
# Jalankan dari folder proyek. Contoh:
#   FLOW=booking TAG=base ./loadtest/run-stages.sh
#   FLOW=queue ADMIT_PER_TICK=5 STAGES="10 100" ./loadtest/run-stages.sh
set -u
FLOW=${FLOW:-booking}
TAG=${TAG:-base}
STAGES=${STAGES:-"10 100 500 1000"}
HOLD=${HOLD:-2m}
RAMP=${RAMP:-30s}
NET=${NET:-konser_default}
OUT=loadtest/out
mkdir -p "$OUT"
[ -x ./loadtest/monitor.sh ] || { echo "ERROR: loadtest/monitor.sh belum ada atau belum chmod +x"; exit 1; }
docker network inspect "$NET" >/dev/null 2>&1 || { echo "ERROR: network $NET tidak ada. Jalankan: docker compose up -d"; exit 1; }
[ -n "$(docker compose ps --status running -q postgres)" ] || { echo "ERROR: postgres tidak berjalan. Jalankan: docker compose up -d"; exit 1; }
PSQL=(docker compose exec -T postgres psql -U ticket -d ticketing -tA -c)

reset_state() {
  "${PSQL[@]}" "DELETE FROM bookings; DELETE FROM payments; DELETE FROM idempotency; DELETE FROM queue_tokens; UPDATE seats SET status='available', held_by=NULL, hold_until=NULL;" >/dev/null
  docker compose exec -T redis redis-cli FLUSHALL >/dev/null
  sleep 3
}

for vu in $STAGES; do
  echo; echo "################ TAG=$TAG  FLOW=$FLOW  VU=$vu  (tahan $HOLD) ################"
  reset_state
  ./loadtest/monitor.sh "$OUT/stats-$TAG-$FLOW-$vu.csv" 5 &
  MON=$!
  docker run --rm -i --user "$(id -u):$(id -g)" --network "$NET" \
    -v "$PWD/loadtest:/scripts:ro" -v "$PWD/$OUT:/out" \
    -e BASE_URL=http://nginx -e FLOW="$FLOW" -e VUS="$vu" -e HOLD="$HOLD" -e RAMP="$RAMP" -e TAG="$TAG" \
    -e K6_WEB_DASHBOARD=true -e "K6_WEB_DASHBOARD_EXPORT=/out/report-$TAG-$FLOW-$vu.html" \
    grafana/k6 run /scripts/stress.js 2>&1 | tee "$OUT/k6-$TAG-$FLOW-$vu.txt"
  pkill -P "$MON" 2>/dev/null; kill "$MON" 2>/dev/null; wait "$MON" 2>/dev/null
  echo "-- log error API pada tahap ini:"
  docker compose logs --since 5m api1 api2 2>/dev/null | grep -ciE "timeout exceeded|ECONNREFUSED|ECONNRESET|\[err\]" | sed 's/^/   baris error: /'
  echo "pendinginan 30 detik..."; sleep 30
done
python3 loadtest/charts.py "$FLOW" "$TAG"
