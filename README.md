# ResourceDeck

[한국어 문서](README.ko.md)

ResourceDeck is a local, read-only dashboard for monitoring a small group of Linux servers over SSH. It shows system, GPU, user, Docker, and GPU-process attribution data without installing an agent on the monitored servers.

It never sends commands which change a Docker lifecycle, control processes, or change remote configuration. The dashboard is local-only: it accepts only `localhost` or loopback IP bind addresses, validates local browser requests, and does not store SSH passwords or private keys.

## Requirements

- Python 3.12 or later
- Node.js 18 or later to build the frontend
- An SSH account on every monitored Linux server
- For Windows sign-in autostart: WSL 2 with systemd enabled and Windows PowerShell

## 1. Prepare server access

### Create the configuration file

```bash
cp config/servers.example.yaml config/servers.yaml
```

### Register an SSH key

Run these commands in the WSL/Linux account that will run ResourceDeck. If you already have a suitable key, keep using it.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C "resourcedeck"
```

Before accepting a new host key, compare the fingerprint shown by SSH with a fingerprint obtained from the server console or a trusted administrator. Once it matches, accept it; SSH records it in `~/.ssh/known_hosts`.

```bash
ssh -o StrictHostKeyChecking=ask remote-user@server.example true
```

Then register the public key for the remote account. `ssh-copy-id` may ask for the remote account password once.

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub remote-user@server.example
```

If `ssh-copy-id` is unavailable, use this equivalent command after verifying the host key as above:

```bash
cat ~/.ssh/id_ed25519.pub | ssh remote-user@server.example 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys'
```

The remote account needs permission to create and update its own `~/.ssh/authorized_keys`. Do not bypass host-key verification with `StrictHostKeyChecking=no` or an unverified `ssh-keyscan` result.

### Test the connection

Use the same host name or SSH alias that you will put in `ssh_host`.

```bash
ssh remote-user@server.example
```

The connection should succeed without asking for the remote account password. If the private key has a passphrase, make it available through an SSH agent. ResourceDeck requires a trusted `known_hosts` file; the default is `~/.ssh/known_hosts`.

### Add the server to the configuration

Set the host, account, and tracked users in `config/servers.yaml`.

```yaml
app:
  bind: 127.0.0.1
  port: 8765

servers:
  - id: server-a
    enabled: true
    display_name: Server A
    ssh_host: server.example
    ssh_user: remote-user
    ssh_known_hosts: ~/.ssh/known_hosts
    tracked_users: [remote-user]
    collectors:
      gpu: auto
      docker: auto
```

- `enabled: false` keeps the server in the configuration but stops polling and hides it from the dashboard.
- `tracked_users` is the default user list in the server detail view. Leave it empty to show all users by default.
- Set a collector to `off` when the server does not provide GPU or Docker data.

## 2. Install and start

Create the Python environment, install ResourceDeck, build the frontend, then start the app.

```bash
python3.12 -m venv .venv
.venv/bin/pip install -e ".[dev]"

cd frontend
npm install
npm run build
cd ..

.venv/bin/resourcedeck
```

Open <http://127.0.0.1:8765>. Stop this foreground process with `Ctrl+C`.

## 3. Run manually as a service

Install a systemd user service in manual mode. The installer uses the absolute paths of this checkout, `.venv`, and `config/servers.yaml`.

```bash
./deploy/service.sh install --manual
./deploy/service.sh start
./deploy/service.sh status
./deploy/service.sh stop
```

Manual mode does not start ResourceDeck at Windows sign-in or on its own after WSL starts.

## 4. Start automatically after Windows sign-in

On WSL 2 with systemd enabled, install autostart after completing the installation and configuration above.

```bash
./deploy/service.sh install --autostart
```

This enables and starts the systemd user service, enables user lingering, and creates a Windows Scheduled Task for the current WSL distribution. The task starts WSL only after the current Windows user signs in; it neither stores a Windows password nor runs before sign-in.

To stop automatic execution but keep the service available for manual starts:

```bash
./deploy/service.sh disable-autostart
```

To remove the generated systemd unit and Windows Scheduled Task:

```bash
./deploy/service.sh uninstall
```

Uninstall intentionally leaves user lingering enabled because another user service may need it. Disable it only after confirming that it is unused:

```bash
loginctl disable-linger $USER
```

## 5. Change configuration

ResourceDeck checks `config/servers.yaml` about once per second. Valid changes to servers, polling intervals, collectors, tracked users, owner hints, and the optional Codex provider apply without restarting the service. Invalid changes keep the last valid configuration active.

Changing `app.bind` or `app.port` requires a service restart because the running server is already bound to its current address and port. `app.bind` must be `localhost` or a loopback IP address such as `127.0.0.1` or `::1`; external, wildcard, and LAN addresses are rejected.

The dashboard's **Manage servers** page can add, edit, delete, reorder, and enable or disable servers from the local machine. Drag a server by its handle (or use the up/down controls) to persist its card position in the same configuration file; the dashboard cards can be reordered with their drag handles too. It never stores SSH credentials.

## Optional: Codex usage and GPU attribution

To show remaining usage for the locally signed-in Codex account, add the following. Use the absolute path returned by `command -v codex`.

```yaml
providers:
  codex:
    enabled: true
    executable: /absolute/path/to/codex
    poll_seconds: 60
    reconnect_seconds: 15
    timeout_seconds: 15
```

ResourceDeck only reads usage data; it never signs in, purchases credits, or consumes resets. The dashboard only accepts local connections, including when Codex usage is enabled.

The server detail view can show GPU PID-to-container-to-owner attribution. It displays the evidence confidence and never exposes raw cgroup contents.

### Docker containers and user metrics

The Docker collector shows every running container visible through the SSH account's **default Docker daemon**, regardless of owner. It does not collect separate Docker contexts or rootless Docker daemons owned by other users. The detail view reads `docker events` for create/start/restart/stop/kill/die/destroy activity and retains the latest 24 hours (up to 10,000 events) only in memory. Restarting the app clears that history.

The server-card RAM value is total system memory in use (`MemTotal - MemAvailable`) from `/proc/meminfo`. The `Tracked users` or `All process users` RSS estimate is a sum of each process's RSS; shared memory can be counted more than once, so it does not necessarily equal system RAM. `core eq.` is likewise an instantaneous sum of process `%CPU` estimates.

## Troubleshooting

Use these commands first:

```bash
systemctl --user is-active resourcedeck.service
journalctl --user -u resourcedeck.service -f
curl http://127.0.0.1:8765/healthz
```

| Symptom | Check and resolution |
| --- | --- |
| The dashboard does not open or the service is inactive | Run `./deploy/service.sh status`, then `./deploy/service.sh start`. Follow the service log for startup errors. If you run it in the foreground, start `.venv/bin/resourcedeck` and keep that terminal open. |
| `config_file_missing` or a configuration reload error appears in `/healthz` | Confirm that `config/servers.yaml` exists and is valid YAML. A malformed change does not replace the currently active configuration; correct the file and wait about one second. |
| A server is Offline, Degraded, or has no snapshot | From the ResourceDeck machine, run `ssh` with the exact configured `ssh_host`, user, and key. Confirm the target account, network access, `ssh_known_hosts` path, and that the host key matches the trusted fingerprint. Check the dashboard or log for collector-specific errors. |
| A changed bind address or port has no effect | Restart the running app or execute `./deploy/service.sh stop` followed by `./deploy/service.sh start`. Only `app.bind` and `app.port` require this restart. |
| The app rejects a bind address | Use `localhost`, `127.0.0.1`, or `::1`. ResourceDeck does not support wildcard, LAN, or external bind addresses. |
| Codex usage is unavailable | Confirm that `providers.codex.enabled` is true, `executable` is an absolute existing path, and the local Codex account is signed in. The dashboard reports unavailable usage while it retries the connection. |
| Autostart does not run after Windows sign-in | Confirm WSL systemd is enabled, rerun `./deploy/service.sh install --autostart`, and check that the Windows Scheduled Task named `ResourceDeck-<WSL distribution>` exists. |
