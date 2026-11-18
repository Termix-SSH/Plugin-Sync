import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMockCtx, createTestDb } from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";

const manifest = manifestJson as unknown as PluginManifest;

const passThrough = () => (_req: unknown, _res: unknown, next: () => void) =>
  next();

describe("sync activate", () => {
  it("starts in a plugin process with every provider it registers", async () => {
    const db = await createTestDb(path.resolve(import.meta.dirname, "../.."));
    const mock = createMockCtx({
      sandbox: true,
      db: db.database,
      manifest,
      capabilities: manifest.capabilities,
      syncHost: {
        embedded: false,
        info: { appName: async () => "Termix", version: () => "26.11.2" },
        links: { list: async () => [] } as never,
        sessions: {
          middleware: passThrough,
          desktopOnly: passThrough,
        } as never,
        desktop: { deviceName: () => "here" } as never,
      },
    });
    await activate(mock.ctx);
    expect(mock.hostLockProviders).toHaveLength(1);
    expect(mock.hostLockProviders[0].lockedHosts?.()).toEqual([]);
  });
});
