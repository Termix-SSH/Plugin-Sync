import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMockCtx,
  createTestDb,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import {
  createDeviceStore,
  type DeviceStore,
} from "../../src/backend/devices.js";
import { devices } from "../../src/backend/tables.js";

let db: TestDb;
let store: DeviceStore;

beforeEach(async () => {
  db = await createTestDb(path.resolve(import.meta.dirname, "../.."));
  db.sqlite.exec(
    "INSERT INTO users (id, username) VALUES ('u1', 'u1'), ('u2', 'u2')",
  );
  const mock = createMockCtx({
    pluginId: "sync",
    capabilities: ["db:own"],
    db: db.database,
  });
  store = createDeviceStore(mock.ctx, await mock.ctx.db.define(devices));
});

afterEach(async () => {
  await db.close();
});

describe("devices", () => {
  it("keeps one row per device and updates it when it links again", async () => {
    await store.touch("u1", {
      clientType: "desktop",
      deviceId: "device-0001",
      name: "Laptop",
    });
    await store.touch("u1", {
      clientType: "desktop",
      deviceId: "device-0001",
      name: "Laptop 2",
    });
    expect(await store.list("u1")).toEqual([
      expect.objectContaining({
        deviceId: "device-0001",
        name: "Laptop 2",
        clientType: "desktop",
      }),
    ]);
  });

  it("does not keep a client without a device id", async () => {
    await store.touch("u1", { clientType: "cli", deviceId: null, name: "CLI" });
    expect(await store.list("u1")).toEqual([]);
  });

  it("only lists the account's own devices", async () => {
    await store.touch("u1", {
      clientType: "mobile",
      deviceId: "device-0001",
      name: "Phone",
    });
    await store.touch("u2", {
      clientType: "master",
      deviceId: "device-0002",
      name: "Master",
    });
    expect((await store.list("u1")).map((d) => d.name)).toEqual(["Phone"]);
    expect((await store.list("u2")).map((d) => d.clientType)).toEqual([
      "master",
    ]);
  });
});
