import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import type { ConfigServer, Server } from "./types";

const api = vi.hoisted(() => ({ getServers: vi.fn(), getProviders: vi.fn(), getConfiguredServers: vi.fn(), addConfiguredServer: vi.fn(), updateConfiguredServer: vi.fn(), reorderConfiguredServer: vi.fn(), subscribe: vi.fn() }));
const getServers = api.getServers as ReturnType<typeof vi.fn>;
const getProviders = api.getProviders as ReturnType<typeof vi.fn>;
const getConfiguredServers = api.getConfiguredServers as ReturnType<typeof vi.fn>;
const addConfiguredServer = api.addConfiguredServer as ReturnType<typeof vi.fn>;
const updateConfiguredServer = api.updateConfiguredServer as ReturnType<typeof vi.fn>;
const reorderConfiguredServer = api.reorderConfiguredServer as ReturnType<typeof vi.fn>;
const subscribe = api.subscribe as ReturnType<typeof vi.fn>;

vi.mock("./api", () => api);

afterEach(() => {
  vi.useRealTimers();
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

const configuredServers: ConfigServer[] = [
  { id: "oracle", enabled: true, display_name: "Oracle", ssh_host: "oracle.example", ssh_port: 22, ssh_known_hosts: "~/.ssh/known_hosts", tracked_users: [], collectors: { gpu: "auto", docker: "auto" }, owner_hints: { compose_projects: {}, home_prefixes: {} } },
  { id: "gpu", enabled: false, display_name: "GPU", ssh_host: "gpu.example", ssh_port: 22, ssh_known_hosts: "~/.ssh/known_hosts", tracked_users: [], collectors: { gpu: "auto", docker: "auto" }, owner_hints: { compose_projects: {}, home_prefixes: {} } },
];

describe("ResourceDeck UI", () => {
  beforeEach(() => { getProviders.mockResolvedValue([]); getConfiguredServers.mockResolvedValue([]); });
  it("adds a new server with POST after its ID is entered", async () => {
    getServers.mockResolvedValue([]);
    subscribe.mockReturnValue(() => undefined);
    addConfiguredServer.mockResolvedValue([]);
    render(<App />);

    fireEvent.click((await screen.findAllByRole("button", { name: /Manage servers/ }))[0]);
    fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
    fireEvent.change(screen.getByLabelText("ID"), { target: { value: "WS002" } });
    fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "192.168.2.13" } });
    fireEvent.click(screen.getByRole("button", { name: "Save server" }));

    await waitFor(() => expect(addConfiguredServer).toHaveBeenCalledWith(expect.objectContaining({ id: "WS002", ssh_host: "192.168.2.13" })));
    expect(updateConfiguredServer).not.toHaveBeenCalled();
  });

  it("moves servers from the management list and saves their order immediately", async () => {
    getServers.mockResolvedValue([]);
    getConfiguredServers.mockResolvedValue(configuredServers);
    reorderConfiguredServer.mockResolvedValue([configuredServers[1], configuredServers[0]]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);

    fireEvent.click((await screen.findAllByRole("button", { name: /Manage servers/ }))[0]);
    await screen.findByText("Oracle");
    fireEvent.click(screen.getByRole("button", { name: "Oracle 아래로 이동" }));

    await waitFor(() => expect(reorderConfiguredServer).toHaveBeenCalledWith("oracle", "gpu", "after"));
    expect(screen.getAllByRole("button", { name: "서버 순서 변경" })).toHaveLength(2);
  });

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
      gpus: envelope([{ index: 0, uuid: "GPU-a", utilization_percent: 30, memory_used_mib: 13.6 * 1024, memory_total_mib: 24 * 1024, state: "busy" }]),
    }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);

    const bar = await screen.findByRole("progressbar", { name: "GPU0 VRAM allocation: 13.6 GB used; 400 MB mine" });
    expect(bar.querySelector(".bar-mine")?.getAttribute("style")).toContain("width: 1.");
    expect(bar.querySelector(".bar-other")?.getAttribute("style")).toContain("width: 55.");
    expect(screen.queryByText("57%")).toBeNull();
  });

  it("renders an empty VRAM bar when GPU memory capacity is unavailable", async () => {
    getServers.mockResolvedValue([{
      ...server,
      gpus: envelope([{ index: 0, utilization_percent: 0, memory_used_mib: 1024, memory_total_mib: 0, state: "idle" }]),
    }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);

    const bar = await screen.findByRole("progressbar", { name: "GPU0 VRAM allocation: 1.0 GB used; 0 MB mine" });
    expect(bar.querySelector(".bar-mine")?.getAttribute("style")).toContain("width: 0%");
  });

  it("splits CPU, RAM, and VRAM bars into mine and other usage", async () => {
    getServers.mockResolvedValue([{
      ...server,
      gpus: envelope([{ index: 0, uuid: "GPU-a", utilization_percent: 30, memory_used_mib: 1024, memory_total_mib: 2048, state: "busy" }]),
      gpu_processes: envelope([
        { gpu_uuid: "GPU-a", pid: 123, username: "root", process_name: "trainer", memory_used_mib: 512, container_id: "abcdef123456", container_mapping_source: "proc_cgroup", container_mapping_confidence: "high" },
        { gpu_uuid: "GPU-a", pid: 321, username: "daemon", process_name: "other", memory_used_mib: 512, container_mapping_source: "unmapped", container_mapping_confidence: "none" },
      ]),
    }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);

    await screen.findByText("Oracle");
    const cpu = screen.getByRole("progressbar", { name: "CPU usage: 50% used; 2.0 cores mine" });
    expect(cpu.querySelector(".bar-mine")?.getAttribute("style")).toContain("width: 25%");
    expect(cpu.querySelector(".bar-other")?.getAttribute("style")).toContain("width: 25%");
    const ram = screen.getByRole("progressbar", { name: "RAM usage: 50% used; 1 KB RSS estimate mine" });
    expect(ram.querySelector(".bar-mine")?.getAttribute("style")).toContain("width: 50%");
    expect(ram.querySelector(".bar-other")?.getAttribute("style")).toContain("width: 0%");
    const gpu = screen.getByRole("progressbar", { name: "GPU0 VRAM allocation: 1.0 GB used; 512 MB mine" });
    expect(gpu.querySelector(".bar-mine")?.getAttribute("style")).toContain("width: 25%");
    expect(gpu.querySelector(".bar-other")?.getAttribute("style")).toContain("width: 25%");
  });

  it("caps an over-counted user total at the system usage width", async () => {
    getServers.mockResolvedValue([{
      ...server,
      users: envelope([{ username: "yuseop", estimated_cpu_cores: 8, memory_rss_bytes: 4096, tracked: true }]),
    }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);

    await screen.findByText("Oracle");
    const cpu = screen.getByRole("progressbar", { name: "CPU usage: 50% used; 8.0 cores mine" });
    expect(cpu.querySelector(".bar-mine")?.getAttribute("style")).toContain("width: 50%");
    expect(cpu.querySelector(".bar-other")?.getAttribute("style")).toContain("width: 0%");
    const ram = screen.getByRole("progressbar", { name: "RAM usage: 50% used; 4 KB RSS estimate mine" });
    expect(ram.querySelector(".bar-mine")?.getAttribute("style")).toContain("width: 50%");
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

  it("highlights available reset credits and shows the earliest known expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
    getServers.mockResolvedValue([]);
    getProviders.mockResolvedValue([{ provider_id: "codex", status: "ok", observed_at: "2026-01-01T01:00:00Z", data: {
      reset_credits_available: 2,
      reset_credits: [
        { expires_at: Date.parse("2026-01-02T01:00:00Z") / 1000 },
        { expires_at: Date.parse("2026-01-01T01:50:00Z") / 1000 },
      ],
      buckets: [{ id: "codex", windows: [{ kind: "primary", used_percent: 40, remaining_percent: 60, window_duration_minutes: 100, resets_at: Date.parse("2026-01-01T01:50:00Z") / 1000 }] }],
    } }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);
    await act(async () => { await Promise.resolve(); });

    const label = screen.getByText("2");
    expect(label.closest(".reset-credit-badge")).toBeTruthy();
    expect(screen.getByText(/Earliest known expiry .*0h 50m left/)).toBeTruthy();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText(/Earliest known expiry .*0h 49m left/)).toBeTruthy();
  });

  it("keeps zero reset credits subdued", async () => {
    getServers.mockResolvedValue([]);
    getProviders.mockResolvedValue([{ provider_id: "codex", status: "ok", observed_at: "2026-01-01T01:00:00Z", data: {
      reset_credits_available: 0,
      buckets: [{ id: "codex", windows: [{ kind: "primary", used_percent: 40, remaining_percent: 60, window_duration_minutes: 100, resets_at: Date.parse("2026-01-01T01:50:00Z") / 1000 }] }],
    } }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);
    expect(await screen.findByText("0 reset credits available")).toBeTruthy();
    expect(screen.getByText("0 reset credits available").closest(".reset-credit-badge")).toBeNull();
  });

  it("falls back to a count-only badge without reset-credit details", async () => {
    getServers.mockResolvedValue([]);
    getProviders.mockResolvedValue([{ provider_id: "codex", status: "ok", observed_at: "2026-01-01T01:00:00Z", data: {
      reset_credits_available: 1,
      reset_credits: null,
      buckets: [{ id: "codex", windows: [{ kind: "primary", used_percent: 40, remaining_percent: 60, window_duration_minutes: 100, resets_at: Date.parse("2026-01-01T01:50:00Z") / 1000 }] }],
    } }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);
    expect((await screen.findByText("1")).closest(".reset-credit-badge")).toBeTruthy();
    expect(screen.queryByText(/Earliest known expiry/)).toBeNull();
  });

  it("marks the linear usage guide and reports pace for every Codex limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
    getServers.mockResolvedValue([]);
    getProviders.mockResolvedValue([{ provider_id: "codex", status: "ok", observed_at: "2026-01-01T01:00:00Z", data: { buckets: [
      { id: "codex", windows: [
        { kind: "primary", used_percent: 40, remaining_percent: 60, window_duration_minutes: 100, resets_at: Date.parse("2026-01-01T01:50:00Z") / 1000 },
        { kind: "secondary", used_percent: 55, remaining_percent: 45, window_duration_minutes: 100, resets_at: Date.parse("2026-01-01T01:50:00Z") / 1000 },
      ] },
      { id: "reserve", name: "Reserve", windows: [{ kind: "primary", used_percent: 65, remaining_percent: 35, window_duration_minutes: 100, resets_at: Date.parse("2026-01-01T01:50:00Z") / 1000 }] },
    ] } }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);
    await act(async () => { await Promise.resolve(); });

    const onPace = screen.getByRole("progressbar", { name: "5시간 사용 한도 remaining: 60% left; 50% recommended remaining by now" });
    expect(onPace.querySelector("i")?.getAttribute("style")).toContain("width: 60%");
    expect(onPace.querySelector(".bar-marker")?.getAttribute("style")).toContain("left: 50%");
    expect(screen.getByText("On pace")).toBeTruthy();
    expect(screen.getByText("Watch pace")).toBeTruthy();
    fireEvent.click(screen.getByText("Additional limits (1)"));
    expect(screen.getByText("Using fast")).toBeTruthy();
  });

  it("clamps pace guides outside the rate-limit window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
    getServers.mockResolvedValue([]);
    getProviders.mockResolvedValue([{ provider_id: "codex", status: "ok", observed_at: "2026-01-01T01:00:00Z", data: { buckets: [{ id: "codex", windows: [
      { kind: "primary", used_percent: 0, remaining_percent: 100, window_duration_minutes: 100, resets_at: Date.parse("2026-01-01T04:20:00Z") / 1000 },
      { kind: "secondary", used_percent: 100, remaining_percent: 0, window_duration_minutes: 100, resets_at: Date.parse("2026-01-01T00:50:00Z") / 1000 },
    ] }] } }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole("progressbar", { name: "5시간 사용 한도 remaining: 100% left; 100% recommended remaining by now" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "5시간 사용 한도 remaining: 0% left; 0% recommended remaining by now" })).toBeTruthy();
  });

  it("refreshes the pace guide and reset countdown every minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
    getServers.mockResolvedValue([]);
    getProviders.mockResolvedValue([{ provider_id: "codex", status: "ok", observed_at: "2026-01-01T01:00:00Z", data: { buckets: [{ id: "codex", windows: [{ kind: "primary", used_percent: 40, remaining_percent: 60, window_duration_minutes: 100, resets_at: Date.parse("2026-01-01T01:50:00Z") / 1000 }] }] } }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);
    await act(async () => { await Promise.resolve(); });

    screen.getByRole("progressbar", { name: "5시간 사용 한도 remaining: 60% left; 50% recommended remaining by now" });
    expect(screen.getByText(/0h 50m left/)).toBeTruthy();
    act(() => vi.advanceTimersByTime(60_000));
    const refreshedBar = screen.getByRole("progressbar", { name: "5시간 사용 한도 remaining: 60% left; 49% recommended remaining by now" });
    expect(refreshedBar.querySelector(".bar-marker")?.getAttribute("style")).toContain("left: 49%");
    expect(screen.getByText(/0h 49m left/)).toBeTruthy();
  });

  it("shows days in weekly reset countdowns only when at least one day remains", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
    getServers.mockResolvedValue([]);
    getProviders.mockResolvedValue([{ provider_id: "codex", status: "ok", observed_at: "2026-01-01T01:00:00Z", data: { buckets: [{ id: "codex", windows: [
      { kind: "primary", used_percent: 40, remaining_percent: 60, window_duration_minutes: 10_080, resets_at: Date.parse("2026-01-03T04:04:00Z") / 1000 },
      { kind: "secondary", used_percent: 40, remaining_percent: 60, window_duration_minutes: 10_080, resets_at: Date.parse("2026-01-02T00:59:00Z") / 1000 },
    ] }] } }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);
    await act(async () => { await Promise.resolve(); });

    expect(screen.getAllByText("주간 사용 한도")).toHaveLength(2);
    expect(screen.getByText(/2d 3h 4m left/)).toBeTruthy();
    expect(screen.getByText(/23h 59m left/)).toBeTruthy();
  });
});
