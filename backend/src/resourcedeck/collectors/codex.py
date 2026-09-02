from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any


class CodexCollectorError(Exception):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def codex_environment(executable: str) -> dict[str, str]:
    environment = os.environ.copy()
    try:
        executable_path = Path(executable).resolve()
    except OSError:
        return environment
    codex_home = next((parent for parent in executable_path.parents if parent.name == ".codex"), None)
    if codex_home:
        environment["CODEX_HOME"] = str(codex_home)
    environment.setdefault("CODEX_SQLITE_HOME", str(Path.home() / ".codex" / "sqlite"))
    return environment


def _window(kind: str, value: Any) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    used, duration, resets_at = value.get("usedPercent"), value.get("windowDurationMins"), value.get("resetsAt")
    if not isinstance(used, (int, float)) or not isinstance(duration, (int, float)) or not isinstance(resets_at, (int, float)):
        raise CodexCollectorError("codex_malformed_response")
    used_percent = max(0, min(100, float(used)))
    return {"kind": kind, "used_percent": used_percent, "remaining_percent": 100 - used_percent, "window_duration_minutes": int(duration), "resets_at": int(resets_at)}


def parse_rate_limits_response(result: Mapping[str, Any]) -> dict[str, Any]:
    raw_buckets = result.get("rateLimitsByLimitId")
    if not isinstance(raw_buckets, Mapping):
        single = result.get("rateLimits")
        raw_buckets = {"codex": single} if isinstance(single, Mapping) else None
    if not isinstance(raw_buckets, Mapping) or not raw_buckets:
        raise CodexCollectorError("codex_malformed_response")

    buckets: list[dict[str, Any]] = []
    for bucket_key, raw_bucket in raw_buckets.items():
        if not isinstance(bucket_key, str) or not isinstance(raw_bucket, Mapping):
            raise CodexCollectorError("codex_malformed_response")
        identifier = raw_bucket.get("limitId", bucket_key)
        if not isinstance(identifier, str):
            raise CodexCollectorError("codex_malformed_response")
        windows = [window for window in (_window("primary", raw_bucket.get("primary")), _window("secondary", raw_bucket.get("secondary"))) if window]
        if not windows:
            raise CodexCollectorError("codex_malformed_response")
        credits = raw_bucket.get("credits")
        sanitized_credits = None
        if isinstance(credits, Mapping):
            sanitized_credits = {"has_credits": bool(credits.get("hasCredits", False)), "unlimited": bool(credits.get("unlimited", False)), "balance": str(credits.get("balance", "0"))}
        buckets.append({"id": identifier, "name": raw_bucket.get("limitName") if isinstance(raw_bucket.get("limitName"), str) else None, "plan_type": raw_bucket.get("planType") if isinstance(raw_bucket.get("planType"), str) else None, "windows": windows, "credits": sanitized_credits, "rate_limit_reached_type": raw_bucket.get("rateLimitReachedType") if isinstance(raw_bucket.get("rateLimitReachedType"), str) else None})
    buckets.sort(key=lambda item: (item["id"] != "codex", item["id"]))
    resets = result.get("rateLimitResetCredits")
    available_resets = resets.get("availableCount") if isinstance(resets, Mapping) else None
    return {"plan_type": next((item["plan_type"] for item in buckets if item["plan_type"]), None), "buckets": buckets, "reset_credits_available": available_resets if isinstance(available_resets, int) else None}


def merge_rate_limit_update(data: Mapping[str, Any], update: Mapping[str, Any]) -> dict[str, Any]:
    incoming = parse_rate_limits_response({"rateLimits": update})["buckets"][0]
    merged = dict(data)
    buckets = [dict(item) for item in data.get("buckets", []) if isinstance(item, Mapping)]
    for index, existing in enumerate(buckets):
        if existing.get("id") != incoming["id"]:
            continue
        windows = {window["kind"]: window for window in existing.get("windows", [])}
        windows.update({window["kind"]: window for window in incoming["windows"]})
        incoming = {**existing, **incoming, "windows": [windows[kind] for kind in ("primary", "secondary") if kind in windows]}
        if incoming["credits"] is None:
            incoming["credits"] = existing.get("credits")
        buckets[index] = incoming
        break
    else:
        buckets.append(incoming)
    buckets.sort(key=lambda item: (item["id"] != "codex", item["id"]))
    merged["buckets"] = buckets
    if not merged.get("plan_type"):
        merged["plan_type"] = incoming.get("plan_type")
    return merged


class CodexAppServerClient:
    def __init__(self, executable: str, timeout_seconds: float):
        self.executable, self.timeout_seconds = executable, timeout_seconds
        self.process: asyncio.subprocess.Process | None = None

    async def connect(self) -> None:
        try:
            self.process = await asyncio.create_subprocess_exec(self.executable, "app-server", stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, env=codex_environment(self.executable))
        except FileNotFoundError as error:
            raise CodexCollectorError("codex_executable_not_found") from error
        except OSError as error:
            raise CodexCollectorError("codex_start_failed") from error
        await self._send({"method": "initialize", "id": 0, "params": {"clientInfo": {"name": "resource_deck", "title": "ResourceDeck", "version": "0.1.0"}}})
        await self._response(0)
        await self._send({"method": "initialized", "params": {}})

    async def read_rate_limits(self) -> dict[str, Any]:
        await self._send({"method": "account/rateLimits/read", "id": 1})
        result = await self._response(1)
        return parse_rate_limits_response(result)

    async def wait_for_rate_limit_update(self, timeout_seconds: float | None) -> Mapping[str, Any] | None:
        async def receive() -> Mapping[str, Any]:
            while True:
                message = await self._message()
                if message.get("method") != "account/rateLimits/updated":
                    continue
                params = message.get("params")
                update = params.get("rateLimits") if isinstance(params, Mapping) else None
                if not isinstance(update, Mapping):
                    raise CodexCollectorError("codex_malformed_response")
                return update

        try:
            return await asyncio.wait_for(receive(), timeout=timeout_seconds)
        except TimeoutError:
            return None

    async def rate_limit_updates(self):
        while True:
            update = await self.wait_for_rate_limit_update(None)
            if update is not None:
                yield update

    async def close(self) -> None:
        if not self.process:
            return
        if self.process.stdin:
            self.process.stdin.close()
        if self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=2)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
        self.process = None

    async def _send(self, message: Mapping[str, Any]) -> None:
        if not self.process or not self.process.stdin:
            raise CodexCollectorError("codex_process_ended")
        self.process.stdin.write(f"{json.dumps(message)}\n".encode())
        await self.process.stdin.drain()

    async def _response(self, identifier: int) -> Mapping[str, Any]:
        async def receive() -> Mapping[str, Any]:
            while True:
                message = await self._message()
                if message.get("id") != identifier:
                    continue
                if isinstance(message.get("result"), Mapping):
                    return message["result"]
                error_message = str(message.get("error", "")).lower()
                if "auth" in error_message or "login" in error_message or "unauthor" in error_message:
                    raise CodexCollectorError("codex_auth_required")
                raise CodexCollectorError("codex_request_failed")
        try:
            return await asyncio.wait_for(receive(), timeout=self.timeout_seconds)
        except TimeoutError as error:
            raise CodexCollectorError("codex_timeout") from error

    async def _message(self) -> Mapping[str, Any]:
        if not self.process or not self.process.stdout:
            raise CodexCollectorError("codex_process_ended")
        line = await self.process.stdout.readline()
        if not line:
            raise CodexCollectorError("codex_process_ended")
        try:
            message = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise CodexCollectorError("codex_malformed_response") from error
        if not isinstance(message, Mapping):
            raise CodexCollectorError("codex_malformed_response")
        return message


async def read_codex_rate_limits(executable: str, timeout_seconds: float) -> dict[str, Any]:
    client = CodexAppServerClient(executable, timeout_seconds)
    try:
        await client.connect()
        return await client.read_rate_limits()
    finally:
        await client.close()
