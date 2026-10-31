import json
import csv
from collections import defaultdict
from datetime import datetime
from pathlib import Path

source = Path("benchmark-results/k6/autoscaling-seatmap.json")
outdir = Path("benchmark-results/analysis")
outdir.mkdir(parents=True, exist_ok=True)

metrics = defaultdict(list)
http_status = defaultdict(int)
time_bins = defaultdict(lambda: {
    "requests": 0, "errors": 0, "durations": []
})

with source.open() as f:
    for line in f:
        try:
            point = json.loads(line)
            metric = point.get("metric")
            data = point.get("data", {})
            tags = data.get("tags", {})
            value = data.get("value")
            timestamp = data.get("time")

            if metric == "http_req_duration" and value is not None:
                metrics[metric].append(value)

            elif metric == "http_req_failed" and value is not None:
                metrics[metric].append(value)

            elif metric == "http_reqs":
                status = tags.get("status", "unknown")
                http_status[status] += 1
                if timestamp:
                    second = timestamp[:19]
                    time_bins[second]["requests"] += 1
                    if status not in ("200", "201", "204"):
                        time_bins[second]["errors"] += 1

            elif metric == "http_req_duration" and timestamp:
                time_bins[timestamp[:19]]["durations"].append(value)

        except (json.JSONDecodeError, TypeError, ValueError):
            continue

def percentile(values, p):
    if not values:
        return 0
    values = sorted(values)
    index = min(len(values)-1, int((len(values)-1)*p))
    return values[index]

durations = metrics["http_req_duration"]
failures = metrics["http_req_failed"]

print("=== HASIL PEMROSESAN K6 ===")
print("Jumlah sampel durasi:", len(durations))
print("P50:", round(percentile(durations, .50), 2), "ms")
print("P95:", round(percentile(durations, .95), 2), "ms")
print("P99:", round(percentile(durations, .99), 2), "ms")
print("Error rate sampel:", round(100*sum(failures)/len(failures), 3)
      if failures else "tidak tersedia", "%")
print("Status HTTP dari tag request:", dict(http_status))

with (outdir / "per_second.csv").open("w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(["time", "requests", "errors", "avg_latency_ms"])
    for second, row in sorted(time_bins.items()):
        vals = row["durations"]
        writer.writerow([
            second, row["requests"], row["errors"],
            round(sum(vals)/len(vals), 2) if vals else ""
        ])

print("CSV tersimpan:", outdir / "per_second.csv")
