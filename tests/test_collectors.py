from resourcedeck.attribution import attribute_owner
from resourcedeck.collectors.linux import CpuCounters, parse_system_output
from resourcedeck.collectors.nvidia import parse_gpus
from resourcedeck.collectors.users import parse_users
from resourcedeck.config import OwnerHints


def test_system_parser_uses_memavailable_and_cpu_delta():
    first = "cpu  100 0 20 880 0 0 0 0 0 0\n__MEMINFO__\nMemTotal: 1000 kB\nMemAvailable: 400 kB\n__LOADAVG__\n1.25 0 0 1/2 3\n__CORES__\n8\n"
    _, counters, warming = parse_system_output(first, None)
    second = first.replace("100 0 20 880", "150 0 30 920")
    metrics, _, _ = parse_system_output(second, counters)
    assert warming is True
    assert metrics.memory_used_bytes == 600 * 1024
    assert metrics.cpu_utilization_percent == 60.0


def test_gpu_reserved_when_vram_is_high_and_util_is_low():
    gpus = parse_gpus("0, GPU-a, A100, 0, 15000, 16000, 45\n")
    assert gpus[0].state == "reserved"


def test_user_cpu_is_shown_as_estimated_cores():
    users = parse_users("yuseop 840.0 1024\nyuseop 10.0 512\n")
    assert users[0].estimated_cpu_cores == 8.5
    assert users[0].memory_rss_bytes == 1536 * 1024


def test_owner_label_has_priority():
    result = attribute_owner({"resourcedeck.owner": "alice", "com.docker.compose.project": "x"}, [], "bob-job", OwnerHints(compose_projects={"x": "bob"}))
    assert result.owner == "alice"
    assert result.source == "label"

from resourcedeck.collectors.docker import (
    ProcessEvidence,
    build_docker_top_command,
    build_process_evidence_command,
    parse_containers,
    parse_process_evidence,
)
from resourcedeck.models import GpuProcess


def _inventory(identifier: str, pid: int = 77) -> str:
    return "\x1f".join((identifier, "/trainer", "repo/train:latest", "running", "2026-08-31T00:00:00Z", str(pid), '{"com.docker.compose.project":"ml"}', '[{"Source":"/home/alice/run","Destination":"/work","Type":"bind"}]'))


def test_selected_inspect_owner_and_cgroup_gpu_mapping():
    identifier = "a" * 64
    process = GpuProcess(pid=123, memory_used_mib=400)
    containers = parse_containers(_inventory(identifier), '{"ID":"' + identifier + '","CPUPerc":"12.5%","MemUsage":"1.5GiB / 4GiB"}', OwnerHints(compose_projects={"ml": "compose-owner"}, home_prefixes={"/home/alice": "alice"}), [process], {123: ProcessEvidence(123, [77, 1], f"0::/docker/{identifier}")})
    assert containers[0].owner.owner == "compose-owner"
    assert containers[0].owner.source == "compose_project"
    assert containers[0].mounts[0]["Source"] == "/home/alice/run"
    assert containers[0].memory_used_bytes == int(1.5 * 1024**3)
    assert process.container_id == identifier
    assert process.container_mapping_source == "proc_cgroup"
    assert process.container_mapping_confidence == "high"


def test_gpu_mapping_falls_back_to_init_pid_then_docker_top_then_unmapped():
    first, second = "b" * 64, "c" * 64
    processes = [GpuProcess(pid=201), GpuProcess(pid=202), GpuProcess(pid=203)]
    parse_containers("\n".join((_inventory(first, 77), _inventory(second, 88))), "", OwnerHints(), processes, {201: ProcessEvidence(201, [77, 1])}, {second: {202}})
    assert (processes[0].container_id, processes[0].container_mapping_source) == (first, "init_pid_ppid_chain")
    assert (processes[1].container_id, processes[1].container_mapping_source) == (second, "docker_top")
    assert (processes[2].container_id, processes[2].container_mapping_source) == (None, "unmapped")


def test_remote_mapping_commands_are_read_only_and_pid_constrained():
    command = build_process_evidence_command([10, -1, 10])
    assert command and "/proc/$root_pid/cgroup" in command and "ps -o user=" in command and "kill" not in command
    top = build_docker_top_command(["d" * 64, "not-an-id"])
    assert top and "docker top" in top and "not-an-id" not in top


def test_process_evidence_includes_host_username_and_accepts_legacy_rows():
    evidence = parse_process_evidence("123\x1f77,1,\x1f0::/docker/abc\x1falice\n124\x1f1,\x1f0::/\n")
    assert evidence[123].username == "alice"
    assert evidence[124].username is None

async def test_ssh_rejects_missing_known_hosts(tmp_path):
    import pytest
    from resourcedeck.config import PollingSettings, ServerSettings
    from resourcedeck.ssh import RemoteExecutor

    executor = RemoteExecutor(ServerSettings(id="local", ssh_host="localhost", ssh_known_hosts=str(tmp_path / "missing")), PollingSettings())
    with pytest.raises(FileNotFoundError, match="known_hosts"):
        await executor.connect()
