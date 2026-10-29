import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncEngine } from "../../src/backend/engine.js";
import { EngineManager } from "../../src/backend/engines.js";
import { createServerRouter } from "../../src/backend/server-routes.js";
import { createClientRouter } from "../../src/backend/client-routes.js";
import { DESKTOP_USER, SERVER_USER, Side, createHost } from "./fake-host.js";

const log = { error: vi.fn(), warn: vi.fn() };
const touch = vi.fn(async () => {});

let server: Side;
let desktop: Side;
let serverHttp: Server;
let serverUrl: string;
let engine: SyncEngine;
let manager: EngineManager;
let clientHttp: Server;
let clientUrl: string;

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const http = app.listen(0, "127.0.0.1", () => resolve(http));
  });
}

const urlOf = (http: Server) =>
  `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

beforeEach(async () => {
  vi.clearAllMocks();
  server = new Side({ embedded: false });
  const serverApp = express();
  serverApp.use(express.json());
  serverApp.use(
    "/sync",
    createServerRouter(
      createHost(server),
      { touch, list: async () => [] },
      log,
    ),
  );
  serverHttp = await listen(serverApp);
  serverUrl = urlOf(serverHttp);

  desktop = new Side({ embedded: true, serverUrl: () => serverUrl });
  const host = createHost(desktop);
  manager = new EngineManager(host, log);
  engine = manager.engineFor(DESKTOP_USER);
  const clientApp = express();
  clientApp.use(express.json());
  clientApp.use(
    "/sync",
    createClientRouter(host, manager, async () => "device-test-0001", log),
  );
  clientHttp = await listen(clientApp);
  clientUrl = urlOf(clientHttp);
});

afterEach(async () => {
  manager.stopAll();
  await new Promise((resolve) => serverHttp.close(resolve));
  await new Promise((resolve) => clientHttp.close(resolve));
});

async function link() {
  await createHost(desktop).links.create({
    userId: DESKTOP_USER,
    serverUrl,
    sessionToken: "desktop-token",
  });
}

describe("linking a desktop", () => {
  it("merges both sides", async () => {
    server.put(SERVER_USER, "a", "from server");
    desktop.put(DESKTOP_USER, "c", "from desktop");
    await link();
    await engine.syncNow();
    expect(desktop.names(DESKTOP_USER)).toEqual({
      a: "from server",
      c: "from desktop",
    });
    expect(server.names(SERVER_USER)).toEqual({
      a: "from server",
      c: "from desktop",
    });
    expect(desktop.link?.status).toBe("idle");
    expect(desktop.pluginsMirrored).toBe(1);
  });

  it("adopts the server's version of rows both sides already have", async () => {
    server.put(SERVER_USER, "a", "server name");
    desktop.put(DESKTOP_USER, "a", "desktop name");
    await link();
    await engine.syncNow();
    expect(desktop.names(DESKTOP_USER)).toEqual({ a: "server name" });
    expect(desktop.conflicts.get(DESKTOP_USER) ?? []).toEqual([]);
  });
});

describe("after linking", () => {
  async function linked() {
    server.put(SERVER_USER, "a", "one");
    server.put(SERVER_USER, "b", "two");
    await link();
    await engine.syncNow();
  }

  it("sends edits and deletes both ways", async () => {
    await linked();
    desktop.put(DESKTOP_USER, "a", "one edited");
    desktop.remove(DESKTOP_USER, "b");
    server.put(SERVER_USER, "n", "new on server");
    await engine.syncNow();
    expect(desktop.names(DESKTOP_USER)).toEqual({
      a: "one edited",
      n: "new on server",
    });
    expect(server.names(SERVER_USER)).toEqual({
      a: "one edited",
      n: "new on server",
    });
  });

  it("keeps a local edit that lost to a newer server edit", async () => {
    await linked();
    desktop.put(DESKTOP_USER, "a", "local edit");
    server.put(SERVER_USER, "a", "server edit");
    server.reconcile(SERVER_USER);
    await engine.syncNow();
    expect(desktop.names(DESKTOP_USER).a).toBe("server edit");
    const conflicts = desktop.conflicts.get(DESKTOP_USER) ?? [];
    expect(conflicts).toHaveLength(1);
    expect(JSON.parse(conflicts[0].localRow).name).toBe("local edit");
  });

  it("sends a row again as new when the server lost its record", async () => {
    await linked();
    for (const k of [...server.recordsOf(SERVER_USER).keys()])
      if (k.endsWith("a")) server.recordsOf(SERVER_USER).delete(k);
    server.rowsOf(SERVER_USER).delete("a");
    desktop.put(DESKTOP_USER, "a", "edited after a restore");
    await engine.syncNow();
    await engine.syncNow();
    expect(server.names(SERVER_USER).a).toBe("edited after a restore");
  });

  it("does not let one refused change hold up the rest", async () => {
    await linked();
    server.refuse.add("bad");
    desktop.put(DESKTOP_USER, "bad", "refused");
    desktop.put(DESKTOP_USER, "good", "taken");
    await engine.syncNow();
    expect(server.names(SERVER_USER).good).toBe("taken");
    expect(server.names(SERVER_USER).bad).toBeUndefined();
    const errors =
      await createHost(desktop).replica.records.listErrors(DESKTOP_USER);
    expect(errors.map((record) => record.syncId)).toEqual(["bad"]);
  });

  it("leaves a switched off kind of data alone", async () => {
    await linked();
    await createHost(desktop).links.update({ disabledTypes: ["things"] });
    desktop.put(DESKTOP_USER, "local", "stays here");
    server.put(SERVER_USER, "remote", "stays there");
    await engine.syncNow();
    expect(server.names(SERVER_USER).local).toBeUndefined();
    expect(desktop.names(DESKTOP_USER).remote).toBeUndefined();
  });
});

describe("when the server cannot be used", () => {
  it("marks the link signed out and alerts once", async () => {
    await link();
    server.put(SERVER_USER, "a", "x");
    await createHost(desktop).links.update({ sessionToken: "x" });
    // A server that answers 401 to the refresh call.
    const original = serverHttp.listeners("request")[0] as (
      ...args: unknown[]
    ) => void;
    serverHttp.removeAllListeners("request");
    serverHttp.on("request", (_req, res) => {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Session revoked" }));
    });
    await engine.syncNow();
    await engine.syncNow();
    expect(desktop.link?.status).toBe("signed_out");
    expect(desktop.alerts).toHaveLength(1);
    serverHttp.removeAllListeners("request");
    serverHttp.on("request", original);
  });

  it("goes offline and keeps the error", async () => {
    await link();
    desktop.offline = true;
    await engine.syncNow();
    expect(desktop.link?.status).toBe("offline");
    expect(desktop.link?.lastError).toBe("offline");
    engine.stop();
  });
});

describe("server routes", () => {
  it("says it is a Termix server with the protocol version", async () => {
    const body = await (await fetch(`${serverUrl}/sync/v2/info`)).json();
    expect(body).toMatchObject({ termix: true, protocol: 1 });
    expect(body.clientTypes).toContain("master");
  });

  it("trades the login session for a device session and records the device", async () => {
    const response = await fetch(`${serverUrl}/sync/v2/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceName: "Phone",
        clientType: "mobile",
        deviceId: "device-abcdef-01",
      }),
    });
    const body = await response.json();
    expect(body.token).toMatch(/^desktop-session-/);
    expect(body.user).toEqual({
      id: SERVER_USER,
      username: `name-${SERVER_USER}`,
    });
    expect(server.revoked).toEqual(["login-session"]);
    expect(touch).toHaveBeenCalledWith(SERVER_USER, {
      clientType: "mobile",
      deviceId: "device-abcdef-01",
      name: "Phone",
    });
  });

  it("treats an unknown client type as a desktop", async () => {
    await fetch(`${serverUrl}/sync/v2/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientType: "toaster", deviceId: "x" }),
    });
    expect(touch).toHaveBeenCalledWith(SERVER_USER, {
      clientType: "desktop",
      deviceId: null,
      name: "Termix Desktop",
    });
  });

  it.each(["cursor=abc", "cursor=-1", "cursor=1.5", "limit=1.5", "limit=-5"])(
    "rejects the malformed query %s",
    async (query) => {
      const response = await fetch(`${serverUrl}/sync/v2/changes?${query}`);
      expect(response.status).toBe(400);
    },
  );

  it("rejects a push without ops", async () => {
    const response = await fetch(`${serverUrl}/sync/v2/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it("maps many sync ids to this server's ids at once", async () => {
    const lookup = (body: unknown) =>
      fetch(`${serverUrl}/sync/v2/ids`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const response = await lookup({
      hosts: ["host-1", "host-2"],
      things: ["own-a", "other"],
      unknown: ["own-b"],
    });
    expect(await response.json()).toEqual({
      hosts: { "host-1": 11 },
      things: { "own-a": 7 },
      unknown: {},
    });
    expect((await lookup({ hosts: "x" })).status).toBe(400);
    expect(
      (await lookup({ hosts: Array.from({ length: 1001 }, (_, i) => `h${i}`) }))
        .status,
    ).toBe(400);
  });

  it("refreshes a session that ends soon and keeps the old one for a moment", async () => {
    const refresh = async () =>
      (
        await (
          await fetch(`${serverUrl}/sync/v2/session/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).json()
      ).token as string;
    const token = await refresh();
    expect(token).toMatch(/^desktop-session-/);
    // A client that lost the answer asks again and gets the same token.
    expect(await refresh()).toBe(token);
    expect(server.revoked).toEqual([]);
  });
});

describe("desktop routes", () => {
  const post = (path: string, body: unknown = {}, method = "POST") =>
    fetch(`${clientUrl}/sync/link/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("reports an unlinked desktop", async () => {
    const body = await (await fetch(`${clientUrl}/sync/link/status`)).json();
    expect(body.linked).toBe(false);
  });

  it("probes a server and says what is wrong with a bad address", async () => {
    expect(
      await (await post("probe", { serverUrl: "ftp://x" })).json(),
    ).toEqual({
      ok: false,
      problem: "invalid_url",
    });
    const ok = await (await post("probe", { serverUrl })).json();
    expect(ok).toMatchObject({ ok: true, name: "Test", version: "26.10.3" });
  });

  it("says when a Termix server has the Sync plugin off", async () => {
    const termix = express();
    termix.get("/users/auth/methods", (_req, res) => {
      res.json({ methods: [] });
    });
    const other = express();
    const termixHttp = await listen(termix);
    const otherHttp = await listen(other);
    try {
      expect(
        await (await post("probe", { serverUrl: urlOf(termixHttp) })).json(),
      ).toEqual({ ok: false, problem: "sync_off" });
      expect(
        await (await post("probe", { serverUrl: urlOf(otherHttp) })).json(),
      ).toMatchObject({ ok: false, problem: "not_termix" });
    } finally {
      await new Promise((resolve) => termixHttp.close(resolve));
      await new Promise((resolve) => otherHttp.close(resolve));
    }
  });

  it("links with a login session, syncs, and unlinks keeping the data", async () => {
    desktop.put(DESKTOP_USER, "mine", "local row");
    const linked = await (
      await post("complete", { serverUrl, token: "login-token", mode: "merge" })
    ).json();
    expect(linked.linked).toBe(true);
    expect(desktop.link?.sessionToken).toMatch(/^desktop-session-/);
    expect(desktop.link?.remoteUsername).toBe(`name-${SERVER_USER}`);

    await post("sync");
    expect(server.names(SERVER_USER)).toEqual({ mine: "local row" });

    const unlinked = await (await post("unlink", { keepData: true })).json();
    expect(unlinked.linked).toBe(false);
    expect(Object.values(desktop.names(DESKTOP_USER))).toEqual(["local row"]);
    expect(Object.keys(desktop.names(DESKTOP_USER))[0]).toMatch(/^new-/);
    expect(desktop.link).toBeNull();
  });

  it("deletes the synced data when unlinking without keeping it", async () => {
    desktop.put(DESKTOP_USER, "mine", "local row");
    await post("complete", { serverUrl, token: "login-token" });
    await post("unlink", { keepData: false });
    expect(desktop.names(DESKTOP_USER)).toEqual({});
  });

  it("replaces local data when asked", async () => {
    desktop.put(DESKTOP_USER, "mine", "local row");
    server.put(SERVER_USER, "theirs", "server row");
    await post("complete", {
      serverUrl,
      token: "login-token",
      mode: "replace",
    });
    await post("sync");
    expect(desktop.names(DESKTOP_USER)).toEqual({ theirs: "server row" });
  });

  it("restores a lost local edit from a conflict", async () => {
    server.put(SERVER_USER, "a", "one");
    await post("complete", { serverUrl, token: "login-token" });
    await post("sync");
    desktop.put(DESKTOP_USER, "a", "local edit");
    server.put(SERVER_USER, "a", "server edit");
    await post("sync");
    const { conflicts } = await (
      await fetch(`${clientUrl}/sync/link/conflicts`)
    ).json();
    expect(conflicts).toHaveLength(1);
    await post(`conflicts/${conflicts[0].id}`, { keep: "mine" });
    expect(desktop.names(DESKTOP_USER).a).toBe("local edit");
  });

  it("settles every conflict at once", async () => {
    server.put(SERVER_USER, "a", "one");
    server.put(SERVER_USER, "b", "one");
    await post("complete", { serverUrl, token: "login-token" });
    await post("sync");
    desktop.put(DESKTOP_USER, "a", "local a");
    desktop.put(DESKTOP_USER, "b", "local b");
    server.put(SERVER_USER, "a", "server a");
    server.put(SERVER_USER, "b", "server b");
    await post("sync");
    expect(desktop.conflicts.get(DESKTOP_USER)).toHaveLength(2);
    await post("conflicts", { keep: "mine" });
    expect(desktop.names(DESKTOP_USER)).toMatchObject({
      a: "local a",
      b: "local b",
    });
    expect(desktop.conflicts.get(DESKTOP_USER) ?? []).toEqual([]);
  });

  it("keeps proxy secrets when settings are saved with blanks", async () => {
    await post("complete", {
      serverUrl,
      token: "login-token",
      customHeaders: [{ name: "X-Key", value: "secret" }],
    });
    await post(
      "settings",
      { customHeaders: [{ name: "X-Key", value: "" }] },
      "PUT",
    );
    expect(desktop.link?.customHeaders).toEqual([
      { name: "X-Key", value: "secret" },
    ]);
  });

  it("saves a client certificate and never sends the file back", async () => {
    const clientCert = { pfx: "UEZY", passphrase: "pw", name: "me.pfx" };
    await post("complete", { serverUrl, token: "login-token", clientCert });
    expect(desktop.link?.clientCert).toEqual(clientCert);
    const status = await (await fetch(`${clientUrl}/sync/link/status`)).json();
    expect(status.clientCert).toEqual({
      name: "me.pfx",
      pfx: "",
      passphrase: "",
      set: true,
    });
    await post("settings", { clientCert: { pfx: "", passphrase: "" } }, "PUT");
    expect(desktop.link?.clientCert).toEqual(clientCert);
    await post("settings", { clientCert: null }, "PUT");
    expect(desktop.link?.clientCert).toBeNull();
  });

  it("only gives the linked session when signed in", async () => {
    expect(
      await (await fetch(`${clientUrl}/sync/link/session`)).json(),
    ).toEqual({
      serverUrl: null,
      token: null,
    });
    await post("complete", { serverUrl, token: "login-token" });
    const session = await (
      await fetch(`${clientUrl}/sync/link/session`)
    ).json();
    expect(session.serverUrl).toBe(serverUrl);
    expect(session.token).toMatch(/^desktop-session-/);
  });
});
