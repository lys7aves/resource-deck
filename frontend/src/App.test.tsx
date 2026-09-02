import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import type { Server } from "./types";

const api = vi.hoisted(() => ({ getServers: vi.fn(), subscribe: vi.fn() }));
const getServers = api.getServers as ReturnType<typeof vi.fn>;
const subscribe = api.subscribe as ReturnType<typeof vi.fn>;

vi.mock("./api", () => api);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function envelope<T>(value: T) {
  return { status: "ok" as const, observed_at: "2026-09-02T00:00:00Z", value };
}

const server: Server = {
  server_id: "oracle",
  display_name: "Oracle",
  connection: "online",
  tracked_users_configured: true,
  collected_at: "2026-09-02T00:00:00Z",
  system: envelope({ cpu_utilization_percent: 50, logical_cores: 8, load_average_1m: 1, memory_used_bytes: 1024, memory_total_bytes: 2048 }),
  gpus: envelope([]),
  users: envelope([
    { username: "yuseop", estimated_cpu_cores: 2, memory_rss_bytes: 1024, tracked: true },
    { username: "daemon", estimated_cpu_cores: 1, memory_rss_bytes: 2048, tracked: false },
  ]),
  containers: envelope([{ id: "abcdef1234567890", name: "trainer", cpu_percent: 12.5, gpu_memory_mib: 400, gpu_process_count: 1, owner: { owner: "yuseop", source: "label", confidence: "high" } }]),
  gpu_processes: envelope([
    { gpu_uuid: "GPU-a", pid: 123, process_name: "python", memory_used_mib: 400, container_id: "abcdef123456", container_mapping_source: "proc_cgroup", container_mapping_confidence: "high" },
    { gpu_uuid: "GPU-a", pid: 321, process_name: "other", memory_used_mib: 10, container_mapping_source: "unmapped", container_mapping_confidence: "none" },
  ]),
};

describe("ResourceDeck UI", () => {
  it("defaults to tracked users and reveals all users on demand", async () => {
    getServers.mockResolvedValue([server]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);

    await screen.findByText("Oracle");
    fireEvent.click(screen.getByRole("button", { name: /Oracle/ }));
    expect(screen.getByText("yuseop")).toBeTruthy();
    expect(screen.queryByText("daemon")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All users (1 hidden)" }));
    expect(screen.getByText("daemon")).toBeTruthy();
  });

  it("shows container owner and GPU mapping evidence including unmapped fallback", async () => {
    getServers.mockResolvedValue([server]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);

    await screen.findByText("Oracle");
    fireEvent.click(screen.getByRole("button", { name: /Oracle/ }));
    expect(screen.getByText("trainer · yuseop")).toBeTruthy();
    expect(screen.getByText("cgroup match · high confidence")).toBeTruthy();
    expect(screen.getByText("Not mapped to a container")).toBeTruthy();
    expect(screen.getByText("no container evidence")).toBeTruthy();
  });

  it("renders API errors and applies SSE snapshots", async () => {
    let receive: ((servers: Server[]) => void) | undefined;
    getServers.mockRejectedValue(new Error("Could not load server snapshots"));
    subscribe.mockImplementation((callback) => { receive = callback; return () => undefined; });
    render(<App />);

    await screen.findByText("Could not load server snapshots");
    receive?.([server]);
    await waitFor(() => expect(screen.getByText("Oracle")).toBeTruthy());
  });
});
