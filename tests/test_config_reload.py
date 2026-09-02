from __future__ import annotations

from pathlib import Path

import pytest

from resourcedeck.config import CodexProviderSettings, PollingSettings, ServerSettings, Settings
from resourcedeck.main import ConfigWatcher
from resourcedeck.models import ServerSnapshot
from resourcedeck.scheduler import PollingOrchestrator
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
    await orchestrator.reconcile([], PollingSettings(), CodexProviderSettings(enabled=True, executable="/usr/bin/codex", reconnect_seconds=30))
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
