from __future__ import annotations

import os
import tempfile
from pathlib import Path
from threading import Lock
from typing import Any

import yaml

try:
    from ruamel.yaml import YAML
except ImportError:  # development environments can still use the legacy writer
    YAML = None

from .config import ServerSettings, Settings


class ConfigStore:
    """Transactional server edits, retaining the rest of the YAML document."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.lock = Lock()

    def read(self) -> Settings:
        return Settings.model_validate(yaml.safe_load(self.path.read_text(encoding="utf-8")) or {}) if self.path.is_file() else Settings()

    def write_servers(self, servers: list[ServerSettings]) -> Settings:
        with self.lock:
            document: dict[str, Any] = {}
            if self.path.is_file():
                if YAML:
                    reader = YAML()
                    document = reader.load(self.path.read_text(encoding="utf-8")) or {}
                else:
                    document = yaml.safe_load(self.path.read_text(encoding="utf-8")) or {}
            document["servers"] = [server.model_dump(exclude_none=True) for server in servers]
            candidate = Settings.model_validate(document)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    if YAML:
                        writer = YAML()
                        writer.default_flow_style = False
                        writer.allow_unicode = True
                        writer.dump(document, handle)
                    else:
                        yaml.safe_dump(document, handle, sort_keys=False, allow_unicode=True)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            return candidate
