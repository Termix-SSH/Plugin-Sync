import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncStatus } from "../../src/frontend/sync/api";

const status = vi.hoisted(() => ({ value: null as SyncStatus | null }));
const api = vi.hoisted(() => ({
  getSyncConflicts: vi.fn(async () => []),
  getSyncErrors: vi.fn(async () => []),
  updateSyncSettings: vi.fn(),
  syncNow: vi.fn(),
  unlinkServer: vi.fn(),
  retrySyncErrors: vi.fn(),
  settleSyncConflict: vi.fn(),
  settleAllSyncConflicts: vi.fn(),
  probeServer: vi.fn(),
  getLinkPreview: vi.fn(),
  completeLink: vi.fn(),
  reloginLink: vi.fn(),
}));

vi.mock("../../src/frontend/sync/api", () => api);
vi.mock("../../src/frontend/sync/use-sync-status", () => ({
  useSyncStatus: () => status.value,
  useSyncAttentionCount: () => null,
}));
vi.mock("../../src/frontend/sync/status", () => ({
  setSyncStatus: vi.fn(),
  refreshSyncStatus: vi.fn(),
  subscribeSyncStatus: vi.fn(() => () => {}),
}));
vi.mock("../../src/frontend/sync/ElectronLoginForm", () => ({
  ElectronLoginForm: () => null,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@termix-ssh/plugin-sdk/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifySyncChanged: vi.fn(),
  invalidateServerStatusCache: vi.fn(),
  useConfirm: () => async () => true,
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { SyncPanel } = await import("../../src/frontend/sync/SyncPanel");

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    invoke: vi.fn(async () => null),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const LINKED: SyncStatus = {
  linked: true,
  serverUrl: "https://termix.example",
  serverName: "Home",
  account: { username: "luke" },
  status: "idle",
  lastSyncAt: new Date().toISOString(),
  pending: 0,
  conflicts: 0,
  errors: 0,
  entities: [
    {
      type: "hosts",
      owner: "core",
      ownerName: null,
      readOnly: false,
      onServer: true,
      onDevice: true,
      enabled: true,
    },
    {
      type: "snippets",
      owner: "snippets",
      ownerName: "Snippets",
      readOnly: false,
      onServer: true,
      onDevice: true,
      enabled: false,
    },
  ],
};

describe("SyncPanel", () => {
  it("explains this-device-only use and offers to link", () => {
    status.value = { linked: false, entities: [] };
    render(<SyncPanel />);
    expect(screen.getByText("sync.unlinkedTitle")).toBeTruthy();
    fireEvent.click(screen.getByText("sync.linkButton"));
    expect(screen.getByText("sync.wizard.title")).toBeTruthy();
  });

  it("shows the account, server and what syncs, grouped by feature", () => {
    status.value = LINKED;
    render(<SyncPanel />);
    expect(screen.getByText("Home")).toBeTruthy();
    expect(screen.getByText("luke")).toBeTruthy();
    expect(screen.getByText("sync.coreGroup")).toBeTruthy();
    expect(screen.getByText("Snippets")).toBeTruthy();
  });

  it("switches a kind of data off, keeping the others as they are", async () => {
    status.value = LINKED;
    api.updateSyncSettings.mockResolvedValue(LINKED);
    render(<SyncPanel />);
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]);
    await waitFor(() =>
      expect(api.updateSyncSettings).toHaveBeenCalledWith({
        disabledTypes: expect.arrayContaining(["snippets", "hosts"]),
      }),
    );
  });

  it("settles every conflict at once after a confirm", async () => {
    status.value = { ...LINKED, conflicts: 2 };
    api.getSyncConflicts.mockResolvedValueOnce([
      { id: 1, entityType: "hosts", syncId: "a", name: "A", createdAt: "" },
      { id: 2, entityType: "hosts", syncId: "b", name: "B", createdAt: "" },
    ] as never);
    render(<SyncPanel />);
    fireEvent.click(await screen.findByText("sync.keepAllServer"));
    await waitFor(() =>
      expect(api.settleAllSyncConflicts).toHaveBeenCalledWith("server"),
    );
  });

  it("asks to sign in again when the server ended the session", () => {
    status.value = { ...LINKED, status: "signed_out" };
    render(<SyncPanel />);
    expect(screen.getByText("sync.state.signedOut")).toBeTruthy();
    expect(screen.getByText("sync.signInAgain")).toBeTruthy();
    expect(screen.queryByText("sync.syncNow")).toBeNull();
  });
});
