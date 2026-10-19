import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineManager } from "../../src/backend/engines.js";
import { createServerRouter } from "../../src/backend/server-routes.js";
import { createClientRouter } from "../../src/backend/client-routes.js";
import { createAccountsRouter } from "../../src/backend/accounts-routes.js";
import { DESKTOP_USER, SERVER_USER, Side, createHost } from "./fake-host.js";

const log = { error: vi.fn(), warn: vi.fn() };

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const http = app.listen(0, "127.0.0.1", () => resolve(http));
  });
}

const urlOf = (http: Server) =>
  `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

async function startServer() {
  const side = new Side({ embedded: false });
  const app = express();
  app.use(express.json());
  app.use(
    "/sync",
    createServerRouter(
      createHost(side),
      { touch: async () => {}, list: async () => [] },
      log,
    ),
  );
  const http = await listen(app);
  return { side, http, url: urlOf(http) };
}

describe("two linked servers on one desktop", () => {
  let home: Awaited<ReturnType<typeof startServer>>;
  let work: Awaited<ReturnType<typeof startServer>>;
  let desktop: Side;
  let manager: EngineManager;
  let accountsHttp: Server;
  let accountsUrl: string;

  beforeEach(async () => {
    home = await startServer();
    work = await startServer();
    desktop = new Side({ embedded: true, serverUrl: () => home.url });
    const host = createHost(desktop);
    manager = new EngineManager(host, log);
    const app = express();
    app.use(express.json());
    app.use(
      "/sync",
      createAccountsRouter({
        ctx: {} as never,
        host,
        manager,
        webTable: {},
        log,
      }),
    );
    app.use(
      "/sync",
      createClientRouter(host, manager, async () => "device-test-0001", log),
    );
    accountsHttp = await listen(app);
    accountsUrl = urlOf(accountsHttp);

    home.side.put(SERVER_USER, "h1", "home host");
    work.side.put(SERVER_USER, "w1", "work host");
    desktop.accountIds = [DESKTOP_USER, "account-2"];
    const links = createHost(desktop).links;
    await links.create({
      userId: DESKTOP_USER,
      serverUrl: home.url,
      sessionToken: "home-token",
    });
    await links.create({
      userId: "account-2",
      serverUrl: work.url,
      sessionToken: "work-token",
    });
  });

  afterEach(async () => {
    manager.stopAll();
    for (const http of [home.http, work.http, accountsHttp]) {
      await new Promise((resolve) => http.close(resolve));
    }
  });

  it("keeps each server's data in its own account", async () => {
    await manager.startAll();
    await manager.engineFor(DESKTOP_USER).syncNow();
    await manager.engineFor("account-2").syncNow();
    expect(desktop.names(DESKTOP_USER)).toEqual({ h1: "home host" });
    expect(desktop.names("account-2")).toEqual({ w1: "work host" });
  });

  it("never sends one account's edits to the other server", async () => {
    await manager.engineFor(DESKTOP_USER).syncNow();
    await manager.engineFor("account-2").syncNow();
    desktop.put(DESKTOP_USER, "h2", "new at home");
    desktop.put("account-2", "w2", "new at work");
    await manager.engineFor(DESKTOP_USER).syncNow();
    await manager.engineFor("account-2").syncNow();
    expect(home.side.names(SERVER_USER)).toEqual({
      h1: "home host",
      h2: "new at home",
    });
    expect(work.side.names(SERVER_USER)).toEqual({
      w1: "work host",
      w2: "new at work",
    });
  });

  it("only hands the active account's server to the app", async () => {
    await manager.engineFor("account-2").syncNow();
    expect(
      desktop.proxy.some(
        (link) => (link as { serverUrl: string })?.serverUrl === work.url,
      ),
    ).toBe(false);
    await manager.engineFor(DESKTOP_USER).syncNow();
    expect(
      desktop.proxy.some(
        (link) => (link as { serverUrl: string })?.serverUrl === home.url,
      ),
    ).toBe(true);
  });

  it("lists the accounts with their servers", async () => {
    const body = await (await fetch(`${accountsUrl}/sync/accounts`)).json();
    expect(body.accounts.map((a: { id: string }) => a.id)).toEqual([
      DESKTOP_USER,
      "account-2",
    ]);
    expect(body.accounts[1]).toMatchObject({
      active: false,
      linked: true,
      serverUrl: work.url,
    });
    expect(body.accounts[0].active).toBe(true);
  });

  it("switches the active account and gives the app that account's server", async () => {
    const response = await fetch(`${accountsUrl}/sync/accounts/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "account-2" }),
    });
    expect(response.status).toBe(200);
    // The old session must not stay in place, or the app keeps the old user.
    const body = await response.json();
    expect(body.token).toBe(desktop.sessions.at(-1));
    expect(body.token).toContain("account-2");
    expect(desktop.activeUser).toBe("account-2");
    expect((desktop.proxy.at(-1) as { serverUrl: string }).serverUrl).toBe(
      work.url,
    );
  });

  it("refuses to switch to an account that does not exist", async () => {
    const response = await fetch(`${accountsUrl}/sync/accounts/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "nope" }),
    });
    expect(response.status).toBe(404);
    expect(desktop.activeUser).toBe(DESKTOP_USER);
  });

  it("adds an empty account", async () => {
    const body = await (
      await fetch(`${accountsUrl}/sync/accounts`, { method: "POST" })
    ).json();
    expect(desktop.accountIds).toContain(body.id);
    expect(desktop.links.has(body.id)).toBe(false);
  });

  it("will not remove the active account, but removes another and unlinks it", async () => {
    const active = await fetch(`${accountsUrl}/sync/accounts/${DESKTOP_USER}`, {
      method: "DELETE",
    });
    expect(active.status).toBe(400);

    const other = await fetch(`${accountsUrl}/sync/accounts/account-2`, {
      method: "DELETE",
    });
    expect(other.status).toBe(200);
    expect(desktop.accountIds).toEqual([DESKTOP_USER]);
    expect(desktop.links.has("account-2")).toBe(false);
    expect(manager.has("account-2")).toBe(false);
  });

  it("links the account the request is made as", async () => {
    desktop.currentUser = "account-2";
    desktop.links.delete("account-2");
    const response = await fetch(`${accountsUrl}/sync/link/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverUrl: work.url, token: "login" }),
    });
    expect(response.status).toBe(200);
    expect(desktop.links.get("account-2")?.serverUrl).toBe(work.url);
    expect(desktop.links.get(DESKTOP_USER)?.serverUrl).toBe(home.url);
  });
});
