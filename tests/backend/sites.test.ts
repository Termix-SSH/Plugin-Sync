import express from "express";
import path from "node:path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import { createSites, type Sites } from "../../src/backend/sites.js";
import { createSitesRouter } from "../../src/backend/sites-routes.js";
import { registerSiteTerminal } from "../../src/backend/site-terminal.js";
import { siteHosts, sites as sitesTable } from "../../src/backend/tables.js";
import { Side, createHost } from "./fake-host.js";

const log = { error: vi.fn(), warn: vi.fn() };
const KEY = "tmx_remote_key_123456";

interface Remote {
  http: Server;
  url: string;
  tickets: string[];
  frames: string[];
  authHeaders: string[];
  hosts: Array<Record<string, unknown>>;
  statuses: Record<string, unknown>;
  rejectKey: boolean;
}

async function startRemote(): Promise<Remote> {
  const remote: Remote = {
    http: null as never,
    url: "",
    tickets: [],
    frames: [],
    authHeaders: [],
    hosts: [
      {
        id: 7,
        name: "db1",
        ip: "10.0.0.7",
        port: 22,
        username: "root",
        tags: "prod,db",
        authType: "password",
        credentialId: 3,
        folder: "Prod",
        connectionType: "ssh",
      },
      { id: 8, name: "web1", ip: "10.0.0.8", port: 22, username: "deploy" },
    ],
    statuses: { "7": { status: "online" }, "8": { status: "offline" } },
    rejectKey: false,
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    remote.authHeaders.push(String(req.headers.authorization));
    if (remote.rejectKey) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }
    next();
  });
  app.get("/host/db/host", (_req, res) => res.json(remote.hosts));
  app.get("/host/db/host/:id", (req, res) => {
    const found = remote.hosts.find((h) => String(h.id) === req.params.id);
    if (!found) return res.status(404).json({ error: "Not found" });
    res.json(found);
  });
  app.get("/host/status", (_req, res) => res.json(remote.statuses));
  app.post("/users/ws-ticket/api-key", (_req, res) => {
    const ticket = `ticket-${remote.tickets.length + 1}`;
    remote.tickets.push(ticket);
    res.json({ ticket });
  });
  remote.http = await new Promise<Server>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const wss = new WebSocketServer({ noServer: true });
  remote.http.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${remote.tickets.at(-1)}`) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => {
        const text = data.toString();
        remote.frames.push(text);
        const message = JSON.parse(text);
        if (message.type === "input") {
          ws.send(
            JSON.stringify({ type: "data", data: `echo:${message.data}` }),
          );
        }
      });
    });
  });
  remote.url = `http://127.0.0.1:${(remote.http.address() as AddressInfo).port}`;
  return remote;
}

let db: TestDb;
let mock: MockPluginContext;
let store: Sites;
let remote: Remote;
let app: Server;
let appUrl: string;
let side: Side;

beforeEach(async () => {
  remote = await startRemote();
  db = await createTestDb(path.resolve(import.meta.dirname, "../.."));
  db.sqlite.exec("INSERT INTO users (id, username) VALUES ('admin', 'admin')");
  mock = createMockCtx({
    pluginId: "sync",
    actor: "admin",
    capabilities: [
      "secrets:own",
      "db:own",
      "network:serve",
      "hosts:read",
      "hosts:write",
      "users:impersonate",
    ],
    db: db.database,
    shareableRoles: [{ id: 5, name: "ops", displayName: "Ops" }],
  });
  // The real host rows live in core's table, which the foreign key points at.
  const realCreate = mock.ctx.hosts.create.bind(mock.ctx.hosts);
  const realDelete = mock.ctx.hosts.delete.bind(mock.ctx.hosts);
  vi.spyOn(mock.ctx.hosts, "create").mockImplementation(async (input) => {
    const record = await realCreate(input);
    db.sqlite.prepare("INSERT INTO ssh_data (id) VALUES (?)").run(record.id);
    return record;
  });
  vi.spyOn(mock.ctx.hosts, "delete").mockImplementation(async (hostId) => {
    db.sqlite.prepare("DELETE FROM ssh_data WHERE id = ?").run(hostId);
    return realDelete(hostId);
  });
  side = new Side({ embedded: false });
  const host = createHost(side);
  store = createSites(
    mock.ctx,
    host,
    {
      sites: await mock.ctx.db.define(sitesTable),
      hosts: await mock.ctx.db.define(siteHosts),
    },
    log,
  );
  const express_ = express();
  express_.use(express.json());
  express_.use((req, _res, next) => {
    (req as unknown as { userId: string }).userId = "admin";
    next();
  });
  express_.use(createSitesRouter(mock.ctx, host, store, log));
  app = await new Promise<Server>((resolve) => {
    const server = express_.listen(0, "127.0.0.1", () => resolve(server));
  });
  appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => remote.http.close(resolve));
  await new Promise((resolve) => app.close(resolve));
  await db.close();
});

async function add(name = "Berlin", shareRoles: number[] = []) {
  const response = await fetch(`${appUrl}/sites`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      baseUrl: remote.url,
      apiKey: KEY,
      shareRoles,
    }),
  });
  return { status: response.status, body: await response.json() };
}

const mirrored = () => mock.ctx.hosts.listOwned();

describe("remote sites", () => {
  it("adds a site and keeps the key sealed", async () => {
    const { status, body } = await add();
    expect(status).toBe(200);
    expect(body.site).toMatchObject({
      name: "Berlin",
      status: "ok",
      hostCount: 2,
      ownerId: "admin",
    });
    expect(body.site.apiKey).toBeUndefined();
    expect(remote.authHeaders[0]).toBe(`Bearer ${KEY}`);
    const stored = db.sqlite
      .prepare("SELECT api_key FROM p_sync_sites")
      .get() as { api_key: string };
    expect(stored.api_key).not.toContain(KEY);
  });

  it("mirrors the site's SSH hosts as real hosts in a folder named after it", async () => {
    await add();
    const hosts = await mirrored();
    expect(hosts.map((h) => h.name).sort()).toEqual(["db1", "web1"]);
    const db1 = hosts.find((h) => h.name === "db1")!;
    expect(db1).toMatchObject({
      ip: "10.0.0.7",
      port: 22,
      username: "root",
      folder: "Berlin / Prod",
      connectionType: "ssh",
      enableSsh: false,
      statusCheckEnabled: false,
    });
    expect(hosts.find((h) => h.name === "web1")?.folder).toBe("Berlin");
  });

  it("keeps where a host came from in its own settings", async () => {
    await add();
    const created = vi
      .mocked(mock.ctx.hosts.create)
      .mock.calls.map(([input]) => input)
      .find((input) => input.name === "db1")!;
    expect(created.pluginSettings?.sync).toMatchObject({
      siteId: 1,
      remoteId: 7,
      remoteStatus: "online",
    });
  });

  it("locks a mirrored host and names the site it comes from", async () => {
    await add();
    const db1 = (await mirrored()).find((h) => h.name === "db1")!;
    expect(store.siteNameOf(db1.id)).toBe("Berlin");
    expect(store.siteNameOf(9999)).toBeNull();
  });

  it("leaves out hosts the remote's terminal can't open", async () => {
    remote.hosts.push({
      id: 9,
      name: "desk",
      ip: "10.0.0.9",
      port: 3389,
      connectionType: "rdp",
    });
    await add();
    expect((await mirrored()).map((h) => h.name)).not.toContain("desk");
  });

  it("does not write a host again when nothing changed", async () => {
    const { body } = await add();
    const updates = vi.spyOn(mock.ctx.hosts, "update");
    await store.refresh(body.site.id);
    expect(updates).not.toHaveBeenCalled();
  });

  it("updates a host when the remote changes it", async () => {
    const { body } = await add();
    vi.spyOn(mock.ctx.hosts, "update");
    remote.hosts[0].port = 2222;
    remote.statuses["7"] = { status: "offline" };
    await store.refresh(body.site.id);
    const db1 = (await mirrored()).find((h) => h.name === "db1")!;
    expect(db1.port).toBe(2222);
    const patch = vi.mocked(mock.ctx.hosts.update).mock.calls[0][1];
    expect(patch.pluginSettings?.sync).toMatchObject({
      remoteStatus: "offline",
    });
  });

  it("adds new remote hosts and removes ones that are gone", async () => {
    const { body } = await add();
    remote.hosts.splice(1, 1);
    remote.hosts.push({ id: 10, name: "cache1", ip: "10.0.0.10", port: 22 });
    await store.refresh(body.site.id);
    expect((await mirrored()).map((h) => h.name).sort()).toEqual([
      "cache1",
      "db1",
    ]);
  });

  it("brings back a host that was deleted outside the plugin", async () => {
    const { body } = await add();
    const db1 = (await mirrored()).find((h) => h.name === "db1")!;
    await mock.ctx.hosts.delete(db1.id);
    db.sqlite.prepare("UPDATE p_sync_site_hosts SET signature = NULL").run();
    await store.refresh(body.site.id);
    expect((await mirrored()).map((h) => h.name).sort()).toEqual([
      "db1",
      "web1",
    ]);
  });

  it("shares the hosts with the chosen roles", async () => {
    await add("Berlin", [5]);
    expect(mock.hostShareSets).toHaveLength(2);
    expect(mock.hostShareSets[0].grants).toEqual([
      { target: { type: "role", id: 5 }, permissionLevel: "connect" },
    ]);
  });

  it("moves the hosts when the site is renamed", async () => {
    const { body } = await add();
    await fetch(`${appUrl}/sites/${body.site.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Frankfurt" }),
    });
    expect((await mirrored()).map((h) => h.folder).sort()).toEqual([
      "Frankfurt",
      "Frankfurt / Prod",
    ]);
  });

  it("lists the roles the hosts can be shared with", async () => {
    const roles = await (await fetch(`${appUrl}/roles`)).json();
    expect(roles.roles).toEqual([
      expect.objectContaining({ id: 5, name: "ops" }),
    ]);
  });

  it("will not add the same site twice", async () => {
    await add();
    expect((await add("Again")).status).toBe(409);
  });

  it("needs a name, an address and a key", async () => {
    const response = await fetch(`${appUrl}/sites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", baseUrl: "ftp://nope", apiKey: "" }),
    });
    expect(response.status).toBe(400);
  });

  it("says when the key is refused", async () => {
    remote.rejectKey = true;
    const { body } = await add();
    expect(body.site.status).toBe("error");
    expect(body.site.lastError).toBe("The API key was refused");
  });

  it("keeps the mirrored hosts when the site can't be reached", async () => {
    const { body } = await add();
    remote.rejectKey = true;
    await store.refresh(body.site.id);
    expect(await mirrored()).toHaveLength(2);
  });

  it("rolls up health across sites", async () => {
    await add();
    const overview = await (await fetch(`${appUrl}/overview`)).json();
    expect(overview).toEqual({
      sites: 1,
      reachable: 1,
      unreachable: 0,
      hosts: 2,
      online: 1,
      offline: 1,
    });
    remote.rejectKey = true;
    await store.refreshAll();
    expect((await store.overview()).unreachable).toBe(1);
  });

  it("tries a replaced key straight away", async () => {
    remote.rejectKey = true;
    const { body } = await add();
    remote.rejectKey = false;
    const response = await fetch(`${appUrl}/sites/${body.site.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "tmx_new_key_654321" }),
    });
    expect((await response.json()).site.status).toBe("ok");
    expect(remote.authHeaders.at(-1)).toBe("Bearer tmx_new_key_654321");
  });

  it("removes a site and the hosts it mirrored", async () => {
    const { body } = await add();
    await fetch(`${appUrl}/sites/${body.site.id}`, { method: "DELETE" });
    expect((await (await fetch(`${appUrl}/sites`)).json()).sites).toEqual([]);
    expect(await mirrored()).toEqual([]);
    expect(db.sqlite.prepare("SELECT * FROM p_sync_site_hosts").all()).toEqual(
      [],
    );
  });
});

describe("a session on a remote host", () => {
  it("opens through the remote and only passes frames", async () => {
    const { body } = await add();
    registerSiteTerminal(mock.ctx, store, log);
    const route = mock.wsRoutes.find((r) => r.path === "/site-terminal")!;

    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const received: string[] = [];
    wss.on("connection", async (socket, request) => {
      await (route.handler as Function)({
        userId: "admin",
        request,
        socket,
        clientIp: "127.0.0.1",
        requestOrigin: "http://x",
        isDataUnlocked: () => true,
      });
    });
    await new Promise((resolve) => wss.once("listening", resolve));
    const port = (wss.address() as AddressInfo).port;

    const browser = new WebSocket(
      `ws://127.0.0.1:${port}/?siteId=${body.site.id}&hostId=7&cols=100&rows=30`,
    );
    browser.on("message", (data) => received.push(data.toString()));
    await new Promise((resolve) => browser.once("open", resolve));
    await vi.waitFor(() => expect(remote.frames.length).toBeGreaterThan(0));

    const connect = JSON.parse(remote.frames[0]);
    expect(connect.type).toBe("connectToHost");
    expect(connect.data).toMatchObject({
      cols: 100,
      rows: 30,
      hostConfig: { id: 7, ip: "10.0.0.7", username: "root", credentialId: 3 },
    });
    expect(remote.tickets).toHaveLength(1);

    browser.send(JSON.stringify({ type: "input", data: "ls" }));
    await vi.waitFor(() =>
      expect(received.some((frame) => frame.includes("echo:ls"))).toBe(true),
    );
    browser.send(
      JSON.stringify({ type: "resize", data: { cols: 120, rows: 40 } }),
    );
    browser.send(
      JSON.stringify({
        type: "reconnect_with_credentials",
        data: { password: "pw" },
      }),
    );
    await vi.waitFor(() =>
      expect(
        remote.frames.some((frame) =>
          frame.includes("reconnect_with_credentials"),
        ),
      ).toBe(true),
    );
    const retry = JSON.parse(
      remote.frames.find((frame) =>
        frame.includes("reconnect_with_credentials"),
      )!,
    );
    expect(retry.data).toMatchObject({
      cols: 120,
      rows: 40,
      password: "pw",
      hostConfig: { id: 7 },
    });
    browser.close();
    await new Promise((resolve) => wss.close(resolve));
  });

  it("refuses a user without the permission", async () => {
    const guarded = createMockCtx({
      pluginId: "sync",
      capabilities: ["network:serve"],
      permissions: [],
    });
    registerSiteTerminal(guarded.ctx, store, log);
    const route = guarded.wsRoutes.find((r) => r.path === "/site-terminal")!;
    const frames: string[] = [];
    const closed: number[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send: (data: string) => frames.push(data),
      close: (code: number) => closed.push(code),
      on: () => {},
      once: () => {},
    };
    await (route.handler as Function)({
      userId: "nobody",
      request: { url: "/?siteId=1&hostId=1" },
      socket,
    });
    expect(closed).toEqual([1008]);
    expect(remote.tickets).toEqual([]);
  });
});
