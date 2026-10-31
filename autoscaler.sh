#!/usr/bin/env bash
set -u

MIN_REPLICAS=2
MAX_REPLICAS=6
UP_CPU=60
DOWN_CPU=25
INTERVAL=10
COOLDOWN=30

up_count=0
down_count=0
last_scale=0

get_cpu_max() {
    local max=0 id cpu
    while read -r id; do
        [ -n "$id" ] || continue
        cpu=$(docker stats --no-stream --format '{{.CPUPerc}}' "$id" 2>/dev/null | tr -d '%')
        cpu=${cpu:-0}

        if awk -v a="$cpu" -v b="$max" 'BEGIN { exit !(a>b) }'; then
            max="$cpu"
        fi
    done < <(docker compose ps -q api)

    printf '%s\n' "$max"
}

while true; do
    count=$(docker compose ps -q api | awk 'END {print NR+0}')
    cpu=$(get_cpu_max)
    now=$(date +%s)

    echo "[$(date '+%H:%M:%S')] replika=$count CPU-tertinggi=${cpu}%"

    if awk -v c="$cpu" -v t="$UP_CPU" 'BEGIN {exit !(c>t)}'; then
        up_count=$((up_count + 1))
        down_count=0
    elif awk -v c="$cpu" -v t="$DOWN_CPU" 'BEGIN {exit !(c<t)}'; then
        down_count=$((down_count + 1))
        up_count=0
    else
        up_count=0
        down_count=0
    fi

    if (( now - last_scale >= COOLDOWN )); then
        if (( up_count >= 3 && count < MAX_REPLICAS )); then
            target=$((count + 1))
            echo "SCALE OUT: $count -> $target replika"
            if docker compose up -d --scale "api=$target" api; then
                last_scale=$(date +%s)
            fi
            up_count=0
            down_count=0
        elif (( down_count >= 6 && count > MIN_REPLICAS )); then
            target=$((count - 1))
            echo "SCALE IN: $count -> $target replika"
            if docker compose up -d --scale "api=$target" api; then
                last_scale=$(date +%s)
            fi
            up_count=0
            down_count=0
        fi
    fi

    sleep "$INTERVAL"
done
