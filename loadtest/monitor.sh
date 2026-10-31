#!/usr/bin/env bash
# monitor.sh <berkas.csv> [interval_detik]  — catat CPU/memori container, koneksi Postgres, dan metrik runtime API
OUT=${1:?pemakaian: monitor.sh berkas.csv [interval]}; IV=${2:-5}
echo "ts,kind,name,value" > "$OUT"
while true; do
  ts=$(date +%s)
  docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemPerc}}' 2>/dev/null | while read -r n cpu mem; do
    echo "$ts,cpu,$n,${cpu%\%}" >> "$OUT"
    echo "$ts,mem,$n,${mem%\%}" >> "$OUT"
  done
  pgc=$(docker compose exec -T postgres psql -U ticket -d ticketing -tA -c "SELECT count(*) FROM pg_stat_activity WHERE datname='ticketing'" 2>/dev/null)
  echo "$ts,pg_conns,postgres,${pgc:-0}" >> "$OUT"
  for p in 3001 3002; do
    j=$(curl -s --max-time 2 "localhost:$p/api/admin/runtime")
    if [ -n "$j" ]; then
      echo "$ts,pool_waiting,api@$p,$(echo "$j" | jq -r .pool.waiting)" >> "$OUT"
      echo "$ts,loop_lag_ms,api@$p,$(echo "$j" | jq -r .eventLoop.p99Ms)" >> "$OUT"
    fi
  done
  sleep "$IV"
done
