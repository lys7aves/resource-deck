from __future__ import annotations

import asyncio
import random

from .collectors.docker import (DOCKER_INVENTORY_COMMAND, DOCKER_STATS_COMMAND, build_docker_top_command, build_process_evidence_command, parse_container_ids, parse_containers, parse_docker_top, parse_process_evidence)
from .collectors.linux import SYSTEM_COMMAND, USERS_COMMAND, CpuCounters, parse_system_output
from .collectors.nvidia import GPU_COMMAND, GPU_PROCESS_COMMAND, parse_gpu_processes, parse_gpus
from .collectors.users import parse_users
from .config import PollingSettings, ServerSettings
from .models import Capabilities, ConnectionStatus, MetricEnvelope, MetricStatus, ServerSnapshot, utcnow
from .ssh import RemoteExecutor
from .state import SnapshotStore


class ServerPoller:
    def __init__(self, server: ServerSettings, polling: PollingSettings, store: SnapshotStore):
        self.server, self.polling, self.store = server, polling, store
        self.executor = RemoteExecutor(server, polling)
        self.previous_cpu: CpuCounters | None = None
        self.snapshot = ServerSnapshot(server_id=server.id, display_name=server.display_name or server.id, tracked_users_configured=bool(server.tracked_users))
        self._last: dict[str, float] = {}

    async def run(self) -> None:
        await asyncio.sleep(random.uniform(0, 0.2 * self.polling.system_seconds))
        while True:
            try:
                await self.collect_once()
            except asyncio.CancelledError:
                await self.executor.close()
                raise
            except Exception as error:
                self.snapshot.connection = ConnectionStatus.OFFLINE
                self.snapshot.diagnostics.collector_errors["connection"] = type(error).__name__
                self.snapshot.collected_at = utcnow()
                await self.store.publish(self.snapshot)
                await asyncio.sleep(min(60, max(1, self.polling.system_seconds * 2)))
            else:
                await asyncio.sleep(self.polling.system_seconds)

    def due(self, name: str, seconds: float) -> bool:
        now = asyncio.get_running_loop().time()
        if now - self._last.get(name, 0) >= seconds:
            self._last[name] = now
            return True
        return False

    async def collect_once(self) -> None:
        self.snapshot.connection = ConnectionStatus.ONLINE
        jobs: dict[str, asyncio.Task] = {"system": asyncio.create_task(self.executor.run(SYSTEM_COMMAND))}
        if self.due("gpu", self.polling.gpu_seconds) and self.server.collectors.gpu != "off":
            jobs["gpu"] = asyncio.create_task(self.executor.run(GPU_COMMAND))
            jobs["gpu_processes"] = asyncio.create_task(self.executor.run(GPU_PROCESS_COMMAND))
        if self.due("users", self.polling.users_seconds):
            jobs["users"] = asyncio.create_task(self.executor.run(USERS_COMMAND))
        if self.due("docker", self.polling.docker_seconds) and self.server.collectors.docker != "off":
            jobs["docker_inventory"] = asyncio.create_task(self.executor.run(DOCKER_INVENTORY_COMMAND))
            jobs["docker_stats"] = asyncio.create_task(self.executor.run(DOCKER_STATS_COMMAND))
        results = {name: result for name, result in zip(jobs, await asyncio.gather(*jobs.values(), return_exceptions=True))}
        errors: dict[str, str] = {}
        system = results["system"]
        if isinstance(system, Exception):
            raise system
        metrics, self.previous_cpu, warming = parse_system_output(system.stdout, self.previous_cpu)
        self.snapshot.system = MetricEnvelope(status=MetricStatus.WARMING_UP if warming else MetricStatus.OK, value=metrics, measurement_method="proc_stat_delta_and_memavailable")
        self.snapshot.capabilities.system = MetricStatus.OK
        for name, result in results.items():
            if isinstance(result, Exception) or getattr(result, "exit_status", 1) != 0:
                if name != "system":
                    errors[name] = type(result).__name__ if isinstance(result, Exception) else "command_failed"
        if "gpu" in results and "gpu" not in errors:
            self.snapshot.gpus = MetricEnvelope(status=MetricStatus.OK, value=parse_gpus(results["gpu"].stdout), measurement_method="nvidia_smi")
            self.snapshot.capabilities.gpu = MetricStatus.OK
        elif "gpu" in errors:
            self.snapshot.gpus.status = MetricStatus.UNAVAILABLE if self.snapshot.gpus.value is None else MetricStatus.STALE
        if "gpu_processes" in results and "gpu_processes" not in errors:
            self.snapshot.gpu_processes = MetricEnvelope(status=MetricStatus.OK, value=parse_gpu_processes(results["gpu_processes"].stdout), measurement_method="nvidia_smi")
        gpu_processes = self.snapshot.gpu_processes.value or []
        evidence_command = build_process_evidence_command([process.pid for process in gpu_processes])
        evidence = {}
        if evidence_command:
            try:
                evidence_result = await self.executor.run(evidence_command)
                if evidence_result.exit_status == 0:
                    evidence = parse_process_evidence(evidence_result.stdout)
                else:
                    errors["gpu_process_evidence"] = "command_failed"
            except Exception as error:
                errors["gpu_process_evidence"] = type(error).__name__
        if "users" in results and "users" not in errors:
            users = parse_users(results["users"].stdout)
            tracked_users = set(self.server.tracked_users)
            for user in users:
                user.tracked = user.username in tracked_users
            self.snapshot.users = MetricEnvelope(status=MetricStatus.OK, value=users, measurement_method="ps_percent_cpu_rss")
            self.snapshot.capabilities.users = MetricStatus.OK
        if "docker_inventory" in results and "docker_inventory" not in errors and "docker_stats" not in errors:
            top = {}
            top_command = build_docker_top_command(parse_container_ids(results["docker_inventory"].stdout))
            if top_command:
                try:
                    top_result = await self.executor.run(top_command)
                    if top_result.exit_status == 0:
                        top = parse_docker_top(top_result.stdout)
                    else:
                        errors["docker_top"] = "command_failed"
                except Exception as error:
                    errors["docker_top"] = type(error).__name__
            self.snapshot.containers = MetricEnvelope(status=MetricStatus.OK, value=parse_containers(results["docker_inventory"].stdout, results["docker_stats"].stdout, self.server.owner_hints, gpu_processes, evidence, top), measurement_method="docker_cli")
            self.snapshot.capabilities.docker = MetricStatus.OK
        elif "docker_inventory" in errors or "docker_stats" in errors:
            self.snapshot.containers.status = MetricStatus.UNAVAILABLE if self.snapshot.containers.value is None else MetricStatus.STALE
        self.snapshot.diagnostics.collector_errors = errors
        if errors:
            self.snapshot.connection = ConnectionStatus.DEGRADED
        self.snapshot.collected_at = utcnow()
        await self.store.publish(self.snapshot)


class PollingOrchestrator:
    def __init__(self, servers: list[ServerSettings], polling: PollingSettings, store: SnapshotStore):
        self.store = store
        self.polling = polling
        self.pollers = {server.id: ServerPoller(server, polling, store) for server in servers}
        self._tasks: dict[str, asyncio.Task] = {}
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        async with self._lock:
            for server_id, poller in self.pollers.items():
                self._start_poller(server_id, poller)

    async def stop(self) -> None:
        async with self._lock:
            tasks = list(self._tasks.values())
            self._tasks = {}
            for task in tasks:
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def _start_poller(self, server_id: str, poller: ServerPoller) -> None:
        if server_id not in self._tasks:
            self._tasks[server_id] = asyncio.create_task(poller.run(), name=f"poll-{server_id}")

    async def _stop_poller(self, server_id: str) -> None:
        task = self._tasks.pop(server_id, None)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def reconcile(self, servers: list[ServerSettings], polling: PollingSettings) -> None:
        """Apply a validated configuration while retaining unaffected pollers."""
        desired = {server.id: server for server in servers}
        async with self._lock:
            removed = set(self.pollers) - set(desired)
            changed = {
                server_id
                for server_id, server in desired.items()
                if server_id not in self.pollers
                or self.pollers[server_id].server != server
                or self.pollers[server_id].polling != polling
            }
            for server_id in removed | changed:
                await self._stop_poller(server_id)
                self.pollers.pop(server_id, None)
            for server_id in removed:
                await self.store.remove_server(server_id)
            self.polling = polling
            for server_id in changed:
                poller = ServerPoller(desired[server_id], polling, self.store)
                self.pollers[server_id] = poller
                self._start_poller(server_id, poller)
