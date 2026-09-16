from __future__ import annotations

from collections import defaultdict

from ..models import UserMetrics


def parse_users(output: str) -> list[UserMetrics]:
    totals: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
    system_accounts: dict[str, bool] = {}
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 4: continue
        try:
            uid, username = int(parts[0]), parts[1]
            totals[username][0] += float(parts[2]) / 100
            totals[username][1] += int(parts[3]) * 1024
            system_accounts[username] = uid < 1000
        except ValueError: continue
    return [UserMetrics(username=name, estimated_cpu_cores=round(value[0], 2), memory_rss_bytes=int(value[1]), is_system=system_accounts.get(name, False)) for name, value in sorted(totals.items())]
