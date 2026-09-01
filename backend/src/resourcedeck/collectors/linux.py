from __future__ import annotations

from dataclasses import dataclass

from ..models import SystemMetrics

SYSTEM_COMMAND = "LC_ALL=C sh -c 'cat /proc/stat; echo __MEMINFO__; cat /proc/meminfo; echo __LOADAVG__; cat /proc/loadavg; echo __CORES__; getconf _NPROCESSORS_ONLN'"
USERS_COMMAND = "LC_ALL=C ps -eo user=,pcpu=,rss= --no-headers"


@dataclass(slots=True)
class CpuCounters:
    total: int
    idle: int


def parse_system_output(output: str, previous: CpuCounters | None) -> tuple[SystemMetrics, CpuCounters, bool]:
    stat, _, tail = output.partition("__MEMINFO__")
    mem_text, _, remaining = tail.partition("__LOADAVG__")
    load_text, _, core_text = remaining.partition("__CORES__")
    cpu_line = next((line for line in stat.splitlines() if line.startswith("cpu ")), "")
    fields = [int(value) for value in cpu_line.split()[1:] if value.isdigit()]
    if len(fields) < 4:
        raise ValueError("missing cpu counters")
    counters = CpuCounters(sum(fields), fields[3] + (fields[4] if len(fields) > 4 else 0))
    cpu_percent = None
    warming = previous is None
    if previous and counters.total > previous.total:
        cpu_percent = round(100 * (1 - (counters.idle - previous.idle) / (counters.total - previous.total)), 1)
    meminfo: dict[str, int] = {}
    for line in mem_text.splitlines():
        parts = line.replace(":", "").split()
        if len(parts) > 1 and parts[1].isdigit():
            meminfo[parts[0]] = int(parts[1]) * 1024
    total = meminfo.get("MemTotal")
    if total is None:
        raise ValueError("missing MemTotal")
    available = meminfo.get("MemAvailable")
    if available is None:
        available = max(0, meminfo.get("MemFree", 0) + meminfo.get("Buffers", 0) + meminfo.get("Cached", 0) + meminfo.get("SReclaimable", 0))
    try: load = float(load_text.strip().split()[0])
    except (ValueError, IndexError): load = None
    try: cores = int(core_text.strip().splitlines()[0])
    except (ValueError, IndexError): cores = None
    return SystemMetrics(cpu_utilization_percent=cpu_percent, logical_cores=cores, load_average_1m=load, memory_used_bytes=total-available, memory_total_bytes=total, memory_available_bytes=available), counters, warming
