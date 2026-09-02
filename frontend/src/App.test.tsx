import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import type { Server } from "./types";

const api = vi.hoisted(() => ({ getServers: vi.fn(), getProviders: vi.fn(), subscribe: vi.fn() }));
const getServers = api.getServers as ReturnType<typeof vi.fn>;
const getProviders = api.getProviders as ReturnType<typeof vi.fn>;
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
  beforeEach(() => getProviders.mockResolvedValue([]));
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

  it("shows a VRAM allocation bar while preserving exact GPU memory values", async () => {
    getServers.mockResolvedValue([{
      ...server,
      gpus: envelope([{ index: 0, utilization_percent: 30, memory_used_mib: 13.6 * 1024, memory_total_mib: 24 * 1024, state: "busy" }]),
    }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);

    await screen.findByText("13.6 GB / 24.0 GB");
    const bar = screen.getByRole("progressbar", { name: "GPU0 VRAM allocation" });
    expect(bar.querySelector("i")?.getAttribute("style")).toContain("width: 56.");
    expect(screen.queryByText("57%")).toBeNull();
  });

  it("renders an empty VRAM bar when GPU memory capacity is unavailable", async () => {
    getServers.mockResolvedValue([{
      ...server,
      gpus: envelope([{ index: 0, utilization_percent: 0, memory_used_mib: 1024, memory_total_mib: 0, state: "idle" }]),
    }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);

    await screen.findByText("1.0 GB / —");
    const bar = screen.getByRole("progressbar", { name: "GPU0 VRAM allocation" });
    expect(bar.querySelector("i")?.getAttribute("style")).toContain("width: 0%");
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

  it("renders the Codex allowance and additional buckets", async () => {
    getServers.mockResolvedValue([]);
    getProviders.mockResolvedValue([{ provider_id: "codex", status: "ok", observed_at: "2026-09-02T00:00:00Z", data: { plan_type: "plus", reset_credits_available: 1, buckets: [{ id: "codex", windows: [{ kind: "primary", used_percent: 40, remaining_percent: 60, window_duration_minutes: 300, resets_at: 1788322054 }], credits: { has_credits: false, unlimited: false, balance: "0" } }, { id: "reserve", name: "Reserve", windows: [{ kind: "primary", used_percent: 20, remaining_percent: 80, window_duration_minutes: 60, resets_at: 1788322054 }] }] } }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);

    await screen.findByText(/Codex usage · plus/);
    expect(screen.getByText("60% left")).toBeTruthy();
    fireEvent.click(screen.getByText("Additional limits (1)"));
    expect(screen.getByText("Reserve")).toBeTruthy();
  });
});
