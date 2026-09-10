from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from .models import ProviderSnapshot, ServerSnapshot


class SnapshotStore:
    def __init__(self, server_order: list[str] | None = None) -> None:
        self._servers: dict[str, ServerSnapshot] = {}
        self._providers: dict[str, ProviderSnapshot] = {}
        self._server_order = server_order or []
        self._revision = 0
        self._condition = asyncio.Condition()

    async def publish(self, snapshot: ServerSnapshot) -> ServerSnapshot:
        async with self._condition:
            self._revision += 1
            snapshot.revision = self._revision
            self._servers[snapshot.server_id] = snapshot
            self._condition.notify_all()
            return snapshot

    async def publish_provider(self, snapshot: ProviderSnapshot) -> ProviderSnapshot:
        async with self._condition:
            self._revision += 1
            self._providers[snapshot.provider_id] = snapshot
            self._condition.notify_all()
            return snapshot

    async def remove_server(self, server_id: str) -> bool:
        async with self._condition:
            if server_id not in self._servers:
                return False
            del self._servers[server_id]
            self._revision += 1
            self._condition.notify_all()
            return True

    async def remove_provider(self, provider_id: str) -> bool:
        async with self._condition:
            if provider_id not in self._providers:
                return False
            del self._providers[provider_id]
            self._revision += 1
            self._condition.notify_all()
            return True

    async def set_server_order(self, server_order: list[str]) -> bool:
        """Publish a configuration-only server ordering change."""
        async with self._condition:
            if self._server_order == server_order:
                return False
            self._server_order = list(server_order)
            self._revision += 1
            self._condition.notify_all()
            return True

    def servers(self) -> list[ServerSnapshot]:
        positions = {server_id: index for index, server_id in enumerate(self._server_order)}
        return sorted(
            self._servers.values(),
            key=lambda item: (positions.get(item.server_id, len(positions)), item.display_name),
        )

    def server(self, server_id: str) -> ServerSnapshot | None:
        return self._servers.get(server_id)

    def providers(self) -> list[ProviderSnapshot]:
        return list(self._providers.values())

    async def events_after(self, revision: int) -> AsyncIterator[int]:
        last = revision
        while True:
            async with self._condition:
                await self._condition.wait_for(lambda: self._revision > last)
                last = self._revision
            yield last
