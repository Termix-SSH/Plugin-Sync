import { afterEach, describe, expect, it } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { renderWithApp } from "@termix-ssh/plugin-sdk/testing";
import * as plugin from "../../src/frontend/index";
import manifest from "../../manifest.json";

afterEach(cleanup);

const mirrored = (id: number, remoteStatus?: string) => ({
  id,
  name: "remote web",
  ip: "10.0.0.3",
  pluginSettings: { sync: { siteId: 1, remoteId: 9, remoteStatus } },
});

describe("mirrored host status dot", () => {
  it("draws the remote site's status as a dot value", async () => {
    const rendered = await renderWithApp(plugin, {
      manifest: manifest as never,
      hosts: [mirrored(3, "offline"), mirrored(5, "reachable"), mirrored(6)],
    });
    const element = rendered.renderHostItems("status", mirrored(3, "offline"));
    await waitFor(() =>
      expect(element.querySelector("[data-data-dot='bad']")).not.toBeNull(),
    );
    const good = rendered.renderHostItems("status", mirrored(5, "reachable"));
    await waitFor(() =>
      expect(good.querySelector("[data-data-dot='good']")).not.toBeNull(),
    );
    const unknown = rendered.renderHostItems("status", mirrored(6));
    await waitFor(() =>
      expect(unknown.querySelector("[data-data-dot='muted']")).not.toBeNull(),
    );
    await rendered.deactivate();
  });

  it("draws nothing for a host that isn't mirrored", async () => {
    const rendered = await renderWithApp(plugin, {
      manifest: manifest as never,
    });
    const element = rendered.renderHostItems("status", {
      id: 4,
      name: "local",
      ip: "10.0.0.4",
    });
    expect(element.querySelector("[data-data-dot]")).toBeNull();
    await rendered.deactivate();
  });
});
