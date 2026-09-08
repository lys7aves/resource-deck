from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from resourcedeck.config import Settings, load_settings
from resourcedeck.main import create_app


async def request(app, method: str, path: str, *, headers=None, client=("127.0.0.1", 50000), json=None):
    transport = httpx.ASGITransport(app=app, client=client)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as session:
        return await session.request(method, path, headers=headers, json=json)


@pytest.mark.asyncio
async def test_spa_fallback_never_serves_request_selected_files(tmp_path: Path, monkeypatch):
    frontend = tmp_path / "dist"
    assets = frontend / "assets"
    assets.mkdir(parents=True)
    (frontend / "index.html").write_text("safe index", encoding="utf-8")
    (assets / "app.js").write_text("asset", encoding="utf-8")
    secret = tmp_path / "secret.txt"
    secret.write_text("not for the browser", encoding="utf-8")
    (frontend / "escape").symlink_to(secret)
    monkeypatch.setattr("resourcedeck.main.FRONTEND_DIR", frontend)
    app = create_app(Settings())

    spa = next(route.endpoint for route in app.routes if getattr(route, "path", None) == "/{path:path}")
    for path in ("dashboard", "../secret.txt", "..\\secret.txt", "escape"):
        response = await spa(path)
        assert response.path == frontend / "index.html"


@pytest.mark.asyncio
async def test_host_validation_blocks_untrusted_authorities():
    app = create_app(Settings())
    for host in ("attacker.example", "127.0.0.1.attacker.example", "2130706433", "localhost.", "[::1", "127.0.0.1:0", "0.0.0.0"):
        response = await request(app, "GET", "/healthz", headers={"Host": host})
        assert response.status_code == 400
    duplicated = await request(app, "GET", "/healthz", headers=[("Host", "127.0.0.1"), ("Host", "attacker.example")])
    assert duplicated.status_code == 400
    response = await request(app, "GET", "/healthz", headers={"Host": "[::1]:8765"})
    assert response.status_code == 200
    forwarded = await request(app, "GET", "/healthz", headers={"X-Forwarded-Host": "attacker.example"})
    assert forwarded.status_code == 200


@pytest.mark.asyncio
async def test_config_management_requires_local_peer_and_origin(tmp_path: Path):
    path = tmp_path / "servers.yaml"
    path.write_text("servers:\n  - id: one\n    ssh_host: one.example\n", encoding="utf-8")
    app = create_app(load_settings(path), config_path=path)

    remote = await request(app, "GET", "/api/v1/config/servers", client=("192.0.2.1", 50000))
    assert remote.status_code == 403
    foreign_origin = await request(app, "GET", "/api/v1/config/servers", headers={"Origin": "https://attacker.example"})
    assert foreign_origin.status_code == 403
    local = await request(app, "GET", "/api/v1/config/servers", headers={"Origin": "http://localhost:5173"})
    assert local.status_code == 200
    assert local.json()[0]["id"] == "one"
    cli = await request(app, "GET", "/api/v1/config/servers")
    assert cli.status_code == 200

    blocked_write = await request(
        app,
        "POST",
        "/api/v1/config/servers",
        headers={"Origin": "https://attacker.example"},
        json={"id": "two", "ssh_host": "two.example"},
    )
    assert blocked_write.status_code == 403
