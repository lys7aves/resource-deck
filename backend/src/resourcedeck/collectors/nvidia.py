from __future__ import annotations

import csv
from io import StringIO

from ..models import GpuMetrics, GpuProcess

GPU_COMMAND = "LC_ALL=C nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits"
GPU_PROCESS_COMMAND = "LC_ALL=C nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits"


def _number(value: str) -> float | None:
    value = value.strip()
    return None if not value or value.upper() == "N/A" else float(value)


def parse_gpus(output: str) -> list[GpuMetrics]:
    result: list[GpuMetrics] = []
    for row in csv.reader(StringIO(output), skipinitialspace=True):
        if len(row) < 7: continue
        used, total, util = _number(row[4]), _number(row[5]), _number(row[3])
        state = "unknown" if util is None or used is None or not total else ("busy" if util >= 5 else "reserved" if used / total >= .1 else "idle")
        result.append(GpuMetrics(index=int(row[0]), uuid=row[1] or None, name=row[2] or None, utilization_percent=util, memory_used_mib=used, memory_total_mib=total, temperature_c=_number(row[6]), state=state))
    return result


def parse_gpu_processes(output: str) -> list[GpuProcess]:
    result: list[GpuProcess] = []
    for row in csv.reader(StringIO(output), skipinitialspace=True):
        if len(row) < 4: continue
        try:
            memory = _number(row[3])
            result.append(GpuProcess(gpu_uuid=row[0] or None, pid=int(row[1]), process_name=row[2] or None, memory_used_mib=int(memory) if memory is not None else None))
        except ValueError: continue
    return result
