import { useEffect, useState, type FormEvent } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { addConfiguredServer, deleteConfiguredServer, getConfiguredServers, getProviders, getServers, reorderConfiguredServer, setServerEnabled, subscribe, updateConfiguredServer } from "./api";
import { bytes, mib, percent } from "./format";
import type { CodexUsageBucket, CodexUsageWindow, ConfigServer, Container, ContainerEvent, GpuProcess, ProviderSnapshot, Server, User } from "./types";
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
  const label = server.tracked_users_configured ? "Tracked users" : "All process users";
  return <div className="mine"><span>{label}</span><strong>{users.reduce((sum, user) => sum + user.estimated_cpu_cores, 0).toFixed(1)} core eq.</strong><small>{bytes(users.reduce((sum, user) => sum + user.memory_rss_bytes, 0))} RSS estimate</small></div>;
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
  const hasTrackedUsers = server.tracked_users_configured;
  const containers = server.containers.value ?? [];
  const processes = server.gpu_processes.value ?? [];
  const myCpuCores = users.reduce((sum, user) => sum + user.estimated_cpu_cores, 0);
  const myMemoryBytes = users.reduce((sum, user) => sum + user.memory_rss_bytes, 0);
  const cpuMinePercent = hasTrackedUsers && system?.logical_cores && system.logical_cores > 0 ? 100 * myCpuCores / system.logical_cores : null;
  const memory = system?.memory_total_bytes ? 100 * (system.memory_used_bytes ?? 0) / system.memory_total_bytes : null;
  const memoryMinePercent = hasTrackedUsers && system?.memory_total_bytes ? 100 * myMemoryBytes / system.memory_total_bytes : null;
  const gpuMemoryPercent = (used?: number | null, total?: number | null) => total && total > 0 && used != null ? 100 * used / total : null;
  return <button className="card" onClick={onOpen}>
    <header><h2>{server.display_name}</h2><span className={`status ${server.connection}`}>{server.connection}</span></header>
    <section className="card-metric"><Metric name="CPU" value={percent(system?.cpu_utilization_percent)} sub={system?.logical_cores ? `${system.logical_cores} cores${hasTrackedUsers ? ` · tracked users ${myCpuCores.toFixed(1)} core eq. estimate` : ""}` : undefined} /><UsageBreakdownBar used={system?.cpu_utilization_percent} mine={cpuMinePercent} label={`CPU usage: ${percent(system?.cpu_utilization_percent)} used${hasTrackedUsers ? `; ${myCpuCores.toFixed(1)} core equivalent estimate for tracked users` : "; no tracked-user allocation"}`} /></section>
    <section className="card-metric"><Metric name="RAM" value={percent(memory)} sub={`${bytes(system?.memory_used_bytes)} / ${bytes(system?.memory_total_bytes)}${hasTrackedUsers ? ` · tracked users ${bytes(myMemoryBytes)} RSS estimate` : ""}`} /><UsageBreakdownBar used={memory} mine={memoryMinePercent} label={`RAM usage: ${percent(memory)} used${hasTrackedUsers ? `; ${bytes(myMemoryBytes)} RSS estimate for tracked users` : "; no tracked-user allocation"}`} /></section>
    <div className="gpus">{gpus.length === 0 ? <p>GPU {server.gpus.status}</p> : gpus.map((gpu) => {
      const mine = hasTrackedUsers ? myGpuMemoryMib(gpu.uuid, processes, containers, trackedUsers) : 0;
      const used = gpuMemoryPercent(gpu.memory_used_mib, gpu.memory_total_mib);
      const minePercent = gpuMemoryPercent(mine, gpu.memory_total_mib);
      return <div className="gpu" key={gpu.index}><span>GPU{gpu.index} <em className={gpu.state}>{gpu.state}</em></span><b>{percent(gpu.utilization_percent)}</b><small>{mib(gpu.memory_used_mib)} / {mib(gpu.memory_total_mib && gpu.memory_total_mib > 0 ? gpu.memory_total_mib : null)}{hasTrackedUsers ? ` · tracked ${mib(mine)} VRAM` : ""}</small><UsageBreakdownBar className="gpu-vram-bar" label={`GPU${gpu.index} VRAM allocation: ${mib(gpu.memory_used_mib)} used${hasTrackedUsers ? `; ${mib(mine)} for tracked users` : ""}`} used={used} mine={minePercent} /></div>;
    })}</div>
    <footer className="card-footer"><MyUsage server={server} /><div className="docker"><span>Docker</span><strong>{server.containers.value?.length ?? "—"} running</strong><small>{server.container_events.value ? `${server.container_events.value.length} recent events` : `activity ${server.container_events.status}`}</small></div></footer>
  </button>;
}

function moveRelative<T extends { id: string }>(items: T[], sourceId: string, targetId: string, position: "before" | "after"): T[] {
  if (sourceId === targetId) return items;
  const source = items.find((item) => item.id === sourceId);
  const target = items.find((item) => item.id === targetId);
  if (!source || !target) return items;
  const remaining = items.filter((item) => item.id !== sourceId);
  const targetIndex = remaining.findIndex((item) => item.id === targetId);
  remaining.splice(targetIndex + (position === "after" ? 1 : 0), 0, source);
  return remaining;
}

function SortableCard({ server, onOpen, disabled }: { server: Server; onOpen: () => void; disabled: boolean }) {
  const sortable = useSortable({ id: server.server_id, disabled });
  return <div ref={sortable.setNodeRef} className={`card-wrapper${sortable.isDragging ? " dragging" : ""}`} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}>
    <button className="drag-handle card-drag-handle" aria-label="카드 순서 변경" disabled={disabled} {...sortable.attributes} {...sortable.listeners}>⠿</button>
    <Card server={server} onOpen={onOpen} />
  </div>;
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

function knownUsage(value?: number | null): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

function serverShare(used?: number | null, total?: number | null): number | null {
  return knownUsage(used) && knownUsage(total) && total > 0 ? 100 * used / total : null;
}

type ContainerCapacity = { cores: number | null; memoryBytes: number | null; gpuMemoryMib: number | null };

function containerCapacity(server: Server): ContainerCapacity {
  const system = server.system.value;
  const gpus = server.gpus.value;
  const gpuMemoryMib = gpus && gpus.length > 0 && gpus.every((gpu) => knownUsage(gpu.memory_total_mib) && gpu.memory_total_mib > 0)
    ? gpus.reduce((sum, gpu) => sum + gpu.memory_total_mib!, 0) : null;
  return {
    cores: knownUsage(system?.logical_cores) && system.logical_cores > 0 ? system.logical_cores : null,
    memoryBytes: knownUsage(system?.memory_total_bytes) && system.memory_total_bytes > 0 ? system.memory_total_bytes : null,
    gpuMemoryMib,
  };
}

function ContainerResource({ name, containerName, value, sub, share, color }: { name: string; containerName: string; value: string; sub?: string; share: number | null; color: string }) {
  return <div className={`container-resource ${color}`}>
    <span className="resource-name">{name}</span><strong>{value}</strong>
    {sub && <small>{sub}</small>}
    {share !== null && <><Bar value={share} label={`${containerName} ${name}: ${share.toFixed(1)}% of server capacity`} /><small>{share.toFixed(1)}% of server capacity</small></>}
  </div>;
}

function ContainerCompactMetric({ containerName, label, value, share, color }: { containerName: string; label: string; value: string; share: number | null; color: string }) {
  return <span className={`container-compact-metric ${color}`}>
    <span className="container-compact-label">{label}</span><strong>{value}</strong>
    {share !== null && <Bar value={share} label={`${containerName} ${label}: ${share.toFixed(1)}% of server capacity`} />}
  </span>;
}

function ContainerUsageRow({ container, capacity }: { container: Container; capacity: ContainerCapacity }) {
  const cpu = knownUsage(container.cpu_percent) ? container.cpu_percent : null;
  const memory = knownUsage(container.memory_used_bytes) ? container.memory_used_bytes : null;
  const vram = knownUsage(container.gpu_memory_mib) ? container.gpu_memory_mib : null;
  const cpuCores = cpu === null ? null : cpu / 100;
  const cpuShare = serverShare(cpuCores, capacity.cores);
  const ramShare = serverShare(memory, capacity.memoryBytes);
  const gpuShare = serverShare(vram, capacity.gpuMemoryMib);
  const owner = container.owner.owner ?? "unknown owner";
  const name = container.name;
  return <details className="container-usage-row" aria-label={`Container ${name}`}>
    <summary className="container-usage-summary">
      <span className="container-summary-identity" title={`${name} · ${owner}`}><strong title={name}>{name}</strong><span className="container-owner" title={owner}>{owner}</span></span>
      <ContainerCompactMetric containerName={name} label="CPU" value={cpuCores === null ? "—" : `${cpuCores.toFixed(2)}코어`} share={cpuShare} color="container-cpu" />
      <ContainerCompactMetric containerName={name} label="RAM" value={bytes(memory)} share={ramShare} color="container-ram" />
      <ContainerCompactMetric containerName={name} label="GPU VRAM" value={mib(vram)} share={gpuShare} color="container-vram" />
    </summary>
    <div className="container-usage-expanded">
      <div className="container-expanded-metadata"><strong title={name}>{name}</strong><span className="container-owner">{owner}</span><span className="container-image" title={container.image ?? "unknown image"}>{container.image ?? "unknown image"}</span></div>
      <div className="container-resources">
        <ContainerResource name="CPU" containerName={name} color="container-cpu" value={cpu === null ? "—" : `${cpu.toFixed(1)}%`} sub={cpuCores === null ? undefined : `약 ${cpuCores.toFixed(2)}코어 사용${capacity.cores === null ? "" : ` / ${capacity.cores} server cores`}`} share={cpuShare} />
        <ContainerResource name="RAM" containerName={name} color="container-ram" value={bytes(memory)} sub={memory !== null && capacity.memoryBytes !== null ? `/ ${bytes(capacity.memoryBytes)} server RAM` : undefined} share={ramShare} />
        <ContainerResource name="GPU VRAM" containerName={name} color="container-vram" value={mib(vram)} sub={vram !== null && capacity.gpuMemoryMib !== null ? `/ ${mib(capacity.gpuMemoryMib)} server GPU VRAM` : undefined} share={gpuShare} />
      </div>
    </div>
  </details>;
}

function eventSummary(event: ContainerEvent): string {
  const target = event.name ?? event.container_id.slice(0, 12);
  const image = event.image ? ` · ${event.image}` : "";
  const owner = event.owner ? ` · ${event.owner}` : "";
  const exit = event.exit_code !== null && event.exit_code !== undefined ? ` · exit ${event.exit_code}` : "";
  return `${target}${image}${owner}${exit}`;
}

function Detail({ server, close }: { server: Server; close: () => void }) {
  const [showAllUsers, setShowAllUsers] = useState(false);
  const allUsers = server.users.value ?? [];
  const hasTrackedUsers = server.tracked_users_configured;
  const users = showAllUsers || !hasTrackedUsers ? allUsers : visibleUsers(allUsers, true);
  const hiddenCount = hasTrackedUsers ? allUsers.length - users.length : 0;
  const people = users.filter((user) => !user.is_system);
  const systemUsers = users.filter((user) => user.is_system);
  const containers = server.containers.value ?? [];
  const containerCapacities = containerCapacity(server);
  const containerEvents = server.container_events.value ?? [];
  const processes = server.gpu_processes.value ?? [];
  return <main className="detail"><button className="back" onClick={close}>← All servers</button><h1>{server.display_name}</h1><p className="caption">Latest snapshot · {server.connection}</p><div className="detail-grid">
    <article className="users"><div className="section-heading"><h2>Users</h2>{hasTrackedUsers && <button className="toggle" onClick={() => setShowAllUsers((value) => !value)}>{showAllUsers ? "Tracked users" : `All users${hiddenCount ? ` (${hiddenCount} hidden)` : ""}`}</button>}</div>{people.length === 0 ? <p>{hasTrackedUsers ? "No tracked users running" : "No non-system users running"}</p> : people.map((user) => <p key={user.username}><b>{user.username}</b><span>{user.estimated_cpu_cores.toFixed(2)} cores · {bytes(user.memory_rss_bytes)}</span></p>)}{systemUsers.length > 0 && <details className="system-users"><summary>System accounts ({systemUsers.length})</summary>{systemUsers.map((user) => <p key={user.username}><b>{user.username}</b><span>{user.estimated_cpu_cores.toFixed(2)} cores · {bytes(user.memory_rss_bytes)}</span></p>)}</details>}</article>
    <article className="running-containers"><header className="container-section-heading"><div><h2>Running containers</h2><small>{server.containers.value === null ? "—" : containers.length} running</small></div><div className="container-capacity-summary"><span>CPU<strong>{containerCapacities.cores === null ? "—" : `${containerCapacities.cores} cores`}</strong></span><span>RAM<strong>{bytes(containerCapacities.memoryBytes)}</strong></span><span>GPU VRAM<strong>{mib(containerCapacities.gpuMemoryMib)}</strong></span></div></header>{server.containers.value === null ? <p>Container data unavailable</p> : containers.length === 0 ? <p>No running containers</p> : <div className="container-list"><div className="container-list-heading"><span>Container</span><span>CPU</span><span>RAM</span><span>GPU VRAM</span></div>{containers.map((container) => <ContainerUsageRow key={container.id} container={container} capacity={containerCapacities} />)}</div>}</article>
    <article className="gpu-processes"><h2>GPU process mapping</h2>{processes.length === 0 ? <p>No GPU process data</p> : processes.map((process) => <GpuProcessRow key={`${process.gpu_uuid ?? "gpu"}-${process.pid}`} process={process} containers={containers} />)}</article>
    <article className="container-events"><h2>Recent container activity <small>({server.container_events.status})</small></h2>{containerEvents.length === 0 ? <p>No container activity observed in this app session</p> : containerEvents.map((event) => <p key={`${event.occurred_at}-${event.container_id}-${event.action}`}><b>{event.action}</b><span>{new Date(event.occurred_at).toLocaleString()}<br />{eventSummary(event)}</span></p>)}</article>
  </div></main>;
}

const blankConfig = (): ConfigServer => ({ id: "", enabled: true, display_name: "", ssh_host: "", ssh_user: "", ssh_port: 22, ssh_known_hosts: "~/.ssh/known_hosts", tracked_users: [], collectors: { gpu: "auto", docker: "auto" }, owner_hints: { compose_projects: {}, home_prefixes: {} } });

function LegacyServerManagement({ close }: { close: () => void }) {
  const [items, setItems] = useState<ConfigServer[]>([]);
  const [editing, setEditing] = useState<ConfigServer | null>(null);
  const [editingExisting, setEditingExisting] = useState(false);
  const [tracked, setTracked] = useState("");
  const [compose, setCompose] = useState("{}");
  const [homes, setHomes] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { getConfiguredServers().then(setItems).catch((reason: Error) => setError(reason.message)); }, []);
  const begin = (item: ConfigServer, existing = true) => { setEditing({ ...item }); setEditingExisting(existing); setTracked(item.tracked_users.join(", ")); setCompose(JSON.stringify(item.owner_hints.compose_projects, null, 2)); setHomes(JSON.stringify(item.owner_hints.home_prefixes, null, 2)); setError(null); };
  const save = async (event: FormEvent) => { event.preventDefault(); if (!editing) return; setSaving(true); setError(null); try { const payload = { ...editing, tracked_users: tracked.split(",").map((value) => value.trim()).filter(Boolean), owner_hints: { compose_projects: JSON.parse(compose), home_prefixes: JSON.parse(homes) } }; const next = editingExisting ? await updateConfiguredServer(payload) : await addConfiguredServer(payload); setItems(next); setEditing(null); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save server"); } finally { setSaving(false); } };
  const toggle = async (item: ConfigServer) => { try { setItems(await setServerEnabled(item.id, !item.enabled)); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update server"); } };
  const remove = async (item: ConfigServer) => { if (!window.confirm(`Delete ${item.display_name || item.id}?`)) return; try { setItems(await deleteConfiguredServer(item.id)); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not delete server"); } };
  return <main className="management"><button className="back" onClick={close}>← Dashboard</button><header className="management-header"><div><p className="caption">SERVER CONFIGURATION</p><h1>Manage servers</h1></div><button className="manage-button" onClick={() => begin(blankConfig(), false)}>＋ Add server</button></header>{error && <p className="error">{error}</p>}<div className="server-list">{items.map((item) => <div className="server-row" key={item.id}><button className={`server-enabled ${item.enabled ? "on" : ""}`} aria-label={`${item.display_name || item.id} ${item.enabled ? "enabled" : "disabled"}`} onClick={() => toggle(item)}>{item.enabled ? "ON" : "OFF"}</button><div><strong>{item.display_name || item.id}</strong><small>{item.ssh_user ? `${item.ssh_user}@` : ""}{item.ssh_host}:{item.ssh_port}</small></div><button className="row-action" onClick={() => begin(item)}>Edit</button><button className="row-action danger" onClick={() => remove(item)}>Delete</button></div>)}</div>{editing && <form className="server-form" onSubmit={save}><div className="form-header"><h2>{editingExisting ? "Edit server" : "Add server"}</h2><button type="button" className="row-action" onClick={() => setEditing(null)}>Cancel</button></div><label>ID<input required pattern="[A-Za-z0-9_-]+" disabled={editingExisting} value={editing.id} onChange={(event) => setEditing({ ...editing, id: event.target.value })} /></label><label>Display name<input value={editing.display_name ?? ""} onChange={(event) => setEditing({ ...editing, display_name: event.target.value })} /></label><label>SSH host<input required value={editing.ssh_host} onChange={(event) => setEditing({ ...editing, ssh_host: event.target.value })} /></label><div className="form-grid"><label>SSH user<input value={editing.ssh_user ?? ""} onChange={(event) => setEditing({ ...editing, ssh_user: event.target.value })} /></label><label>SSH port<input type="number" min="1" max="65535" required value={editing.ssh_port} onChange={(event) => setEditing({ ...editing, ssh_port: Number(event.target.value) })} /></label></div><label>Known hosts path<input required value={editing.ssh_known_hosts} onChange={(event) => setEditing({ ...editing, ssh_known_hosts: event.target.value })} /></label><label>Tracked users <small>(comma separated)</small><input value={tracked} onChange={(event) => setTracked(event.target.value)} /></label><div className="form-grid"><label>GPU collector<select value={editing.collectors.gpu} onChange={(event) => setEditing({ ...editing, collectors: { ...editing.collectors, gpu: event.target.value } })}><option>auto</option><option>off</option></select></label><label>Docker collector<select value={editing.collectors.docker} onChange={(event) => setEditing({ ...editing, collectors: { ...editing.collectors, docker: event.target.value }})}><option>auto</option><option>off</option></select></label></div><label>Compose project owners <textarea value={compose} onChange={(event) => setCompose(event.target.value)} /></label><label>Home prefix owners <textarea value={homes} onChange={(event) => setHomes(event.target.value)} /></label><button className="save-button" disabled={saving}>{saving ? "Saving…" : "Save server"}</button></form>}</main>;
}

function moveServerRelative(items: Server[], sourceId: string, targetId: string, position: "before" | "after"): Server[] {
  if (sourceId === targetId) return items;
  const source = items.find((item) => item.server_id === sourceId);
  const target = items.find((item) => item.server_id === targetId);
  if (!source || !target) return items;
  const remaining = items.filter((item) => item.server_id !== sourceId);
  const targetIndex = remaining.findIndex((item) => item.server_id === targetId);
  remaining.splice(targetIndex + (position === "after" ? 1 : 0), 0, source);
  return remaining;
}

function SortableServerRow({ item, index, items, disabled, onEdit, onToggle, onRemove, onMove }: {
  item: ConfigServer; index: number; items: ConfigServer[]; disabled: boolean; onEdit: (item: ConfigServer) => void;
  onToggle: (item: ConfigServer) => void; onRemove: (item: ConfigServer) => void;
  onMove: (serverId: string, targetId: string, position: "before" | "after") => void;
}) {
  const sortable = useSortable({ id: item.id, disabled });
  const previous = items[index - 1];
  const next = items[index + 1];
  return <div ref={sortable.setNodeRef} className={`server-row${sortable.isDragging ? " dragging" : ""}`} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}>
    <button className="drag-handle" aria-label="서버 순서 변경" disabled={disabled} {...sortable.attributes} {...sortable.listeners}>⠿</button>
    <button className={`server-enabled ${item.enabled ? "on" : ""}`} aria-label={`${item.display_name || item.id} ${item.enabled ? "enabled" : "disabled"}`} onClick={() => onToggle(item)} disabled={disabled}>{item.enabled ? "ON" : "OFF"}</button>
    <div className="server-description"><strong>{item.display_name || item.id}</strong><small>{item.ssh_user ? `${item.ssh_user}@` : ""}{item.ssh_host}:{item.ssh_port}</small></div>
    <div className="move-actions"><button className="row-action" aria-label={`${item.display_name || item.id} 위로 이동`} disabled={disabled || !previous} onClick={() => previous && onMove(item.id, previous.id, "before")}>↑</button><button className="row-action" aria-label={`${item.display_name || item.id} 아래로 이동`} disabled={disabled || !next} onClick={() => next && onMove(item.id, next.id, "after")}>↓</button></div>
    <button className="row-action" onClick={() => onEdit(item)} disabled={disabled}>Edit</button><button className="row-action danger" onClick={() => onRemove(item)} disabled={disabled}>Delete</button>
  </div>;
}

function ServerManagement({ close }: { close: () => void }) {
  const [items, setItems] = useState<ConfigServer[]>([]);
  const [editing, setEditing] = useState<ConfigServer | null>(null);
  const [editingExisting, setEditingExisting] = useState(false);
  const [tracked, setTracked] = useState("");
  const [compose, setCompose] = useState("{}");
  const [homes, setHomes] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reordering, setReordering] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  useEffect(() => { getConfiguredServers().then(setItems).catch((reason: Error) => setError(reason.message)); }, []);
  const begin = (item: ConfigServer, existing = true) => { setEditing({ ...item }); setEditingExisting(existing); setTracked(item.tracked_users.join(", ")); setCompose(JSON.stringify(item.owner_hints.compose_projects, null, 2)); setHomes(JSON.stringify(item.owner_hints.home_prefixes, null, 2)); setError(null); };
  const save = async (event: FormEvent) => { event.preventDefault(); if (!editing) return; setSaving(true); setError(null); try { const payload = { ...editing, tracked_users: tracked.split(",").map((value) => value.trim()).filter(Boolean), owner_hints: { compose_projects: JSON.parse(compose), home_prefixes: JSON.parse(homes) } }; const next = editingExisting ? await updateConfiguredServer(payload) : await addConfiguredServer(payload); setItems(next); setEditing(null); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save server"); } finally { setSaving(false); } };
  const toggle = async (item: ConfigServer) => { try { setItems(await setServerEnabled(item.id, !item.enabled)); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update server"); } };
  const remove = async (item: ConfigServer) => { if (!window.confirm(`Delete ${item.display_name || item.id}?`)) return; try { setItems(await deleteConfiguredServer(item.id)); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not delete server"); } };
  const reorder = async (serverId: string, targetId: string, position: "before" | "after") => {
    if (reordering || serverId === targetId) return;
    const previous = items;
    const next = moveRelative(items, serverId, targetId, position);
    if (next === items) return;
    setItems(next); setReordering(true); setError(null);
    try { setItems(await reorderConfiguredServer(serverId, targetId, position)); }
    catch (reason) { setItems(previous); setError(reason instanceof Error ? reason.message : "Could not reorder servers"); }
    finally { setReordering(false); }
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const sourceIndex = items.findIndex((item) => item.id === active.id);
    const targetIndex = items.findIndex((item) => item.id === over.id);
    if (sourceIndex < 0 || targetIndex < 0) return;
    void reorder(String(active.id), String(over.id), sourceIndex < targetIndex ? "after" : "before");
  };
  const controlsDisabled = saving || reordering;
  return <main className="management"><button className="back" onClick={close}>← Dashboard</button><header className="management-header"><div><p className="caption">SERVER CONFIGURATION</p><h1>Manage servers</h1></div><button className="manage-button" disabled={controlsDisabled} onClick={() => begin(blankConfig(), false)}>＋ Add server</button></header>{error && <p className="error">{error}</p>}<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}><SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}><div className="server-list">{items.map((item, index) => <SortableServerRow key={item.id} item={item} index={index} items={items} disabled={controlsDisabled} onEdit={begin} onToggle={toggle} onRemove={remove} onMove={(serverId, targetId, position) => void reorder(serverId, targetId, position)} />)}</div></SortableContext></DndContext>{editing && <form className="server-form" onSubmit={save}><div className="form-header"><h2>{editingExisting ? "Edit server" : "Add server"}</h2><button type="button" className="row-action" onClick={() => setEditing(null)}>Cancel</button></div><label>ID<input required pattern="[A-Za-z0-9_-]+" disabled={editingExisting} value={editing.id} onChange={(event) => setEditing({ ...editing, id: event.target.value })} /></label><label>Display name<input value={editing.display_name ?? ""} onChange={(event) => setEditing({ ...editing, display_name: event.target.value })} /></label><label>SSH host<input required value={editing.ssh_host} onChange={(event) => setEditing({ ...editing, ssh_host: event.target.value })} /></label><div className="form-grid"><label>SSH user<input value={editing.ssh_user ?? ""} onChange={(event) => setEditing({ ...editing, ssh_user: event.target.value })} /></label><label>SSH port<input type="number" min="1" max="65535" required value={editing.ssh_port} onChange={(event) => setEditing({ ...editing, ssh_port: Number(event.target.value) })} /></label></div><label>Known hosts path<input required value={editing.ssh_known_hosts} onChange={(event) => setEditing({ ...editing, ssh_known_hosts: event.target.value })} /></label><label>Tracked users <small>(comma separated)</small><input value={tracked} onChange={(event) => setTracked(event.target.value)} /></label><div className="form-grid"><label>GPU collector<select value={editing.collectors.gpu} onChange={(event) => setEditing({ ...editing, collectors: { ...editing.collectors, gpu: event.target.value } })}><option>auto</option><option>off</option></select></label><label>Docker collector<select value={editing.collectors.docker} onChange={(event) => setEditing({ ...editing, collectors: { ...editing.collectors, docker: event.target.value } })}><option>auto</option><option>off</option></select></label></div><label>Compose project owners <textarea value={compose} onChange={(event) => setCompose(event.target.value)} /></label><label>Home prefix owners <textarea value={homes} onChange={(event) => setHomes(event.target.value)} /></label><button className="save-button" disabled={saving}>{saving ? "Saving…" : "Save server"}</button></form>}</main>;
}

export default function App() {
  const [servers, setServers] = useState<Server[]>([]);
  const [providers, setProviders] = useState<ProviderSnapshot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [management, setManagement] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  useEffect(() => { getServers().then(setServers).catch((reason: Error) => setError(reason.message)); getProviders().then(setProviders).catch((reason: Error) => setError(reason.message)); return subscribe(setServers, setProviders); }, []);
  const reorder = async (serverId: string, targetId: string, position: "before" | "after") => {
    if (reordering || serverId === targetId) return;
    const previous = servers;
    const next = moveServerRelative(servers, serverId, targetId, position);
    if (next === servers) return;
    setServers(next); setReordering(true); setError(null);
    try { await reorderConfiguredServer(serverId, targetId, position); }
    catch (reason) { setServers(previous); setError(reason instanceof Error ? reason.message : "Could not reorder servers"); }
    finally { setReordering(false); }
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const sourceIndex = servers.findIndex((server) => server.server_id === active.id);
    const targetIndex = servers.findIndex((server) => server.server_id === over.id);
    if (sourceIndex < 0 || targetIndex < 0) return;
    void reorder(String(active.id), String(over.id), sourceIndex < targetIndex ? "after" : "before");
  };
  const current = servers.find((server) => server.server_id === selected);
  if (management) return <ServerManagement close={() => setManagement(false)} />;
  if (current) return <Detail server={current} close={() => setSelected(null)} />;
  return <main><header className="masthead"><div><p>LIVE RESOURCE MONITOR</p><h1>ResourceDeck</h1></div><div className="masthead-actions"><span>{servers.length} active servers</span><button className="manage-button" onClick={() => setManagement(true)}>⚙ Manage servers</button></div></header>{error && <p className="error">{error}</p>}<CodexUsage provider={providers.find((provider) => provider.provider_id === "codex")} /><DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}><SortableContext items={servers.map((server) => server.server_id)} strategy={rectSortingStrategy}><div className="grid">{servers.map((server) => <SortableCard key={server.server_id} server={server} disabled={reordering} onOpen={() => setSelected(server.server_id)} />)}</div></SortableContext></DndContext>{servers.length === 0 && <div className="empty">No active server snapshots. Open <button className="link-button" onClick={() => setManagement(true)}>Manage servers</button> to enable one.</div>}</main>;
}
