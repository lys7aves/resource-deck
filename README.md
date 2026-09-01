# ResourceDeck

Agentless SSH resource monitoring for a small group of Linux servers.

## Quick start

1. Copy `config/servers.example.yaml` to `config/servers.yaml` and add SSH host aliases already trusted in `~/.ssh/known_hosts`. ResourceDeck requires this file (or each server's explicit `ssh_known_hosts` path) and rejects unknown host keys.
2. Create a Python 3.12 virtual environment and install `pip install -e '.[dev]'`.
3. Run `resourcedeck`; open `http://127.0.0.1:8765` after building the frontend.

The app is read-only. It never sends Docker lifecycle, process-control, or server configuration commands.
