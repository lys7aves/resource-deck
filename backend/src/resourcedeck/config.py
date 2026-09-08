from __future__ import annotations

import ipaddress
from pathlib import Path

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator


class AppSettings(BaseModel):
    bind: str = "127.0.0.1"
    port: int = 8765

    @field_validator("bind")
    @classmethod
    def bind_must_be_loopback(cls, value: str) -> str:
        if value.lower() == "localhost":
            return "127.0.0.1"
        try:
            address = ipaddress.ip_address(value)
        except ValueError as error:
            raise ValueError("app.bind must be localhost or a loopback IP address") from error
        if not address.is_loopback:
            raise ValueError("app.bind must be localhost or a loopback IP address")
        return value


class PollingSettings(BaseModel):
    system_seconds: float = 3
    gpu_seconds: float = 3
    users_seconds: float = 5
    docker_seconds: float = 10
    command_timeout_seconds: float = 5
    connect_timeout_seconds: float = 10


class CodexProviderSettings(BaseModel):
    enabled: bool = False
    executable: str | None = None
    poll_seconds: float = Field(default=60, ge=1)
    reconnect_seconds: float = Field(default=15, ge=1)
    timeout_seconds: float = Field(default=15, ge=1, le=60)


class ProviderSettings(BaseModel):
    codex: CodexProviderSettings = Field(default_factory=CodexProviderSettings)


class CollectorSettings(BaseModel):
    gpu: str = "auto"
    docker: str = "auto"


class OwnerHints(BaseModel):
    compose_projects: dict[str, str] = Field(default_factory=dict)
    home_prefixes: dict[str, str] = Field(default_factory=dict)


class ServerSettings(BaseModel):
    id: str = Field(min_length=1, pattern=r"^[A-Za-z0-9_-]+$")
    enabled: bool = True
    display_name: str | None = None
    ssh_host: str = Field(min_length=1)
    ssh_user: str | None = None
    ssh_port: int = Field(default=22, ge=1, le=65535)
    # Host-key verification is always explicit; unknown hosts are never accepted.
    ssh_known_hosts: str = "~/.ssh/known_hosts"
    tracked_users: list[str] = Field(default_factory=list)
    collectors: CollectorSettings = Field(default_factory=CollectorSettings)
    owner_hints: OwnerHints = Field(default_factory=OwnerHints)


class Settings(BaseModel):
    app: AppSettings = Field(default_factory=AppSettings)
    polling: PollingSettings = Field(default_factory=PollingSettings)
    providers: ProviderSettings = Field(default_factory=ProviderSettings)
    servers: list[ServerSettings] = Field(default_factory=list)

    @model_validator(mode="after")
    def server_ids_are_unique(self) -> "Settings":
        ids = [server.id for server in self.servers]
        if len(ids) != len(set(ids)):
            raise ValueError("server IDs must be unique")
        return self


def load_settings(path: str | Path | None = None) -> Settings:
    if path is None or not Path(path).exists():
        return Settings()
    with Path(path).open("r", encoding="utf-8") as handle:
        return Settings.model_validate(yaml.safe_load(handle) or {})
