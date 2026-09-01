from __future__ import annotations

from collections import defaultdict

from ..models import UserMetrics


def parse_users(output: str) -> list[UserMetrics]:
    totals: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 3: continue
        try:
            totals[parts[0]][0] += float(parts[1]) / 100
            totals[parts[0]][1] += int(parts[2]) * 1024
        except ValueError: continue
    return [UserMetrics(username=name, estimated_cpu_cores=round(value[0], 2), memory_rss_bytes=int(value[1])) for name, value in sorted(totals.items())]
