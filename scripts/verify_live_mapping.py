#!/usr/bin/env python3
"""Verify ResourceDeck GPU PID-to-container attribution from its live API."""

from __future__ import annotations

import argparse
import json
import sys
from urllib.request import urlopen


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    parser.add_argument("--server")
    args = parser.parse_args()
    with urlopen(f"{args.url.rstrip("/")}/api/v1/servers", timeout=10) as response:
        servers = json.load(response)

    matches = 0
    for server in servers:
        if args.server and server["server_id"] != args.server:
            continue
        containers = {item["id"]: item for item in server["containers"].get("value") or []}
        for process in server["gpu_processes"].get("value") or []:
            container_id = process.get("container_id")
            if not container_id:
                continue
            container = next((item for identifier, item in containers.items() if identifier.startswith(container_id) or container_id.startswith(identifier)), None)
            if not container:
                continue
            owner = container["owner"].get("owner") or "unknown"
            print("{}: PID {} -> {} -> {} ({}/{})".format(server["server_id"], process["pid"], container["name"], owner, process["container_mapping_source"], process["container_mapping_confidence"]))
            matches += 1
    if matches:
        return 0
    print("No live GPU PID-to-container mappings found. Run this while a GPU workload is running inside a Docker container.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
