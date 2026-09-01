from __future__ import annotations

from .config import OwnerHints
from .models import OwnerAttribution


def attribute_owner(labels: dict[str, str], mounts: list[dict], name: str, hints: OwnerHints) -> OwnerAttribution:
    if owner := labels.get("resourcedeck.owner"):
        return OwnerAttribution(owner=owner, source="label", confidence="high")
    project = labels.get("com.docker.compose.project") or labels.get("resourcedeck.project")
    if project and project in hints.compose_projects:
        return OwnerAttribution(owner=hints.compose_projects[project], source="compose_project", confidence="high")
    for mount in mounts:
        for prefix, owner in hints.home_prefixes.items():
            if str(mount.get("Source", "")).startswith(prefix):
                return OwnerAttribution(owner=owner, source="mount_path", confidence="medium")
    for owner in set(hints.compose_projects.values()) | set(hints.home_prefixes.values()):
        if owner.lower() in name.lower(): return OwnerAttribution(owner=owner, source="name", confidence="low")
    return OwnerAttribution()
