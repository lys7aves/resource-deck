from __future__ import annotations

from pathlib import Path
from datetime import timedelta

import pytest

from resourcedeck.config import AppSettings, CodexProviderSettings, PollingSettings, ServerSettings, Settings
from resourcedeck.main import ConfigWatcher
from resourcedeck.models import ContainerEvent, ServerSnapshot, utcnow
from resourcedeck.scheduler import PollingOrchestrator, ServerPoller
from resourcedeck.ssh import CommandResult
from resourcedeck.state import SnapshotStore


def server(identifier: str, *, tracked_users: list[str] | None = None) -> ServerSettings:
    return ServerSettings(id=identifier, ssh_host=f"{identifier}.example", tracked_users=tracked_users or [])


@pytest.mark.asyncio
async def test_reconcile_removes_snapshots_and_replaces_changed_poller():
    store = SnapshotStore()
    first = server("one")
    orchestrator = PollingOrchestrator([first], PollingSettings(), store)
    original = orchestrator.pollers["one"]
    await store.publish(ServerSnapshot(server_id="one", display_name="one"))

    changed = server("one", tracked_users=["alice"])
    await orchestrator.reconcile([changed, server("two")], PollingSettings(gpu_seconds=9))

    assert set(orchestrator.pollers) == {"one", "two"}
    assert orchestrator.pollers["one"] is not original
    await orchestrator.reconcile([server("two")], PollingSettings(gpu_seconds=9))
    assert store.server("one") is None


@pytest.mark.asyncio
async def test_reconcile_restarts_or_removes_codex_poller():
    store = SnapshotStore()
    disabled = CodexProviderSettings()
    orchestrator = PollingOrchestrator([], PollingSettings(), store, disabled)
    enabled = CodexProviderSettings(enabled=True, executable="/usr/bin/codex")
    await orchestrator.reconcile([], PollingSettings(), enabled)
    assert orchestrator.codex_poller is not None
    first = orchestrator.codex_poller
    await orchestrator.reconcile([], PollingSettings(), CodexProviderSettings(enabled=True, executable="/usr/bin/codex", poll_seconds=30))
    assert orchestrator.codex_poller is not first
    await orchestrator.reconcile([], PollingSettings(), disabled)
    assert orchestrator.codex_poller is None
    await orchestrator.stop()


@pytest.mark.asyncio
async def test_config_watcher_keeps_last_valid_configuration(tmp_path: Path):
    path = tmp_path / "servers.yaml"
    path.write_text("servers:\n  - id: one\n    ssh_host: one.example\n", encoding="utf-8")
    settings = Settings.model_validate({"servers": [{"id": "one", "ssh_host": "one.example"}]})
    store = SnapshotStore()
    orchestrator = PollingOrchestrator(settings.servers, settings.polling, store)
    watcher = ConfigWatcher(path, settings, orchestrator)

    path.write_text("polling:\n  gpu_seconds: 7\nservers:\n  - id: two\n    ssh_host: two.example\n", encoding="utf-8")
    await watcher.reload()
    assert set(orchestrator.pollers) == {"two"}
    assert watcher.last_error is None

    path.write_text("servers:\n  - id: duplicate\n    ssh_host: one\n  - id: duplicate\n    ssh_host: two\n", encoding="utf-8")
    await watcher.reload()
    assert set(orchestrator.pollers) == {"two"}
    assert watcher.last_error and "ValidationError" in watcher.last_error


def test_duplicate_server_ids_are_rejected():
    with pytest.raises(ValueError, match="server IDs must be unique"):
        Settings.model_validate({"servers": [{"id": "same", "ssh_host": "one"}, {"id": "same", "ssh_host": "two"}]})


def test_container_event_history_deduplicates_expires_and_is_bounded():
    poller = PollingOrchestrator([server("one")], PollingSettings(), SnapshotStore()).pollers["one"]
    current = ContainerEvent(occurred_at=utcnow(), action="create", container_id="a")
    expired = ContainerEvent(occurred_at=utcnow() - timedelta(hours=25), action="destroy", container_id="old")
    assert poller.retain_container_events([current, current, expired]) == [current]
    many = [ContainerEvent(occurred_at=utcnow(), action="create", container_id=str(index)) for index in range(10_001)]
    assert len(poller.retain_container_events(many)) == 10_000


@pytest.mark.asyncio
async def test_docker_event_failure_keeps_current_containers_and_stales_only_history():
    polling = PollingSettings(docker_seconds=0, users_seconds=60)
    poller = ServerPoller(server("one"), polling, SnapshotStore())
    failed = False

    async def run(command: str, timeout: float | None = None) -> CommandResult:
        if "docker events" in command:
            return CommandResult("", "denied", 1 if failed else 0)
        if "date +%s" in command:
            return CommandResult("__RESOURCEDECK_EVENTS_UNTIL__100\n", "", 0)
        if "cat /proc/stat" in command:
            return CommandResult("cpu  100 0 20 880 0 0 0 0 0 0\n__MEMINFO__\nMemTotal: 1000 kB\nMemAvailable: 400 kB\n__LOADAVG__\n1.25 0 0 1/2 3\n__CORES__\n8\n", "", 0)
        return CommandResult("", "", 0)

    poller.executor.run = run  # type: ignore[method-assign]
    await poller.collect_once()
    assert poller.snapshot.containers.status == "ok"
    assert poller.snapshot.container_events.status == "ok"
    failed = True
    await poller.collect_once()
    assert poller.snapshot.containers.status == "ok"
    assert poller.snapshot.container_events.status == "stale"


@pytest.mark.parametrize(
    ("bind", "expected"),
    [("localhost", "127.0.0.1"), ("LOCALHOST", "127.0.0.1"), ("127.0.0.1", "127.0.0.1"), ("127.0.0.2", "127.0.0.2"), ("::1", "::1")],
)
def test_loopback_bind_addresses_are_accepted(bind: str, expected: str):
    assert AppSettings(bind=bind).bind == expected


@pytest.mark.parametrize("bind", ["0.0.0.0", "::", "192.168.1.10", "dashboard.example", " localhost "])
def test_non_loopback_bind_addresses_are_rejected(bind: str):
    with pytest.raises(ValueError, match="loopback"):
        AppSettings(bind=bind)


@pytest.mark.parametrize("failure_command", ["--query-compute-apps", "--query-gpu", "/proc/$root_pid/cgroup", "docker top"])
async def test_container_vram_invalidates_between_docker_polls_and_recovers(failure_command):
    from resourcedeck.collectors.docker import DOCKER_INVENTORY_COMMAND, DOCKER_STATS_COMMAND

    poller = ServerPoller(server("one"), PollingSettings(), SnapshotStore())
    identifier = "a" * 64
    failed = False
    docker_due = True
    poller.due = lambda name, seconds: name != "docker" or docker_due

    async def run(command, timeout=None):
        if failed and failure_command in command:
            return CommandResult("", "denied", 1)
        if "cat /proc/stat" in command:
            return CommandResult("cpu  100 0 20 880\n__MEMINFO__\nMemTotal: 1000 kB\nMemAvailable: 400 kB\n__LOADAVG__\n1.25\n__CORES__\n8\n", "", 0)
        if "--query-compute-apps" in command:
            return CommandResult("GPU-a, 123, python, 400\n", "", 0)
        if "--query-gpu" in command:
            return CommandResult("0, GPU-a, A100, 0, 400, 16000, 45\n", "", 0)
        if "docker top" in command:
            return CommandResult(f"__RESOURCEDECK_TOP__{identifier}\n123\n", "", 0)
        if "/proc/$root_pid/cgroup" in command:
            if failure_command == "docker top":
                return CommandResult("", "", 0)
            return CommandResult(f"123\x1f77,1,\x1f0::/docker/{identifier}\x1falice\n", "", 0)
        if command == DOCKER_INVENTORY_COMMAND:
            return CommandResult("\x1f".join((identifier, "/trainer", "repo/train", "running", "2026-08-31T00:00:00Z", "77", "{}", "[]")), "", 0)
        if command == DOCKER_STATS_COMMAND:
            return CommandResult('{"ID":"' + identifier + '","CPUPerc":"305.1%","MemUsage":"1GiB / 4GiB"}', "", 0)
        if "date +%s" in command:
            return CommandResult("__RESOURCEDECK_EVENTS_UNTIL__100\n", "", 0)
        return CommandResult("", "", 0)

    poller.executor.run = run
    await poller.collect_once()
    assert poller.snapshot.containers.value[0].gpu_memory_mib == 400
    poller.due = lambda name, seconds: name == "docker"
    await poller.collect_once()
    assert poller.snapshot.containers.value[0].gpu_memory_mib == 400
    poller.due = lambda name, seconds: name != "docker" or docker_due
    # GPU failures invalidate VRAM; successful fallback can recover evidence failures.
    # docker top is needed only when primary attribution cannot map the PID.
    docker_due = failure_command == "docker top"
    failed = True
    await poller.collect_once()
    expected = 400 if failure_command == "/proc/$root_pid/cgroup" else None
    assert poller.snapshot.containers.value[0].gpu_memory_mib == expected
    assert poller.snapshot.containers.value[0].cpu_percent == 305.1
    if failure_command == "--query-compute-apps":
        assert poller.snapshot.gpu_processes.status == "stale"
    failed = False
    docker_due = True
    await poller.collect_once()
    assert poller.snapshot.containers.value[0].gpu_memory_mib == 400
    assert poller.snapshot.gpu_processes.status == "ok"
    poller.server.collectors.gpu = "off"
    await poller.collect_once()
    assert poller.snapshot.containers.value[0].gpu_memory_mib is None


async def test_first_gpu_process_failure_sets_unavailable():
    poller = ServerPoller(server("one"), PollingSettings(), SnapshotStore())

    async def run(command, timeout=None):
        if "cat /proc/stat" in command:
            return CommandResult("cpu  100 0 20 880\n__MEMINFO__\nMemTotal: 1000 kB\nMemAvailable: 400 kB\n__LOADAVG__\n1\n__CORES__\n8\n", "", 0)
        return CommandResult("", "denied", 1)

    poller.executor.run = run
    await poller.collect_once()
    assert poller.snapshot.gpu_processes.status == "unavailable"


async def test_container_vram_refreshes_without_docker_poll_and_skips_unneeded_top():
    from resourcedeck.collectors.docker import DOCKER_INVENTORY_COMMAND, DOCKER_STATS_COMMAND

    poller = ServerPoller(server("one"), PollingSettings(), SnapshotStore())
    identifier = "a" * 64
    docker_due = True
    memory = 400
    pid = 123
    commands = []
    poller.due = lambda name, seconds: name != "docker" or docker_due

    async def run(command, timeout=None):
        commands.append(command)
        if "cat /proc/stat" in command:
            return CommandResult("cpu  100 0 20 880\n__MEMINFO__\nMemTotal: 1000 kB\nMemAvailable: 400 kB\n__LOADAVG__\n1\n__CORES__\n8\n", "", 0)
        if "--query-compute-apps" in command:
            return CommandResult(f"GPU-a, {pid}, python, {memory}\n" if memory else "", "", 0)
        if "--query-gpu" in command:
            return CommandResult(f"0, GPU-a, A100, 0, {memory}, 16000, 45\n", "", 0)
        if "/proc/$root_pid/cgroup" in command:
            return CommandResult(f"{pid}\x1f77,1,\x1f0::/docker/{identifier}\x1falice\n", "", 0)
        if command == DOCKER_INVENTORY_COMMAND:
            return CommandResult("\x1f".join((identifier, "/trainer", "repo/train", "running", "2026-08-31T00:00:00Z", "77", "{}", "[]")), "", 0)
        if command == DOCKER_STATS_COMMAND:
            return CommandResult('{"ID":"' + identifier + '","CPUPerc":"12%","MemUsage":"1GiB / 4GiB"}', "", 0)
        if "docker top" in command:
            return CommandResult("", "denied", 1)
        return CommandResult("__RESOURCEDECK_EVENTS_UNTIL__100\n", "", 0)

    poller.executor.run = run
    await poller.collect_once()
    assert poller.snapshot.containers.value[0].gpu_memory_mib == 400
    docker_due = False
    memory, pid = 800, 456
    commands.clear()
    await poller.collect_once()
    container = poller.snapshot.containers.value[0]
    assert container.gpu_memory_mib == 800
    assert container.cpu_percent == 12
    assert poller.snapshot.gpu_processes.value[0].container_id == identifier
    assert not any("docker top" in command or command == DOCKER_INVENTORY_COMMAND for command in commands)
    memory = 0
    await poller.collect_once()
    assert poller.snapshot.containers.value[0].gpu_memory_mib == 0
    assert poller.snapshot.containers.value[0].gpu_process_count == 0
