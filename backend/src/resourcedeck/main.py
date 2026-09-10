from __future__ import annotations

import asyncio
import ipaddress
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import AsyncIterator, Literal
from urllib.parse import urlsplit

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.types import ASGIApp, Receive, Scope, Send

from .config import ServerSettings, Settings, load_settings
from .config_store import ConfigStore
from .models import utcnow
from .scheduler import PollingOrchestrator
from .state import SnapshotStore


FRONTEND_DIR = Path(__file__).parents[3] / "frontend" / "dist"


class ServerMove(BaseModel):
    server_id: str
    target_id: str
    position: Literal["before", "after"]


def is_loopback_host(host: str | None) -> bool:
    if host is None:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def request_host(scope: Scope) -> str | None:
    values = [value.decode("latin-1") for name, value in scope["headers"] if name.lower() == b"host"]
    if len(values) != 1:
        return None
    authority = values[0]
    if not authority or any(character.isspace() for character in authority) or "@" in authority:
        return None
    if authority.startswith("["):
        closing = authority.find("]")
        if closing < 0:
            return None
        host, remainder = authority[1:closing], authority[closing + 1:]
        if not host or (remainder and not remainder.startswith(":")):
            return None
        port = remainder[1:] if remainder else None
    else:
        if authority.count(":") > 1:
            return None
        host, separator, port = authority.partition(":")
        if not host:
            return None
        if not separator:
            port = None
    if port is not None and (not port.isdecimal() or not 1 <= int(port) <= 65535):
        return None
    return host


def is_allowed_origin(scope: Scope) -> bool:
    values = [value.decode("latin-1") for name, value in scope["headers"] if name.lower() == b"origin"]
    if not values:
        return True
    if len(values) != 1:
        return False
    try:
        origin = urlsplit(values[0])
        port = origin.port
    except ValueError:
        return False
    if origin.scheme not in {"http", "https"} or not origin.netloc or origin.username or origin.password:
        return False
    if origin.path or origin.query or origin.fragment:
        return False
    if port is not None and not 1 <= port <= 65535:
        return False
    return is_loopback_host(origin.hostname)


class LoopbackHostMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and not is_loopback_host(request_host(scope)):
            await JSONResponse(status_code=400, content={"detail": "A loopback Host header is required"})(scope, receive, send)
            return
        await self.app(scope, receive, send)


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
        await self.orchestrator.reconcile(candidate.servers, candidate.polling, candidate.providers.codex)
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
    store = SnapshotStore([server.id for server in settings.servers])
    orchestrator = PollingOrchestrator(settings.servers, settings.polling, store, settings.providers.codex)
    watcher = ConfigWatcher(config_path, settings, orchestrator) if config_path else None
    config_store = ConfigStore(config_path) if config_path else None

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
    app.state.config_store = config_store

    app.add_middleware(LoopbackHostMiddleware)

    def require_local(request: Request) -> None:
        host = request.client.host if request.client else None
        if not is_loopback_host(host):
            raise HTTPException(403, "Server management is only available from the local machine")

    def require_local_management(request: Request) -> None:
        require_local(request)
        if not is_allowed_origin(request.scope):
            raise HTTPException(403, "Server management requires a loopback Origin")

    async def save_servers(request: Request, servers: list) -> list:
        require_local(request)
        if not watcher or not config_store:
            raise HTTPException(503, "Configuration file is not writable")
        previous = config_store.path.read_bytes() if config_store.path.is_file() else None
        try:
            candidate = config_store.write_servers(servers)
            await watcher.reload()
            if watcher.last_error:
                raise ValueError(watcher.last_error)
        except Exception as error:
            if previous is None:
                config_store.path.unlink(missing_ok=True)
            else:
                config_store.path.write_bytes(previous)
            raise HTTPException(422, str(error)) from error
        return [server.model_dump(mode="json") for server in candidate.servers]

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

    @app.get("/api/v1/config/servers")
    async def configured_servers(request: Request):
        require_local_management(request)
        if not watcher:
            raise HTTPException(503, "Configuration management is unavailable")
        return [server.model_dump(mode="json") for server in watcher.settings.servers]

    @app.post("/api/v1/config/servers")
    async def add_server(request: Request, server: ServerSettings):
        require_local_management(request)
        if not watcher or not config_store:
            raise HTTPException(503, "Configuration file is not writable")
        existing = list(watcher.settings.servers)
        if any(item.id == server.id for item in existing):
            raise HTTPException(409, "Server ID already exists")
        return await save_servers(request, existing + [server])

    @app.patch("/api/v1/config/servers/order")
    async def reorder_servers(request: Request, move: ServerMove):
        require_local_management(request)
        if not watcher:
            raise HTTPException(503, "Configuration management is unavailable")
        if move.server_id == move.target_id:
            raise HTTPException(400, "A server cannot be moved relative to itself")
        existing = list(watcher.settings.servers)
        ids = {server.id for server in existing}
        if move.server_id not in ids or move.target_id not in ids:
            raise HTTPException(404, "Unknown configured server")
        moving = next(server for server in existing if server.id == move.server_id)
        remaining = [server for server in existing if server.id != move.server_id]
        target_index = next(index for index, server in enumerate(remaining) if server.id == move.target_id)
        insert_at = target_index + (1 if move.position == "after" else 0)
        remaining.insert(insert_at, moving)
        return await save_servers(request, remaining)

    @app.put("/api/v1/config/servers/{server_id}")
    async def update_server(server_id: str, request: Request, server: ServerSettings):
        require_local_management(request)
        if server.id != server_id:
            raise HTTPException(400, "Server ID cannot be changed")
        if not watcher:
            raise HTTPException(503, "Configuration management is unavailable")
        existing = list(watcher.settings.servers)
        if not any(item.id == server_id for item in existing):
            raise HTTPException(404, "Unknown configured server")
        return await save_servers(request, [server if item.id == server_id else item for item in existing])

    @app.patch("/api/v1/config/servers/{server_id}/enabled")
    async def toggle_server(server_id: str, request: Request, enabled: bool):
        require_local_management(request)
        if not watcher:
            raise HTTPException(503, "Configuration management is unavailable")
        existing = list(watcher.settings.servers)
        if not any(item.id == server_id for item in existing):
            raise HTTPException(404, "Unknown configured server")
        return await save_servers(request, [item.model_copy(update={"enabled": enabled}) if item.id == server_id else item for item in existing])

    @app.delete("/api/v1/config/servers/{server_id}")
    async def delete_server(server_id: str, request: Request):
        require_local_management(request)
        if not watcher:
            raise HTTPException(503, "Configuration management is unavailable")
        existing = list(watcher.settings.servers)
        if not any(item.id == server_id for item in existing):
            raise HTTPException(404, "Unknown configured server")
        return await save_servers(request, [item for item in existing if item.id != server_id])

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
            yield "event: providers\ndata: " + json.dumps([item.model_dump(mode="json") for item in store.providers()]) + "\n\n"
            revision = 0
            async for revision in store.events_after(revision):
                if await request.is_disconnected(): return
                yield f"event: snapshot\nid: {revision}\ndata: " + json.dumps([item.model_dump(mode="json") for item in store.servers()]) + "\n\n"
                yield f"event: providers\nid: {revision}\ndata: " + json.dumps([item.model_dump(mode="json") for item in store.providers()]) + "\n\n"
        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    frontend = FRONTEND_DIR
    if frontend.exists():
        app.mount("/assets", StaticFiles(directory=frontend / "assets"), name="assets")
        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str):
            return FileResponse(frontend / "index.html")
    return app


def run() -> None:
    config_path = os.getenv("RESOURCEDECK_CONFIG", "config/servers.yaml")
    settings = load_settings(config_path)
    uvicorn.run(create_app(settings, config_path=config_path), host=settings.app.bind, port=settings.app.port, timeout_graceful_shutdown=10)
