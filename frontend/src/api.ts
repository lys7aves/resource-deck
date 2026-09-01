import type { Server } from "./types";

export async function getServers(): Promise<Server[]> {
  const response = await fetch("/api/v1/servers");
  if (!response.ok) throw new Error("Could not load server snapshots");
  return response.json();
}

export function subscribe(onData: (servers: Server[]) => void): () => void {
  const stream = new EventSource("/api/v1/events");
  const receive = (event: MessageEvent) => onData(JSON.parse(event.data));
  stream.addEventListener("sync", receive);
  stream.addEventListener("snapshot", receive);
  return () => stream.close();
}
