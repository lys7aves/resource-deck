import type { ProviderSnapshot, Server } from "./types";

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

export function subscribe(onData: (servers: Server[]) => void, onProviders?: (providers: ProviderSnapshot[]) => void): () => void {
  const stream = new EventSource("/api/v1/events");
  const receive = (event: MessageEvent) => onData(JSON.parse(event.data));
  stream.addEventListener("sync", receive);
  stream.addEventListener("snapshot", receive);
  if (onProviders) stream.addEventListener("providers", (event: MessageEvent) => onProviders(JSON.parse(event.data)));
  return () => stream.close();
}
