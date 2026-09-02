from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import AsyncIterator

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings, load_settings
from .models import utcnow
from .scheduler import PollingOrchestrator
from .state import SnapshotStore


class ConfigWatcher:
    """Reload server and polling configuration without restarting the API process."""

    def __init__(self, path: str | Path, settings: Settings, orchestrator: PollingOrchestrator) -> None:
        self.path = Path(path)
        self.settings = settings
        self.orchestrator = orchestrator
        self.last_loaded_at: datetime = utcnow()
        self.last_error: str | None = None
        self.restart_required_fields: list[str] = []
        self._mtime_ns = self._current_mtime()
        self._task: asyncio.Task | None = None

    def _current_mtime(self) -> int | None:
        try:
            return self.path.stat().st_mtime_ns
        except FileNotFoundError:
            return None

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="config-watcher")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(1)
            current_mtime = self._current_mtime()
            if current_mtime != self._mtime_ns:
                self._mtime_ns = current_mtime
                await self.reload()

    async def reload(self) -> None:
        if not self.path.is_file():
            self.last_error = "config_file_missing"
            return
        try:
            candidate = load_settings(self.path)
        except Exception as error:
            self.last_error = f"{type(error).__name__}: {error}"
            return
        await self.orchestrator.reconcile(candidate.servers, candidate.polling)
        self.restart_required_fields = [
            field
            for field in ("bind", "port")
            if getattr(candidate.app, field) != getattr(self.settings.app, field)
        ]
        self.settings = candidate
        self.last_loaded_at = utcnow()
        self.last_error = None


def create_app(settings: Settings | None = None, *, config_path: str | Path | None = None) -> FastAPI:
    if settings is None:
        config_path = config_path or os.getenv("RESOURCEDECK_CONFIG", "config/servers.yaml")
        settings = load_settings(config_path)
    elif config_path is not None:
        config_path = Path(config_path)
    store = SnapshotStore()
    orchestrator = PollingOrchestrator(settings.servers, settings.polling, store)
    watcher = ConfigWatcher(config_path, settings, orchestrator) if config_path else None

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await orchestrator.start()
        if watcher:
            await watcher.start()
        yield
        if watcher:
            await watcher.stop()
        await orchestrator.stop()

    app = FastAPI(title="ResourceDeck", version="0.1.0", lifespan=lifespan)
    app.state.store = store
    app.state.config_watcher = watcher

    @app.get("/healthz")
    async def healthz() -> dict[str, object]:
        active_settings = watcher.settings if watcher else settings
        return {
            "ok": True,
            "configured_servers": len(active_settings.servers),
            "snapshots": len(store.servers()),
            "config_last_loaded_at": watcher.last_loaded_at if watcher else None,
            "config_reload_error": watcher.last_error if watcher else None,
            "restart_required_fields": watcher.restart_required_fields if watcher else [],
        }

    @app.get("/api/v1/servers")
    async def servers():
        return store.servers()

    @app.get("/api/v1/servers/{server_id}")
    async def server(server_id: str):
        snapshot = store.server(server_id)
        if snapshot is None: raise HTTPException(404, "Unknown server")
        return snapshot

    @app.get("/api/v1/servers/{server_id}/containers")
    async def containers(server_id: str):
        snapshot = store.server(server_id)
        if snapshot is None: raise HTTPException(404, "Unknown server")
        return snapshot.containers

    @app.get("/api/v1/servers/{server_id}/processes")
    async def processes(server_id: str):
        snapshot = store.server(server_id)
        if snapshot is None: raise HTTPException(404, "Unknown server")
        return snapshot.gpu_processes

    @app.get("/api/v1/providers")
    async def providers():
        return store.providers()

    @app.get("/api/v1/events")
    async def events(request: Request):
        async def stream() -> AsyncIterator[str]:
            yield "event: sync\ndata: " + json.dumps([item.model_dump(mode="json") for item in store.servers()]) + "\n\n"
            revision = 0
            async for revision in store.events_after(revision):
                if await request.is_disconnected(): return
                yield f"event: snapshot\nid: {revision}\ndata: " + json.dumps([item.model_dump(mode="json") for item in store.servers()]) + "\n\n"
        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    frontend = Path(__file__).parents[3] / "frontend" / "dist"
    if frontend.exists():
        app.mount("/assets", StaticFiles(directory=frontend / "assets"), name="assets")
        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str):
            target = frontend / path
            return FileResponse(target) if path and target.is_file() else FileResponse(frontend / "index.html")
    return app


def run() -> None:
    config_path = os.getenv("RESOURCEDECK_CONFIG", "config/servers.yaml")
    settings = load_settings(config_path)
    uvicorn.run(create_app(settings, config_path=config_path), host=settings.app.bind, port=settings.app.port, timeout_graceful_shutdown=10)
