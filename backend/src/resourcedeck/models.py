from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, Field


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class MetricStatus(StrEnum):
    OK = "ok"
    STALE = "stale"
    UNAVAILABLE = "unavailable"
    ERROR = "error"
    WARMING_UP = "warming_up"


class ConnectionStatus(StrEnum):
    ONLINE = "online"
    DEGRADED = "degraded"
    OFFLINE = "offline"


T = TypeVar("T")


class MetricEnvelope(BaseModel, Generic[T]):
    status: MetricStatus
    observed_at: datetime = Field(default_factory=utcnow)
    value: T | None = None
    error_code: str | None = None
    short_message: str | None = None
    measurement_method: str | None = None


class SystemMetrics(BaseModel):
    cpu_utilization_percent: float | None = None
    logical_cores: int | None = None
    load_average_1m: float | None = None
    memory_used_bytes: int | None = None
    memory_total_bytes: int | None = None
    memory_available_bytes: int | None = None


class GpuProcess(BaseModel):
    gpu_uuid: str | None = None
    pid: int
    process_name: str | None = None
    memory_used_mib: int | None = None
    container_id: str | None = None
    container_mapping_source: str = "unmapped"
    container_mapping_confidence: str = "none"


class GpuMetrics(BaseModel):
    index: int
    uuid: str | None = None
    name: str | None = None
    utilization_percent: float | None = None
    memory_used_mib: float | None = None
    memory_total_mib: float | None = None
    temperature_c: float | None = None
    state: str = "unknown"


class UserMetrics(BaseModel):
    username: str
    estimated_cpu_cores: float = 0
    memory_rss_bytes: int = 0
    tracked: bool = False


class OwnerAttribution(BaseModel):
    owner: str | None = None
    source: str = "unknown"
    confidence: str = "none"


class ContainerMetrics(BaseModel):
    id: str
    name: str
    image: str | None = None
    status: str | None = None
    started_at: datetime | None = None
    init_pid: int | None = None
    mounts: list[dict[str, Any]] = Field(default_factory=list)
    compose_project: str | None = None
    owner: OwnerAttribution = Field(default_factory=OwnerAttribution)
    cpu_percent: float | None = None
    memory_used_bytes: int | None = None
    memory_limit_bytes: int | None = None
    gpu_memory_mib: float = 0
    gpu_process_count: int = 0


class Capabilities(BaseModel):
    system: MetricStatus = MetricStatus.UNAVAILABLE
    gpu: MetricStatus = MetricStatus.UNAVAILABLE
    docker: MetricStatus = MetricStatus.UNAVAILABLE
    users: MetricStatus = MetricStatus.UNAVAILABLE
    proc_visibility: str = "unknown"
    cgroup_version: str = "unknown"


class Diagnostics(BaseModel):
    collector_errors: dict[str, str] = Field(default_factory=dict)


class ServerSnapshot(BaseModel):
    schema_version: int = 2
    server_id: str
    display_name: str
    tracked_users_configured: bool = False
    revision: int = 0
    collected_at: datetime = Field(default_factory=utcnow)
    connection: ConnectionStatus = ConnectionStatus.OFFLINE
    capabilities: Capabilities = Field(default_factory=Capabilities)
    system: MetricEnvelope[SystemMetrics] = Field(default_factory=lambda: MetricEnvelope(status=MetricStatus.UNAVAILABLE))
    gpus: MetricEnvelope[list[GpuMetrics]] = Field(default_factory=lambda: MetricEnvelope(status=MetricStatus.UNAVAILABLE))
    gpu_processes: MetricEnvelope[list[GpuProcess]] = Field(default_factory=lambda: MetricEnvelope(status=MetricStatus.UNAVAILABLE))
    users: MetricEnvelope[list[UserMetrics]] = Field(default_factory=lambda: MetricEnvelope(status=MetricStatus.UNAVAILABLE))
    containers: MetricEnvelope[list[ContainerMetrics]] = Field(default_factory=lambda: MetricEnvelope(status=MetricStatus.UNAVAILABLE))
    diagnostics: Diagnostics = Field(default_factory=Diagnostics)


class ProviderSnapshot(BaseModel):
    provider_id: str
    status: MetricStatus
    observed_at: datetime = Field(default_factory=utcnow)
    data: dict[str, Any] = Field(default_factory=dict)
