import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { ProxySettingsFields } =
  await import("../../src/frontend/sync/ProxySettingsFields");

afterEach(cleanup);

describe("ProxySettingsFields client certificate", () => {
  it("turns the certificate on and off", () => {
    const onChange = vi.fn();
    render(
      <ProxySettingsFields
        customHeaders={[]}
        basicAuth={null}
        clientCert={null}
        onChange={onChange}
      />,
    );
    const toggles = screen.getAllByRole("switch");
    fireEvent.click(toggles[toggles.length - 1]);
    expect(onChange).toHaveBeenCalledWith({
      clientCert: { pfx: "", passphrase: "", name: null },
    });
  });

  it("shows the saved file name", () => {
    render(
      <ProxySettingsFields
        customHeaders={[]}
        basicAuth={null}
        clientCert={{ pfx: "", passphrase: "", name: "me.pfx", set: true }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("me.pfx")).toBeTruthy();
  });
});
