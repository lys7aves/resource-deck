import { useEffect, useState, type FormEvent } from "react";
import { addConfiguredServer, deleteConfiguredServer, getConfiguredServers, getProviders, getServers, setServerEnabled, subscribe, updateConfiguredServer } from "./api";
import { bytes, mib, percent } from "./format";
import type { CodexUsageBucket, CodexUsageWindow, ConfigServer, Container, GpuProcess, ProviderSnapshot, Server, User } from "./types";
import "./styles.css";
import "./codex.css";

function Bar({ value, label, className, marker }: { value?: number | null; label?: string; className?: string; marker?: number | null }) {
  const normalized = Number.isFinite(value) ? Math.max(0, Math.min(100, value ?? 0)) : 0;
  const normalizedMarker = Number.isFinite(marker) ? Math.max(0, Math.min(100, marker ?? 0)) : null;
  return <div className={`bar ${className ?? ""}`} role={label ? "progressbar" : undefined} aria-label={label} aria-valuemin={label ? 0 : undefined} aria-valuemax={label ? 100 : undefined} aria-valuenow={label ? normalized : undefined}><i style={{ width: `${normalized}%` }} />{normalizedMarker !== null && <b className="bar-marker" aria-hidden="true" style={{ left: `${normalizedMarker}%` }} />}</div>;
}

function UsageBreakdownBar({ used, mine, label, className }: { used?: number | null; mine?: number | null; label: string; className?: string }) {
  const total = Number.isFinite(used) ? Math.max(0, Math.min(100, used ?? 0)) : 0;
  const mineWidth = Number.isFinite(mine) ? Math.max(0, Math.min(total, mine ?? 0)) : 0;
  return <div className={`bar breakdown-bar ${className ?? ""}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={total}>
    <span className="bar-mine" aria-hidden="true" style={{ width: `${mineWidth}%` }} />
    <span className="bar-other" aria-hidden="true" style={{ width: `${total - mineWidth}%` }} />
  </div>;
}

function Metric({ name, value, sub }: { name: string; value: string; sub?: string }) {
  return <div className="metric"><span>{name}</span><strong>{value}</strong>{sub && <small>{sub}</small>}</div>;
}

function visibleUsers(users: User[], filteringEnabled: boolean): User[] {
  return filteringEnabled ? users.filter((user) => user.tracked) : users;
}

function MyUsage({ server }: { server: Server }) {
  const users = visibleUsers(server.users.value ?? [], server.tracked_users_configured);
  return <div className="mine"><span>Users</span><strong>{users.reduce((sum, user) => sum + user.estimated_cpu_cores, 0).toFixed(1)} cores</strong><small>{bytes(users.reduce((sum, user) => sum + user.memory_rss_bytes, 0))} RSS</small></div>;
}

function matchingContainer(process: GpuProcess, containers: Container[]): Container | undefined {
  return containers.find((item) => process.container_id && (item.id.startsWith(process.container_id) || process.container_id.startsWith(item.id)));
}

function myGpuMemoryMib(gpuUuid: string | null | undefined, processes: GpuProcess[], containers: Container[], trackedUsers: Set<string>): number {
  return processes
    .filter((process) => process.gpu_uuid === gpuUuid)
    .reduce((total, process) => {
      const container = matchingContainer(process, containers);
      const isMine = container
        ? !!container.owner.owner && trackedUsers.has(container.owner.owner)
        : !!process.username && trackedUsers.has(process.username);
      return total + (isMine ? process.memory_used_mib ?? 0 : 0);
    }, 0);
}

function resetLabel(timestamp: number, now: number, showDays: boolean) {
  const date = new Date(timestamp * 1000);
  const remaining = Math.max(0, date.getTime() - now);
  const days = Math.floor(remaining / 86_400_000);
  const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const countdown = showDays && days >= 1 ? `${days}d ${hours}h ${minutes}m left` : `${Math.floor(remaining / 3_600_000)}h ${minutes}m left`;
  return `${date.toLocaleString()} · ${countdown}`;
}

function paceGuidePercent(window: CodexUsageWindow, now: number) {
  const durationMs = window.window_duration_minutes * 60_000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  const startsAt = window.resets_at * 1000 - durationMs;
  return Math.max(0, Math.min(100, 100 * (now - startsAt) / durationMs));
}

function UsageWindow({ window, now }: { window: CodexUsageWindow; now: number }) {
  const isLongWindow = window.window_duration_minutes >= 1440;
  const name = isLongWindow ? "주간 사용 한도" : "5시간 사용 한도";
  const guide = paceGuidePercent(window, now);
  const used = Math.max(0, Math.min(100, window.used_percent));
  const remaining = Math.max(0, Math.min(100, window.remaining_percent));
  const pace = used <= guide ? ["on-pace", "On pace"] : used <= guide + 10 ? ["watch-pace", "Watch pace"] : ["using-fast", "Using fast"];
  return <div className="usage-window"><div><span>{name}</span><span className="usage-window-summary"><small className={`pace ${pace[0]}`}>{pace[1]}</small><strong>{Math.round(remaining)}% left</strong></span></div><Bar value={remaining} marker={100 - guide} label={`${name} remaining: ${Math.round(remaining)}% left; ${Math.round(100 - guide)}% recommended remaining by now`} /><small>Resets {resetLabel(window.resets_at, now, isLongWindow)}</small></div>;
}

function UsageBucket({ bucket, now }: { bucket: CodexUsageBucket; now: number }) {
  return <div className="usage-bucket"><h3>{bucket.name ?? bucket.id}</h3><div className="usage-windows">{bucket.windows.map((window) => <UsageWindow key={window.kind} window={window} now={now} />)}</div>{bucket.credits && <small>Credits: {bucket.credits.unlimited ? "unlimited" : bucket.credits.balance}</small>}</div>;
}

function ResetCredits({ count, credits, now }: { count: number; credits?: { expires_at: number | null }[] | null; now: number }) {
  const creditLabel = `reset credit${count === 1 ? "" : "s"}`;
  const label = `${count} ${creditLabel} available`;
  if (count < 1) return <small>{label}</small>;
  const expirations = credits?.map((credit) => credit.expires_at).filter((expiresAt): expiresAt is number => Number.isFinite(expiresAt)) ?? [];
  const earliestExpiration = expirations.length > 0 ? Math.min(...expirations) : null;
  return <span className="reset-credit-badge"><span><strong>{count}</strong> {creditLabel} available</span>{earliestExpiration !== null && <small>Earliest known expiry {resetLabel(earliestExpiration, now, true)}</small>}</span>;
}

function CodexUsage({ provider }: { provider?: ProviderSnapshot }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!provider) return null;
  const codex = provider.data.buckets?.find((bucket) => bucket.id === "codex");
  const otherBuckets = provider.data.buckets?.filter((bucket) => bucket.id !== "codex") ?? [];
  return <section className={`codex-usage ${provider.status}`}><header><div><p>LOCAL CODEX ACCOUNT</p><h2>Codex usage {provider.data.plan_type ? `· ${provider.data.plan_type}` : ""}</h2></div><span className={`status ${provider.status}`}>{provider.status}</span></header>{provider.status !== "ok" && <p className="usage-error">{provider.short_message ?? "Usage data is unavailable"}</p>}{codex && <UsageBucket bucket={codex} now={now} />}{otherBuckets.length > 0 && <details><summary>Additional limits ({otherBuckets.length})</summary>{otherBuckets.map((bucket) => <UsageBucket key={bucket.id} bucket={bucket} now={now} />)}</details>}<footer><small>Updated {new Date(provider.observed_at).toLocaleString()}</small>{provider.data.reset_credits_available !== null && provider.data.reset_credits_available !== undefined && <ResetCredits count={provider.data.reset_credits_available} credits={provider.data.reset_credits} now={now} />}</footer></section>;
}

function Card({ server, onOpen }: { server: Server; onOpen: () => void }) {
  const system = server.system.value;
  const gpus = server.gpus.value ?? [];
  const users = visibleUsers(server.users.value ?? [], server.tracked_users_configured);
  const trackedUsers = new Set(users.map((user) => user.username));
  const containers = server.containers.value ?? [];
  const processes = server.gpu_processes.value ?? [];
  const myCpuCores = users.reduce((sum, user) => sum + user.estimated_cpu_cores, 0);
  const myMemoryBytes = users.reduce((sum, user) => sum + user.memory_rss_bytes, 0);
  const cpuMinePercent = system?.logical_cores && system.logical_cores > 0 ? 100 * myCpuCores / system.logical_cores : null;
  const memory = system?.memory_total_bytes ? 100 * (system.memory_used_bytes ?? 0) / system.memory_total_bytes : null;
  const memoryMinePercent = system?.memory_total_bytes ? 100 * myMemoryBytes / system.memory_total_bytes : null;
  const gpuMemoryPercent = (used?: number | null, total?: number | null) => total && total > 0 && used != null ? 100 * used / total : null;
  return <button className="card" onClick={onOpen}>
    <header><h2>{server.display_name}</h2><span className={`status ${server.connection}`}>{server.connection}</span></header>
    <section className="card-metric"><Metric name="CPU" value={percent(system?.cpu_utilization_percent)} sub={system?.logical_cores ? `${system.logical_cores} cores · mine ${myCpuCores.toFixed(1)} cores` : undefined} /><UsageBreakdownBar used={system?.cpu_utilization_percent} mine={cpuMinePercent} label={`CPU usage: ${percent(system?.cpu_utilization_percent)} used; ${myCpuCores.toFixed(1)} cores mine`} /></section>
    <section className="card-metric"><Metric name="RAM" value={percent(memory)} sub={`${bytes(system?.memory_used_bytes)} / ${bytes(system?.memory_total_bytes)} · mine ${bytes(myMemoryBytes)} RSS estimate`} /><UsageBreakdownBar used={memory} mine={memoryMinePercent} label={`RAM usage: ${percent(memory)} used; ${bytes(myMemoryBytes)} RSS estimate mine`} /></section>
    <div className="gpus">{gpus.length === 0 ? <p>GPU {server.gpus.status}</p> : gpus.map((gpu) => {
      const mine = myGpuMemoryMib(gpu.uuid, processes, containers, trackedUsers);
      const used = gpuMemoryPercent(gpu.memory_used_mib, gpu.memory_total_mib);
      const minePercent = gpuMemoryPercent(mine, gpu.memory_total_mib);
      return <div className="gpu" key={gpu.index}><span>GPU{gpu.index} <em className={gpu.state}>{gpu.state}</em></span><b>{percent(gpu.utilization_percent)}</b><small>{mib(gpu.memory_used_mib)} / {mib(gpu.memory_total_mib && gpu.memory_total_mib > 0 ? gpu.memory_total_mib : null)} · mine {mib(mine)} VRAM</small><UsageBreakdownBar className="gpu-vram-bar" label={`GPU${gpu.index} VRAM allocation: ${mib(gpu.memory_used_mib)} used; ${mib(mine)} mine`} used={used} mine={minePercent} /></div>;
    })}</div>
    <footer className="card-footer"><MyUsage server={server} /><div className="docker"><span>Docker</span><strong>{server.containers.value?.length ?? "—"}</strong><small>containers</small></div></footer>
  </button>;
}

const mappingLabels: Record<string, string> = {
  proc_cgroup: "cgroup match · high confidence",
  init_pid_ppid_chain: "container init PID ancestry · medium confidence",
  docker_top: "docker top PID match · low confidence",
  unmapped: "no container evidence",
};

function GpuProcessRow({ process, containers }: { process: GpuProcess; containers: Container[] }) {
  const container = matchingContainer(process, containers);
  const mapping = mappingLabels[process.container_mapping_source] ?? process.container_mapping_source;
  return <p className="process-row">
    <b>PID {process.pid}</b>
    <span>{process.process_name ?? "unknown process"} · {mib(process.memory_used_mib)}</span>
    <small>{container ? `${container.name} · ${container.owner.owner ?? "unknown owner"}` : process.username ? `Host user · ${process.username}` : "Not mapped to a container"}</small>
    <em className={`confidence ${process.container_mapping_confidence}`}>{mapping}</em>
  </p>;
}

function Detail({ server, close }: { server: Server; close: () => void }) {
  const [showAllUsers, setShowAllUsers] = useState(false);
  const allUsers = server.users.value ?? [];
  const hasTrackedUsers = server.tracked_users_configured;
  const users = showAllUsers || !hasTrackedUsers ? allUsers : visibleUsers(allUsers, true);
  const hiddenCount = hasTrackedUsers ? allUsers.length - users.length : 0;
  const containers = server.containers.value ?? [];
  const processes = server.gpu_processes.value ?? [];
  return <main className="detail"><button className="back" onClick={close}>← All servers</button><h1>{server.display_name}</h1><p className="caption">Latest snapshot · {server.connection}</p><div className="detail-grid">
    <article><div className="section-heading"><h2>Users</h2>{hasTrackedUsers && <button className="toggle" onClick={() => setShowAllUsers((value) => !value)}>{showAllUsers ? "Tracked users" : `All users${hiddenCount ? ` (${hiddenCount} hidden)` : ""}`}</button>}</div>{users.length === 0 ? <p>No tracked users running</p> : users.map((user) => <p key={user.username}><b>{user.username}</b><span>{user.estimated_cpu_cores.toFixed(2)} cores · {bytes(user.memory_rss_bytes)}</span></p>)}</article>
    <article><h2>Docker</h2>{containers.length === 0 ? <p>No container data</p> : containers.map((container) => <p key={container.id}><b>{container.name}</b><span>{container.owner.owner ?? "unknown"} · {container.cpu_percent?.toFixed(1) ?? "—"}% CPU · {mib(container.gpu_memory_mib)} GPU VRAM</span></p>)}</article>
    <article className="gpu-processes"><h2>GPU process mapping</h2>{processes.length === 0 ? <p>No GPU process data</p> : processes.map((process) => <GpuProcessRow key={`${process.gpu_uuid ?? "gpu"}-${process.pid}`} process={process} containers={containers} />)}</article>
  </div></main>;
}

const blankConfig = (): ConfigServer => ({ id: "", enabled: true, display_name: "", ssh_host: "", ssh_user: "", ssh_port: 22, ssh_known_hosts: "~/.ssh/known_hosts", tracked_users: [], collectors: { gpu: "auto", docker: "auto" }, owner_hints: { compose_projects: {}, home_prefixes: {} } });

function ServerManagement({ close }: { close: () => void }) {
  const [items, setItems] = useState<ConfigServer[]>([]);
  const [editing, setEditing] = useState<ConfigServer | null>(null);
  const [tracked, setTracked] = useState("");
  const [compose, setCompose] = useState("{}");
  const [homes, setHomes] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { getConfiguredServers().then(setItems).catch((reason: Error) => setError(reason.message)); }, []);
  const begin = (item: ConfigServer) => { setEditing({ ...item }); setTracked(item.tracked_users.join(", ")); setCompose(JSON.stringify(item.owner_hints.compose_projects, null, 2)); setHomes(JSON.stringify(item.owner_hints.home_prefixes, null, 2)); setError(null); };
  const save = async (event: FormEvent) => { event.preventDefault(); if (!editing) return; setSaving(true); setError(null); try { const payload = { ...editing, tracked_users: tracked.split(",").map((value) => value.trim()).filter(Boolean), owner_hints: { compose_projects: JSON.parse(compose), home_prefixes: JSON.parse(homes) } }; const next = editing.id ? await updateConfiguredServer(payload) : await addConfiguredServer(payload); setItems(next); setEditing(null); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save server"); } finally { setSaving(false); } };
  const toggle = async (item: ConfigServer) => { try { setItems(await setServerEnabled(item.id, !item.enabled)); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update server"); } };
  const remove = async (item: ConfigServer) => { if (!window.confirm(`Delete ${item.display_name || item.id}?`)) return; try { setItems(await deleteConfiguredServer(item.id)); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not delete server"); } };
  return <main className="management"><button className="back" onClick={close}>← Dashboard</button><header className="management-header"><div><p className="caption">SERVER CONFIGURATION</p><h1>Manage servers</h1></div><button className="manage-button" onClick={() => begin(blankConfig())}>＋ Add server</button></header>{error && <p className="error">{error}</p>}<div className="server-list">{items.map((item) => <div className="server-row" key={item.id}><button className={`server-enabled ${item.enabled ? "on" : ""}`} aria-label={`${item.display_name || item.id} ${item.enabled ? "enabled" : "disabled"}`} onClick={() => toggle(item)}>{item.enabled ? "ON" : "OFF"}</button><div><strong>{item.display_name || item.id}</strong><small>{item.ssh_user ? `${item.ssh_user}@` : ""}{item.ssh_host}:{item.ssh_port}</small></div><button className="row-action" onClick={() => begin(item)}>Edit</button><button className="row-action danger" onClick={() => remove(item)}>Delete</button></div>)}</div>{editing && <form className="server-form" onSubmit={save}><div className="form-header"><h2>{editing.id ? "Edit server" : "Add server"}</h2><button type="button" className="row-action" onClick={() => setEditing(null)}>Cancel</button></div><label>ID<input required pattern="[A-Za-z0-9_-]+" disabled={!!items.find((item) => item.id === editing.id)} value={editing.id} onChange={(event) => setEditing({ ...editing, id: event.target.value })} /></label><label>Display name<input value={editing.display_name ?? ""} onChange={(event) => setEditing({ ...editing, display_name: event.target.value })} /></label><label>SSH host<input required value={editing.ssh_host} onChange={(event) => setEditing({ ...editing, ssh_host: event.target.value })} /></label><div className="form-grid"><label>SSH user<input value={editing.ssh_user ?? ""} onChange={(event) => setEditing({ ...editing, ssh_user: event.target.value })} /></label><label>SSH port<input type="number" min="1" max="65535" required value={editing.ssh_port} onChange={(event) => setEditing({ ...editing, ssh_port: Number(event.target.value) })} /></label></div><label>Known hosts path<input required value={editing.ssh_known_hosts} onChange={(event) => setEditing({ ...editing, ssh_known_hosts: event.target.value })} /></label><label>Tracked users <small>(comma separated)</small><input value={tracked} onChange={(event) => setTracked(event.target.value)} /></label><div className="form-grid"><label>GPU collector<select value={editing.collectors.gpu} onChange={(event) => setEditing({ ...editing, collectors: { ...editing.collectors, gpu: event.target.value } })}><option>auto</option><option>off</option></select></label><label>Docker collector<select value={editing.collectors.docker} onChange={(event) => setEditing({ ...editing, collectors: { ...editing.collectors, docker: event.target.value } })}><option>auto</option><option>off</option></select></label></div><label>Compose project owners <textarea value={compose} onChange={(event) => setCompose(event.target.value)} /></label><label>Home prefix owners <textarea value={homes} onChange={(event) => setHomes(event.target.value)} /></label><button className="save-button" disabled={saving}>{saving ? "Saving…" : "Save server"}</button></form>}</main>;
}

export default function App() {
  const [servers, setServers] = useState<Server[]>([]);
  const [providers, setProviders] = useState<ProviderSnapshot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [management, setManagement] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getServers().then(setServers).catch((reason: Error) => setError(reason.message)); getProviders().then(setProviders).catch((reason: Error) => setError(reason.message)); return subscribe(setServers, setProviders); }, []);
  const current = servers.find((server) => server.server_id === selected);
  if (management) return <ServerManagement close={() => setManagement(false)} />;
  if (current) return <Detail server={current} close={() => setSelected(null)} />;
  return <main><header className="masthead"><div><p>LIVE RESOURCE MONITOR</p><h1>ResourceDeck</h1></div><div className="masthead-actions"><span>{servers.length} active servers</span><button className="manage-button" onClick={() => setManagement(true)}>⚙ Manage servers</button></div></header>{error && <p className="error">{error}</p>}<CodexUsage provider={providers.find((provider) => provider.provider_id === "codex")} /><div className="grid">{servers.map((server) => <Card key={server.server_id} server={server} onOpen={() => setSelected(server.server_id)} />)}</div>{servers.length === 0 && <div className="empty">No active server snapshots. Open <button className="link-button" onClick={() => setManagement(true)}>Manage servers</button> to enable one.</div>}</main>;
}
