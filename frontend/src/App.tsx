import { useEffect, useState } from "react";
import { getProviders, getServers, subscribe } from "./api";
import { bytes, mib, percent } from "./format";
import type { CodexUsageBucket, CodexUsageWindow, Container, GpuProcess, ProviderSnapshot, Server, User } from "./types";
import "./styles.css";
import "./codex.css";

function Bar({ value }: { value?: number | null }) {
  return <div className="bar"><i style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} /></div>;
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

function resetLabel(timestamp: number) {
  const date = new Date(timestamp * 1000);
  const remaining = Math.max(0, date.getTime() - Date.now());
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return `${date.toLocaleString()} · ${hours}h ${minutes}m left`;
}

function UsageWindow({ window }: { window: CodexUsageWindow }) {
  return <div className="usage-window"><div><span>{window.window_duration_minutes >= 1440 ? "Long window" : "Short window"}</span><strong>{Math.round(window.remaining_percent)}% left</strong></div><Bar value={window.used_percent} /><small>Resets {resetLabel(window.resets_at)}</small></div>;
}

function UsageBucket({ bucket }: { bucket: CodexUsageBucket }) {
  return <div className="usage-bucket"><h3>{bucket.name ?? bucket.id}</h3><div className="usage-windows">{bucket.windows.map((window) => <UsageWindow key={window.kind} window={window} />)}</div>{bucket.credits && <small>Credits: {bucket.credits.unlimited ? "unlimited" : bucket.credits.balance}</small>}</div>;
}

function CodexUsage({ provider }: { provider?: ProviderSnapshot }) {
  if (!provider) return null;
  const codex = provider.data.buckets?.find((bucket) => bucket.id === "codex");
  const otherBuckets = provider.data.buckets?.filter((bucket) => bucket.id !== "codex") ?? [];
  return <section className={`codex-usage ${provider.status}`}><header><div><p>LOCAL CODEX ACCOUNT</p><h2>Codex usage {provider.data.plan_type ? `· ${provider.data.plan_type}` : ""}</h2></div><span className={`status ${provider.status}`}>{provider.status}</span></header>{provider.status !== "ok" && <p className="usage-error">{provider.short_message ?? "Usage data is unavailable"}</p>}{codex && <UsageBucket bucket={codex} />}{otherBuckets.length > 0 && <details><summary>Additional limits ({otherBuckets.length})</summary>{otherBuckets.map((bucket) => <UsageBucket key={bucket.id} bucket={bucket} />)}</details>}<footer><small>Updated {new Date(provider.observed_at).toLocaleString()}</small>{provider.data.reset_credits_available !== null && provider.data.reset_credits_available !== undefined && <small>{provider.data.reset_credits_available} reset credits available</small>}</footer></section>;
}

function Card({ server, onOpen }: { server: Server; onOpen: () => void }) {
  const system = server.system.value;
  const gpus = server.gpus.value ?? [];
  const memory = system?.memory_total_bytes ? 100 * (system.memory_used_bytes ?? 0) / system.memory_total_bytes : null;
  return <button className="card" onClick={onOpen}>
    <header><h2>{server.display_name}</h2><span className={`status ${server.connection}`}>{server.connection}</span></header>
    <section><Metric name="CPU" value={percent(system?.cpu_utilization_percent)} sub={system?.logical_cores ? `${system.logical_cores} cores · load ${system.load_average_1m ?? "—"}` : undefined} /><Bar value={system?.cpu_utilization_percent} /></section>
    <section><Metric name="RAM" value={percent(memory)} sub={`${bytes(system?.memory_used_bytes)} / ${bytes(system?.memory_total_bytes)}`} /><Bar value={memory} /></section>
    <div className="gpus">{gpus.length === 0 ? <p>GPU {server.gpus.status}</p> : gpus.map((gpu) => <div className="gpu" key={gpu.index}><span>GPU{gpu.index} <em className={gpu.state}>{gpu.state}</em></span><b>{percent(gpu.utilization_percent)}</b><small>{mib(gpu.memory_used_mib)} / {mib(gpu.memory_total_mib)}</small></div>)}</div>
    <footer><MyUsage server={server} /><div className="docker"><span>Docker</span><strong>{server.containers.value?.length ?? "—"}</strong><small>containers</small></div></footer>
  </button>;
}

const mappingLabels: Record<string, string> = {
  proc_cgroup: "cgroup match · high confidence",
  init_pid_ppid_chain: "container init PID ancestry · medium confidence",
  docker_top: "docker top PID match · low confidence",
  unmapped: "no container evidence",
};

function GpuProcessRow({ process, containers }: { process: GpuProcess; containers: Container[] }) {
  const container = containers.find((item) => process.container_id && (item.id.startsWith(process.container_id) || process.container_id.startsWith(item.id)));
  const mapping = mappingLabels[process.container_mapping_source] ?? process.container_mapping_source;
  return <p className="process-row">
    <b>PID {process.pid}</b>
    <span>{process.process_name ?? "unknown process"} · {mib(process.memory_used_mib)}</span>
    <small>{container ? `${container.name} · ${container.owner.owner ?? "unknown owner"}` : "Not mapped to a container"}</small>
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

export default function App() {
  const [servers, setServers] = useState<Server[]>([]);
  const [providers, setProviders] = useState<ProviderSnapshot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getServers().then(setServers).catch((reason: Error) => setError(reason.message)); getProviders().then(setProviders).catch((reason: Error) => setError(reason.message)); return subscribe(setServers, setProviders); }, []);
  const current = servers.find((server) => server.server_id === selected);
  if (current) return <Detail server={current} close={() => setSelected(null)} />;
  return <main><header className="masthead"><div><p>LIVE RESOURCE MONITOR</p><h1>ResourceDeck</h1></div><span>{servers.length} servers</span></header>{error && <p className="error">{error}</p>}<CodexUsage provider={providers.find((provider) => provider.provider_id === "codex")} /><div className="grid">{servers.map((server) => <Card key={server.server_id} server={server} onOpen={() => setSelected(server.server_id)} />)}</div>{servers.length === 0 && <div className="empty">No server snapshots yet. Add servers in <code>config/servers.yaml</code>.</div>}</main>;
}
