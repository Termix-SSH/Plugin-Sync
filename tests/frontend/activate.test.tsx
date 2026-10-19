import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const site = {
  id: 1,
  name: "Berlin",
  baseUrl: "https://berlin.example.com",
  status: "ok",
  lastError: null,
  lastSeenAt: "2026-10-19T10:00:00.000Z",
  hostCount: 2,
};

function api(sites: unknown[]) {
  return {
    get: vi.fn(async (url: string) => {
      if (url === "/sites") return { data: { sites } };
      if (url === "/overview") {
        return {
          data: {
            sites: sites.length,
            reachable: sites.length,
            unreachable: 0,
            hosts: 2,
            online: 1,
            offline: 1,
          },
        };
      }
      return { data: { hosts: [] } };
    }),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };
}

describe(`${manifest.id} activate`, () => {
  it("adds the account switcher, the sites tab and its rail item", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.slot("shell.accountSwitcher")).toEqual([
      "sync.accountSwitcher",
    ]);
    expect(rendered.registered.tabs()).toEqual(["sites", "site_terminal"]);
    expect(rendered.registered.railItems().map((item) => item.id)).toEqual([
      "sites",
    ]);
  });

  it("shows an empty list of sites", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api([]) as never,
    });
    rendered.renderTab("sites");
    expect(await screen.findByText("No remote sites")).toBeTruthy();
  });

  it("lists sites with the roll up", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api([site]) as never,
    });
    rendered.renderTab("sites");
    await waitFor(() => expect(screen.getByText("Berlin")).toBeTruthy());
    expect(screen.getAllByText("Connected").length).toBeGreaterThan(1);
    expect(screen.getByText(/2 hosts/)).toBeTruthy();
  });
});
