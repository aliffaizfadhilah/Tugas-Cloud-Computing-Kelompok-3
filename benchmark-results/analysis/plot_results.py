import csv
from pathlib import Path
from datetime import datetime
import matplotlib.pyplot as plt

folder = Path("benchmark-results/analysis")
with (folder / "per_second.csv").open() as f:
    rows = list(csv.DictReader(f))

times = [datetime.fromisoformat(r["time"]) for r in rows]
throughput = [int(r["requests"]) for r in rows]
latency = [
    float(r["avg_latency_ms"]) if r["avg_latency_ms"] else 0
    for r in rows
]
error_rate = [
    100 * int(r["errors"]) / int(r["requests"])
    if int(r["requests"]) else 0
    for r in rows
]

charts = [
    ("throughput.png", throughput, "Throughput", "Requests per second"),
    ("response_time.png", latency, "Response Time", "Average latency (ms)"),
    ("error_rate.png", error_rate, "Error Rate", "Errors (%)"),
]

for filename, values, title, ylabel in charts:
    plt.figure(figsize=(12, 5))
    plt.plot(times, values)
    plt.title(title + " During Stress Test")
    plt.xlabel("Time")
    plt.ylabel(ylabel)
    plt.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(folder / filename, dpi=160)
    plt.close()

print("Grafik tersimpan di", folder)
for filename, *_ in charts:
    print(folder / filename)
