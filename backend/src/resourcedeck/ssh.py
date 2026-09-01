from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

import asyncssh

from .config import PollingSettings, ServerSettings


@dataclass(slots=True)
class CommandResult:
    stdout: str
    stderr: str
    exit_status: int


class RemoteExecutor:
    """One multiplexed, host-key-verified AsyncSSH connection per host."""

    def __init__(self, server: ServerSettings, polling: PollingSettings):
        self.server, self.polling = server, polling
        self._connection: asyncssh.SSHClientConnection | None = None
        self._lock, self._semaphore = asyncio.Lock(), asyncio.Semaphore(3)

    async def connect(self) -> None:
        if self._connection and not self._connection.is_closed():
            return
        async with self._lock:
            if self._connection and not self._connection.is_closed():
                return
            known_hosts = Path(self.server.ssh_known_hosts).expanduser()
            if not known_hosts.is_file():
                raise FileNotFoundError(f"SSH known_hosts file is missing: {known_hosts}")
            self._connection = await asyncio.wait_for(asyncssh.connect(
                self.server.ssh_host, port=self.server.ssh_port, username=self.server.ssh_user,
                connect_timeout=self.polling.connect_timeout_seconds, keepalive_interval=15,
                keepalive_count_max=3, known_hosts=str(known_hosts)), timeout=self.polling.connect_timeout_seconds)

    async def run(self, command: str, timeout: float | None = None) -> CommandResult:
        await self.connect()
        assert self._connection is not None
        async with self._semaphore:
            try:
                result = await asyncio.wait_for(self._connection.run(command, check=False), timeout=timeout or self.polling.command_timeout_seconds)
            except (asyncssh.Error, OSError, asyncio.TimeoutError):
                await self.close()
                raise
        return CommandResult(result.stdout, result.stderr, result.exit_status)

    async def close(self) -> None:
        if self._connection:
            self._connection.close()
            try:
                await self._connection.wait_closed()
            finally:
                self._connection = None
