from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from .models import ProviderSnapshot, ServerSnapshot


class SnapshotStore:
    def __init__(self) -> None:
        self._servers: dict[str, ServerSnapshot] = {}
        self._providers: dict[str, ProviderSnapshot] = {}
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

    def servers(self) -> list[ServerSnapshot]:
        return sorted(self._servers.values(), key=lambda item: item.display_name)

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
