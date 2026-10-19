import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/frontend/sync/api", () => ({
  probeServer: vi.fn(),
  getLinkPreview: vi.fn(),
  completeLink: vi.fn(),
  reloginLink: vi.fn(),
}));
vi.mock("../../src/frontend/sync/ElectronLoginForm", () => ({
  ElectronLoginForm: () => null,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { SurfaceScope } = await import("@termix-ssh/plugin-sdk/ui");
const { LinkServerDialog } =
  await import("../../src/frontend/sync/LinkServerDialog");

afterEach(cleanup);

describe("LinkServerDialog", () => {
  it("opens inline in the surface instead of a popup", () => {
    render(
      <SurfaceScope kind="tab">
        <LinkServerDialog open onOpenChange={() => {}} onLinked={() => {}} />
      </SurfaceScope>,
    );
    expect(screen.getByText("sync.wizard.title")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
