import { useEffect, useState } from "react";
import { getServers, subscribe } from "./api";
import { bytes, mib, percent } from "./format";
import type { Container, Server } from "./types";
import "./styles.css";

function Bar({ value }: { value?: number | null }) { return <div className="bar"><i style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} /></div>; }
function Metric({ name, value, sub }: { name: string; value: string; sub?: string }) { return <div className="metric"><span>{name}</span><strong>{value}</strong>{sub && <small>{sub}</small>}</div>; }
function MyUsage({ server }: { server: Server }) {
  const users = server.users.value ?? [];
  return <div className="mine"><span>Users</span><strong>{users.reduce((sum, user) => sum + user.estimated_cpu_cores, 0).toFixed(1)} cores</strong><small>{bytes(users.reduce((sum, user) => sum + user.memory_rss_bytes, 0))} RSS</small></div>;
}
function Card({ server, onOpen }: { server: Server; onOpen: () => void }) {
  const system = server.system.value, gpus = server.gpus.value ?? [];
  const memory = system?.memory_total_bytes ? 100 * (system.memory_used_bytes ?? 0) / system.memory_total_bytes : null;
  return <button className="card" onClick={onOpen}>
    <header><h2>{server.display_name}</h2><span className={`status ${server.connection}`}>{server.connection}</span></header>
    <section><Metric name="CPU" value={percent(system?.cpu_utilization_percent)} sub={system?.logical_cores ? `${system.logical_cores} cores · load ${system.load_average_1m ?? "—"}` : undefined} /><Bar value={system?.cpu_utilization_percent} /></section>
    <section><Metric name="RAM" value={percent(memory)} sub={`${bytes(system?.memory_used_bytes)} / ${bytes(system?.memory_total_bytes)}`} /><Bar value={memory} /></section>
    <div className="gpus">{gpus.length === 0 ? <p>GPU {server.gpus.status}</p> : gpus.map(gpu => <div className="gpu" key={gpu.index}><span>GPU{gpu.index} <em className={gpu.state}>{gpu.state}</em></span><b>{percent(gpu.utilization_percent)}</b><small>{mib(gpu.memory_used_mib)} / {mib(gpu.memory_total_mib)}</small></div>)}</div>
    <footer><MyUsage server={server} /><div className="docker"><span>Docker</span><strong>{server.containers.value?.length ?? "—"}</strong><small>containers</small></div></footer>
  </button>;
}
function Detail({ server, close }: { server: Server; close: () => void }) {
  const containers: Container[] = server.containers.value ?? [];
  return <main className="detail"><button className="back" onClick={close}>← All servers</button><h1>{server.display_name}</h1><p className="caption">Latest snapshot · {server.connection}</p><div className="detail-grid"><article><h2>Users</h2>{(server.users.value ?? []).map(user => <p key={user.username}><b>{user.username}</b><span>{user.estimated_cpu_cores.toFixed(2)} cores · {bytes(user.memory_rss_bytes)}</span></p>)}</article><article><h2>Docker</h2>{containers.length === 0 ? <p>No container data</p> : containers.map(container => <p key={container.id}><b>{container.name}</b><span>{container.owner.owner ?? "unknown"} · {container.cpu_percent?.toFixed(1) ?? "—"}% CPU · {mib(container.gpu_memory_mib)} GPU VRAM</span></p>)}</article></div></main>;
}
export default function App() {
  const [servers, setServers] = useState<Server[]>([]), [selected, setSelected] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => { getServers().then(setServers).catch(error => setError(error.message)); return subscribe(setServers); }, []);
  const current = servers.find(server => server.server_id === selected);
  if (current) return <Detail server={current} close={() => setSelected(null)} />;
  return <main><header className="masthead"><div><p>LIVE RESOURCE MONITOR</p><h1>ResourceDeck</h1></div><span>{servers.length} servers</span></header>{error && <p className="error">{error}</p>}<div className="grid">{servers.map(server => <Card key={server.server_id} server={server} onOpen={() => setSelected(server.server_id)} />)}</div>{servers.length === 0 && <div className="empty">No snapshots yet. Add servers in <code>config/servers.yaml</code>.</div>}</main>;
}
