from __future__ import annotations

import json
import re
import shlex
from dataclasses import dataclass

from ..attribution import attribute_owner
from ..config import OwnerHints
from ..models import ContainerMetrics, GpuProcess

# Inspect only fields that the dashboard needs. This intentionally excludes
# Config.Env and any other potentially sensitive inspect fields.
DOCKER_INVENTORY_COMMAND = r'''LC_ALL=C sh -c 'docker ps -aq --no-trunc | xargs -r -n 1 docker inspect --format "{{.Id}}\037{{.Name}}\037{{.Config.Image}}\037{{.State.Status}}\037{{.State.StartedAt}}\037{{.State.Pid}}\037{{json .Config.Labels}}\037{{json .Mounts}}"' '''
DOCKER_STATS_COMMAND = "LC_ALL=C docker stats --no-stream --format '{{json .}}'"


@dataclass(slots=True)
class ProcessEvidence:
    pid: int
    parent_pids: list[int]
    cgroup: str = ""


def build_process_evidence_command(pids: list[int]) -> str | None:
    safe_pids = sorted({pid for pid in pids if pid > 0})
    if not safe_pids:
        return None
    pid_words = " ".join(str(pid) for pid in safe_pids)
    return (
        "LC_ALL=C sh -c 'for root_pid in " + pid_words + "; do "
        "chain=; current=$root_pid; count=0; "
        "while [ $count -lt 64 ]; do parent=$(ps -o ppid= -p \"$current\" 2>/dev/null | tr -d \"[:space:]\"); "
        "case $parent in \"\"|*[!0-9]*) break;; esac; chain=\"${chain}${parent},\"; "
        "[ \"$parent\" = 1 ] && break; current=$parent; count=$((count + 1)); done; "
        "cgroup=; [ -r /proc/$root_pid/cgroup ] && cgroup=$(tr \"\\n\" \";\" < /proc/$root_pid/cgroup); "
        "printf \"%s\\037%s\\037%s\\n\" \"$root_pid\" \"$chain\" \"$cgroup\"; done'"
    )


def build_docker_top_command(container_ids: list[str]) -> str | None:
    safe_ids = [value for value in container_ids if re.fullmatch(r"[0-9a-f]{12,64}", value)]
    if not safe_ids:
        return None
    words = " ".join(shlex.quote(value) for value in safe_ids)
    return (
        "LC_ALL=C sh -c 'for container_id in " + words + "; do "
        "printf \"__RESOURCEDECK_TOP__%s\\n\" \"$container_id\"; "
        "docker top \"$container_id\" -eo pid= 2>/dev/null; done'"
    )


def _parse_bytes(text: str | None) -> int | None:
    if not text:
        return None
    units = {"b": 1, "kb": 1000, "mb": 1000**2, "gb": 1000**3, "kib": 1024, "mib": 1024**2, "gib": 1024**3}
    match = re.fullmatch(r"\s*([0-9.]+)\s*([a-zA-Z]+)\s*", text)
    if not match:
        return None
    try:
        return int(float(match.group(1)) * units[match.group(2).lower()])
    except (ValueError, KeyError):
        return None


def parse_process_evidence(output: str) -> dict[int, ProcessEvidence]:
    result: dict[int, ProcessEvidence] = {}
    for line in output.splitlines():
        fields = line.split("\x1f", 2)
        if len(fields) != 3:
            continue
        try:
            result[int(fields[0])] = ProcessEvidence(int(fields[0]), [int(pid) for pid in fields[1].rstrip(",").split(",") if pid], fields[2])
        except ValueError:
            continue
    return result


def parse_docker_top(output: str) -> dict[str, set[int]]:
    result: dict[str, set[int]] = {}
    current: str | None = None
    for line in output.splitlines():
        if line.startswith("__RESOURCEDECK_TOP__"):
            current = line.removeprefix("__RESOURCEDECK_TOP__")
            result[current] = set()
        elif current:
            try:
                result[current].add(int(line.strip().split()[0]))
            except (ValueError, IndexError):
                pass
    return result


def _inspect_items(inventory: str) -> dict[str, dict]:
    items: dict[str, dict] = {}
    for line in inventory.splitlines():
        fields = line.split("\x1f", 7)
        if len(fields) != 8:
            continue
        identifier, name, image, status, started, init_pid, raw_labels, raw_mounts = fields
        try:
            labels, mounts, pid = json.loads(raw_labels) or {}, json.loads(raw_mounts) or [], int(init_pid)
        except (ValueError, json.JSONDecodeError):
            continue
        items[identifier] = {"ID": identifier, "Names": name.lstrip("/"), "Image": image, "Status": status, "StartedAt": started, "Pid": pid or None, "Labels": labels, "Mounts": mounts}
    return items


def parse_container_ids(inventory: str) -> list[str]:
    return list(_inspect_items(inventory))


def map_gpu_processes(processes: list[GpuProcess], containers: list[dict], evidence: dict[int, ProcessEvidence], docker_top: dict[str, set[int]]) -> None:
    by_id = {str(item["ID"]): item for item in containers}
    init_pids = {int(item["Pid"]): identifier for identifier, item in by_id.items() if item.get("Pid")}
    for process in processes:
        record = evidence.get(process.pid)
        found: str | None = None
        if record:
            for candidate in re.findall(r"(?<![0-9a-f])[0-9a-f]{12,64}(?![0-9a-f])", record.cgroup.lower()):
                found = next((identifier for identifier in by_id if identifier.startswith(candidate) or candidate.startswith(identifier)), None)
                if found:
                    process.container_mapping_source, process.container_mapping_confidence = "proc_cgroup", "high"
                    break
            if not found:
                for candidate_pid in [process.pid, *record.parent_pids]:
                    if candidate_pid in init_pids:
                        found = init_pids[candidate_pid]
                        process.container_mapping_source, process.container_mapping_confidence = "init_pid_ppid_chain", "medium"
                        break
        if not found:
            found = next((identifier for identifier, pids in docker_top.items() if process.pid in pids), None)
            if found:
                process.container_mapping_source, process.container_mapping_confidence = "docker_top", "low"
        process.container_id = found


def parse_containers(inventory: str, stats: str, hints: OwnerHints, gpu_processes: list[GpuProcess], evidence: dict[int, ProcessEvidence] | None = None, docker_top: dict[str, set[int]] | None = None) -> list[ContainerMetrics]:
    items = _inspect_items(inventory)
    map_gpu_processes(gpu_processes, list(items.values()), evidence or {}, docker_top or {})
    statistics: dict[str, dict] = {}
    for line in stats.splitlines():
        try:
            item = json.loads(line)
            statistics[item.get("ID", "")] = item
        except json.JSONDecodeError:
            continue
    output: list[ContainerMetrics] = []
    for identifier, item in items.items():
        stat = statistics.get(identifier, {})
        memory = str(stat.get("MemUsage", "")).split("/")
        try:
            cpu = float(str(stat.get("CPUPerc", "")).replace("%", ""))
        except ValueError:
            cpu = None
        related = [process for process in gpu_processes if process.container_id and process.container_id.startswith(identifier)]
        name = str(item["Names"])
        labels = item["Labels"]
        output.append(ContainerMetrics(id=identifier, name=name, image=item["Image"], status=item["Status"], started_at=item["StartedAt"], init_pid=item["Pid"], mounts=item["Mounts"], compose_project=labels.get("com.docker.compose.project") or labels.get("resourcedeck.project"), owner=attribute_owner(labels, item["Mounts"], name, hints), cpu_percent=cpu, memory_used_bytes=_parse_bytes(memory[0]) if memory else None, memory_limit_bytes=_parse_bytes(memory[1]) if len(memory) > 1 else None, gpu_memory_mib=sum(item.memory_used_mib or 0 for item in related), gpu_process_count=len(related)))
    return output
