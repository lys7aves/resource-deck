import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  container_events: envelope([]),
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
    expect(within(screen.getByText("Users").closest("article")!).getByText("yuseop")).toBeTruthy();
    expect(screen.queryByText("daemon")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All users (1 hidden)" }));
    expect(screen.getByText("daemon")).toBeTruthy();
  });

  it("keeps system accounts collapsed in the users card", async () => {
    getServers.mockResolvedValue([{
      ...server,
      tracked_users_configured: false,
      users: envelope([
        { username: "ys.lee", estimated_cpu_cores: 1, memory_rss_bytes: 1024, tracked: false, is_system: false },
        { username: "systemd-timesync", estimated_cpu_cores: 0, memory_rss_bytes: 2048, tracked: false, is_system: true },
      ]),
    }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);

    await screen.findByText("Oracle");
    fireEvent.click(screen.getByRole("button", { name: /Oracle/ }));
    expect(screen.getByText("ys.lee")).toBeTruthy();
    const systemAccounts = screen.getByText("System accounts (1)").closest("details");
    expect(systemAccounts?.open).toBe(false);
    fireEvent.click(screen.getByText("System accounts (1)"));
    expect(systemAccounts?.open).toBe(true);
    expect(screen.getByText("systemd-timesync")).toBeTruthy();
  });

  it("shows container owner and GPU mapping evidence including unmapped fallback", async () => {
    getServers.mockResolvedValue([server]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);

    await screen.findByText("Oracle");
    fireEvent.click(screen.getByRole("button", { name: /Oracle/ }));
    expect(screen.getByText("unknown image")).toBeTruthy();
    expect(document.querySelector(".container-owner")?.textContent).toBe("yuseop");
    expect(screen.getByText("cgroup match · high confidence")).toBeTruthy();
    expect(screen.getByText("Not mapped to a container")).toBeTruthy();
    expect(screen.getByText("no container evidence")).toBeTruthy();
  });

  it("separates running containers from recent lifecycle activity", async () => {
    getServers.mockResolvedValue([{
      ...server,
      containers: envelope([{ ...server.containers.value![0], image: "repo/train:latest", memory_used_bytes: 1536 * 1024 ** 2, memory_limit_bytes: 4 * 1024 ** 3 }]),
      container_events: envelope([{ occurred_at: "2026-09-02T00:00:00Z", action: "destroy", container_id: "deadbeef123456", name: "brief-job", image: "repo/job:latest", owner: "alice", owner_source: "label", exit_code: 12 }]),
    }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);

    await screen.findByText("Oracle");
    fireEvent.click(screen.getByRole("button", { name: /Oracle/ }));
    expect(screen.getByText("Running containers")).toBeTruthy();
    expect(screen.getByText("Recent container activity")).toBeTruthy();
    expect(screen.getByText("destroy")).toBeTruthy();
    expect(screen.getByText(/brief-job · repo\/job:latest · alice · exit 12/)).toBeTruthy();
  });

  it("shows recent Docker activity on the server card", async () => {
    getServers.mockResolvedValue([{ ...server, containers: envelope([]), container_events: envelope([{ occurred_at: "2026-09-02T00:00:00Z", action: "destroy", container_id: "deadbeef" }]) }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);

    expect(await screen.findByText("0 running")).toBeTruthy();
    expect(screen.getByText("1 recent events")).toBeTruthy();
  });

  it("shows a VRAM allocation bar while preserving exact GPU memory values", async () => {
    getServers.mockResolvedValue([{
      ...server,
      gpus: envelope([{ index: 0, uuid: "GPU-a", utilization_percent: 30, memory_used_mib: 13.6 * 1024, memory_total_mib: 24 * 1024, state: "busy" }]),
    }]);
    subscribe.mockReturnValue(() => undefined);
    render(<App />);

    const bar = await screen.findByRole("progressbar", { name: "GPU0 VRAM allocation: 13.6 GB used; 400 MB for tracked users" });
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

    const bar = await screen.findByRole("progressbar", { name: "GPU0 VRAM allocation: 1.0 GB used; 0 MB for tracked users" });
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
    const cpu = screen.getByRole("progressbar", { name: "CPU usage: 50% used; 2.0 core equivalent estimate for tracked users" });
    expect(cpu.querySelector(".bar-mine")?.getAttribute("style")).toContain("width: 25%");
    expect(cpu.querySelector(".bar-other")?.getAttribute("style")).toContain("width: 25%");
    const ram = screen.getByRole("progressbar", { name: "RAM usage: 50% used; 1 KB RSS estimate for tracked users" });
    expect(ram.querySelector(".bar-mine")?.getAttribute("style")).toContain("width: 50%");
    expect(ram.querySelector(".bar-other")?.getAttribute("style")).toContain("width: 0%");
    const gpu = screen.getByRole("progressbar", { name: "GPU0 VRAM allocation: 1.0 GB used; 512 MB for tracked users" });
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
    const cpu = screen.getByRole("progressbar", { name: "CPU usage: 50% used; 8.0 core equivalent estimate for tracked users" });
    expect(cpu.querySelector(".bar-mine")?.getAttribute("style")).toContain("width: 50%");
    expect(cpu.querySelector(".bar-other")?.getAttribute("style")).toContain("width: 0%");
    const ram = screen.getByRole("progressbar", { name: "RAM usage: 50% used; 4 KB RSS estimate for tracked users" });
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


describe("Container usage list", () => {
  beforeEach(() => { getProviders.mockResolvedValue([]); getConfiguredServers.mockResolvedValue([]); subscribe.mockReturnValue(() => undefined); });
  async function open(snapshot: Server) {
    getServers.mockResolvedValue([snapshot]);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Oracle/ }));
  }
  const example: Server = {
    ...server,
    system: envelope({ logical_cores: 8, memory_total_bytes: 251.5 * 1024 ** 3 }),
    gpus: envelope([0, 1].map((index) => ({ index, memory_total_mib: 48 * 1024, state: "busy" }))),
    containers: envelope([{ ...server.containers.value![0], image: "custom-vllm:0.19.1-cu12.1", cpu_percent: 305.1, memory_used_bytes: 11.1 * 1024 ** 3, memory_limit_bytes: 12 * 1024 ** 3, gpu_memory_mib: 43.6 * 1024 }]),
  };
  it("shows compact server-capacity rows and the full metrics when expanded", async () => {
    await open(example);
    expect(screen.getByText("1 running")).toBeTruthy();
    expect(screen.getByText("8 cores")).toBeTruthy();
    expect(screen.getByText("251.5 GB")).toBeTruthy();
    expect(screen.getByText("96.0 GB")).toBeTruthy();
    const row = screen.getByRole("group", { name: "Container trainer" }) as HTMLDetailsElement;
    expect(row.open).toBe(false);
    expect(within(row).getByText("3.05코어")).toBeTruthy();
    expect(within(row).getByText("11.1 GB", { selector: ".container-compact-metric strong" })).toBeTruthy();
    expect(within(row).getByText("43.6 GB", { selector: ".container-compact-metric strong" })).toBeTruthy();
    expect(row.open).toBe(false);
    fireEvent.click(row.querySelector("summary")!);
    expect(row.open).toBe(true);
    expect(within(row).getByText("custom-vllm:0.19.1-cu12.1")).toBeTruthy();
    expect(within(row).getByText("305.1%")).toBeTruthy();
    expect(within(row).getByText(/약 3.05코어 사용/)).toBeTruthy();
    for (const [resource, share] of [["CPU", 38.1375], ["RAM", 100 * 11.1 / 251.5], ["GPU VRAM", 100 * 43.6 / 96]] as const) {
      expect(within(row).getAllByRole("progressbar", { name: new RegExp(`${resource}: ${share.toFixed(1)}% of server capacity`) })).toHaveLength(2);
    }
  });
  it("opens multiple rows and keeps expanded rows through SSE updates", async () => {
    await open({ ...example, containers: envelope([
      ...example.containers.value!, { ...example.containers.value![0], id: "second", name: "second-container" },
    ]) });
    const first = screen.getByRole("group", { name: "Container trainer" }) as HTMLDetailsElement;
    const second = screen.getByRole("group", { name: "Container second-container" }) as HTMLDetailsElement;
    const firstSummary = first.querySelector("summary")!;
    const secondSummary = second.querySelector("summary")!;
    fireEvent.click(firstSummary);
    fireEvent.click(secondSummary);
    expect(first.open).toBe(true);
    expect(second.open).toBe(true);
    act(() => subscribe.mock.calls.at(-1)![0]([{ ...example, containers: envelope([
      { ...example.containers.value![0], cpu_percent: 900, gpu_memory_mib: null },
      { ...example.containers.value![0], id: "second", name: "second-container" },
    ]) }]));
    const updatedFirst = screen.getByRole("group", { name: "Container trainer" }) as HTMLDetailsElement;
    const updatedSecond = screen.getByRole("group", { name: "Container second-container" }) as HTMLDetailsElement;
    expect(updatedFirst.open).toBe(true);
    expect(updatedSecond.open).toBe(true);
    expect(within(updatedFirst).getByText("9.00코어")).toBeTruthy();
    expect(within(updatedFirst).getByText("900.0%")).toBeTruthy();
    expect(within(updatedFirst).getByText("112.5% of server capacity")).toBeTruthy();
    const cpuBars = within(updatedFirst).getAllByRole("progressbar", { name: /CPU: 112.5% of server capacity/ });
    expect(cpuBars).toHaveLength(2);
    expect(cpuBars.every((bar) => bar.getAttribute("aria-valuenow") === "100")).toBe(true);
    expect(within(updatedFirst).queryAllByRole("progressbar", { name: /GPU VRAM/ })).toHaveLength(0);
    act(() => subscribe.mock.calls.at(-1)![0]([{ ...example, containers: envelope([{ ...example.containers.value![0], cpu_percent: 0 }]) }]));
    expect(screen.queryByRole("group", { name: "Container second-container" })).toBeNull();
    expect((screen.getByRole("group", { name: "Container trainer" }) as HTMLDetailsElement).open).toBe(true);
  });
  it("omits bars when capacity is unknown and distinguishes zero from missing metrics", async () => {
    await open({ ...example, system: envelope({ logical_cores: 0 }), gpus: envelope([{ index: 0, memory_total_mib: 48 * 1024, state: "idle" }, { index: 1, state: "unknown" }]), containers: envelope([
      { ...example.containers.value![0], cpu_percent: 0, memory_used_bytes: 0, gpu_memory_mib: 0 },
      { ...example.containers.value![0], id: "missing", name: "missing", cpu_percent: null, memory_used_bytes: null, gpu_memory_mib: null },
    ]) });
    const zero = screen.getByRole("group", { name: "Container trainer" });
    const missing = screen.getByRole("group", { name: "Container missing" });
    expect(within(zero).getByText("0.00코어")).toBeTruthy();
    expect(within(zero).getByText("0 B", { selector: ".container-compact-metric strong" })).toBeTruthy();
    expect(within(zero).getByText("0 MB", { selector: ".container-compact-metric strong" })).toBeTruthy();
    expect(within(zero).queryAllByRole("progressbar")).toHaveLength(0);
    expect(within(missing).getAllByText("—", { selector: ".container-compact-metric strong" })).toHaveLength(3);
    expect(within(missing).queryAllByRole("progressbar")).toHaveLength(0);
  });
  it("shows long names and images in expanded details and preserves row order", async () => {
    const longName = "very-long-container-name-".repeat(15);
    const image = "very-long-image-name/".repeat(15);
    await open({ ...example, containers: envelope([
      { ...example.containers.value![0], name: longName, image },
      { ...example.containers.value![0], id: "second", name: "second" },
    ]) });
    const rows = screen.getAllByRole("group", { name: /^Container / });
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([`Container ${longName}`, "Container second"]);
    const first = rows[0] as HTMLDetailsElement;
    expect(within(first).getByText(longName, { selector: ".container-summary-identity strong" }).parentElement?.getAttribute("title")).toBe(`${longName} · yuseop`);
    fireEvent.click(first.querySelector("summary")!);
    expect(within(first).getByText(image)).toBeTruthy();
    expect(within(first).getByText(longName, { selector: ".container-expanded-metadata strong" })).toBeTruthy();
  });
  it("distinguishes empty inventory from unavailable inventory", async () => {
    await open({ ...example, containers: envelope([]) });
    expect(screen.getByText("No running containers")).toBeTruthy();
    act(() => subscribe.mock.calls.at(-1)![0]([{ ...example, containers: { ...example.containers, status: "unavailable", value: null } }]));
    expect(screen.getByText("Container data unavailable")).toBeTruthy();
  });
});
