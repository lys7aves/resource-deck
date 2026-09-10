import type { ConfigServer, ProviderSnapshot, Server } from "./types";

async function jsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    const payload = contentType.includes("application/json") ? await response.json().catch(() => null) : null;
    const detail = payload && typeof payload === "object" && "detail" in payload ? payload.detail : null;
    throw new Error(typeof detail === "string" ? detail : fallback);
  }
  if (!contentType.includes("application/json")) throw new Error("Backend API is unavailable. Start ResourceDeck on port 8765.");
  return response.json();
}

export async function getServers(): Promise<Server[]> {
  const response = await fetch("/api/v1/servers");
  if (!response.ok) throw new Error("Could not load server snapshots");
  return response.json();
}

export async function getProviders(): Promise<ProviderSnapshot[]> {
  const response = await fetch("/api/v1/providers");
  if (!response.ok) throw new Error("Could not load provider snapshots");
  return response.json();
}

export async function getConfiguredServers(): Promise<ConfigServer[]> { return jsonResponse(await fetch("/api/v1/config/servers"), "Could not load server configuration"); }
async function configRequest(url: string, method: string, body?: unknown): Promise<ConfigServer[]> { return jsonResponse(await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }), "Could not save server configuration"); }
export const addConfiguredServer = (server: ConfigServer) => configRequest("/api/v1/config/servers", "POST", server);
export const updateConfiguredServer = (server: ConfigServer) => configRequest(`/api/v1/config/servers/${encodeURIComponent(server.id)}`, "PUT", server);
export const setServerEnabled = (id: string, enabled: boolean) => configRequest(`/api/v1/config/servers/${encodeURIComponent(id)}/enabled?enabled=${enabled}`, "PATCH");
export const reorderConfiguredServer = (serverId: string, targetId: string, position: "before" | "after") => configRequest("/api/v1/config/servers/order", "PATCH", { server_id: serverId, target_id: targetId, position });
export const deleteConfiguredServer = (id: string) => configRequest(`/api/v1/config/servers/${encodeURIComponent(id)}`, "DELETE");

export function subscribe(onData: (servers: Server[]) => void, onProviders?: (providers: ProviderSnapshot[]) => void): () => void {
  const stream = new EventSource("/api/v1/events");
  const receive = (event: MessageEvent) => onData(JSON.parse(event.data));
  stream.addEventListener("sync", receive);
  stream.addEventListener("snapshot", receive);
  if (onProviders) stream.addEventListener("providers", (event: MessageEvent) => onProviders(JSON.parse(event.data)));
  return () => stream.close();
}
