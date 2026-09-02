# ResourceDeck

[한국어 문서](README.ko.md)

ResourceDeck is an agentless, read-only resource dashboard for a small group of Linux servers. It collects system, GPU, user, Docker, and GPU-process attribution data over SSH. It never sends Docker lifecycle, process-control, or remote configuration commands.

## Features

- Live server snapshots delivered through Server-Sent Events.
- Automatic reload of `config/servers.yaml` for server definitions, polling intervals, collectors, `tracked_users`, and owner hints. Invalid configurations keep the last valid configuration active.
- Default tracked-user view with an All users toggle.
- GPU PID-to-container-to-owner evidence in the server detail view.
- Read-only live verification command for GPU Docker attribution.

## Requirements

- Python 3.12 or later.
- SSH aliases with trusted host keys in `$HOME/.ssh/known_hosts`, or an explicit `ssh_known_hosts` path per server.
- Node.js 18 or later for the frontend build and tests.
- Optional: WSL 2 with systemd and Windows PowerShell for Windows sign-in autostart.

## Quick start

1. Create the local server configuration.

   ```bash
   cp config/servers.example.yaml config/servers.yaml
   ```

2. Set the SSH hosts, users, tracked users, collectors, and owner hints. `tracked_users` is the default Users view; if it is empty, all users are shown by default.

3. Create a virtual environment and install the backend.

   ```bash
   python3.12 -m venv .venv
   .venv/bin/pip install -e ".[dev]"
   ```

4. Build the frontend and start the application.

   ```bash
   cd frontend
   npm install
   npm run build
   cd ..
   .venv/bin/resourcedeck
   ```

Open <http://127.0.0.1:8765>.

## Configuration reload and diagnostics

`config/servers.yaml` is checked approximately once per second. Valid changes are applied without restarting the API process. A server added or changed in the file receives a new poller; a removed server is removed from the snapshot stream.

`app.bind` and `app.port` require a service restart because Uvicorn is already bound to the current address and port. Check reload status at:

```bash
curl http://127.0.0.1:8765/healthz
```

The response includes the last successful reload time, any reload error, and fields that require a restart.

## Codex usage

To show the remaining allowance for the locally signed-in Codex account at the top of the dashboard, add the following to `config/servers.yaml`. Set `executable` to the absolute path returned by `command -v codex`.

```yaml
providers:
  codex:
    enabled: true
    executable: /absolute/path/to/codex
    poll_seconds: 60
    reconnect_seconds: 15
    timeout_seconds: 15
```

The collector keeps an App Server connection open and applies rate-limit change notifications immediately. `poll_seconds` (default: 60) is a fallback read interval when no notification arrives; `reconnect_seconds` controls retry delay after a disconnect. It never logs in, buys credits, or consumes a reset. Codex usage may be shared with ChatGPT Work and other eligible agentic features. Keeping the default `127.0.0.1` bind is important: exposing the dashboard also exposes this usage data.

## Users and GPU attribution

The server detail view starts with `tracked_users` only. Select **All users** to show system and untracked accounts. When no tracked user is currently running, the default list is intentionally empty rather than falling back to system accounts.

GPU process attribution is displayed with its confidence and source:

| Source | Meaning | Confidence |
| --- | --- | --- |
| `proc_cgroup` | Container ID found in the GPU process cgroup | High |
| `init_pid_ppid_chain` | GPU PID ancestry reaches a container init PID | Medium |
| `docker_top` | GPU PID appears in `docker top` | Low |
| `unmapped` | No container evidence was available | None |

Raw cgroup contents are never exposed in the UI.

## Service installation and autostart

`deploy/service.sh` creates a user unit using the absolute path of the current checkout and virtual environment. The default is manual mode, which is appropriate for a shared checkout.

```bash
./deploy/service.sh install --manual
./deploy/service.sh start
./deploy/service.sh status
./deploy/service.sh stop
```

Optional autostart enables the user unit, enables linger, and registers a Windows Scheduled Task for the active WSL distribution. The task starts WSL after the current Windows user signs in; it does not store a Windows password and does not run before sign-in.

```bash
./deploy/service.sh install --autostart
```

To stop automatic execution while retaining the unit for manual starts:

```bash
./deploy/service.sh disable-autostart
```

To remove the generated unit and Windows task:

```bash
./deploy/service.sh uninstall
```

The uninstall command intentionally leaves linger enabled because other user services might use it. After checking that it is safe, disable it separately:

```bash
loginctl disable-linger $USER
```

Useful service diagnostics:

```bash
systemctl --user is-active resourcedeck.service
journalctl --user -u resourcedeck.service -f
curl http://127.0.0.1:8765/healthz
```

## Verification

```bash
.venv/bin/pytest -q -s
cd frontend && npm test && npm run build && npm audit --audit-level=moderate
```

To verify live GPU PID-to-container-to-owner attribution, run the following while a GPU workload is running inside a Docker container:

```bash
./scripts/verify_live_mapping.py
```

It returns exit code 2 when no live mapping exists. It does not start containers or workloads.
