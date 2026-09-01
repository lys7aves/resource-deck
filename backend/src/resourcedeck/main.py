from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings, load_settings
from .scheduler import PollingOrchestrator
from .state import SnapshotStore


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings(os.getenv("RESOURCEDECK_CONFIG", "config/servers.yaml"))
    store = SnapshotStore()
    orchestrator = PollingOrchestrator(settings.servers, settings.polling, store)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await orchestrator.start()
        yield
        await orchestrator.stop()

    app = FastAPI(title="ResourceDeck", version="0.1.0", lifespan=lifespan)
    app.state.store = store

    @app.get("/healthz")
    async def healthz() -> dict[str, object]:
        return {"ok": True, "configured_servers": len(settings.servers), "snapshots": len(store.servers())}

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
    settings = load_settings(os.getenv("RESOURCEDECK_CONFIG", "config/servers.yaml"))
    uvicorn.run(create_app(settings), host=settings.app.bind, port=settings.app.port)
