import express from "express";
import path from "node:path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockCtx,
  createTestDb,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import { EngineManager } from "../../src/backend/engines.js";
import { createAccountsRouter } from "../../src/backend/accounts-routes.js";
import { webAccounts } from "../../src/backend/tables.js";
import { Side, createHost } from "./fake-host.js";

const log = { error: vi.fn(), warn: vi.fn() };
const RING = "a".repeat(64);

let db: TestDb;
let side: Side;
let http: Server;
let url: string;

function cookies(req: express.Request, _res: unknown, next: () => void) {
  const jar: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name) jar[name] = rest.join("=");
  }
  (req as express.Request & { cookies: Record<string, string> }).cookies = jar;
  next();
}

async function ask(
  method: string,
  route: string,
  options: { as?: string; jwt?: string; ring?: string; body?: unknown } = {},
) {
  side.currentUser = options.as ?? "alice";
  const cookie = [
    options.jwt ? `jwt=${options.jwt}` : "",
    options.ring ? `termix_accounts=${options.ring}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  const response = await fetch(`${url}/sync/web/accounts${route}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return {
    status: response.status,
    body: await response.json(),
    setCookies: response.headers.getSetCookie(),
  };
}

beforeEach(async () => {
  db = await createTestDb(path.resolve(import.meta.dirname, "../.."));
  for (const id of ["alice", "bob"]) {
    db.sqlite.exec(
      `INSERT INTO users (id, username) VALUES ('${id}', '${id}')`,
    );
  }
  const mock = createMockCtx({
    pluginId: "sync",
    capabilities: ["secrets:own", "db:own"],
    db: db.database,
  });
  const webTable = await mock.ctx.db.define(webAccounts);

  side = new Side({ embedded: false });
  side.validTokens.set("alice-token", {
    userId: "alice",
    sessionId: "s-alice",
  });
  side.validTokens.set("bob-token", { userId: "bob", sessionId: "s-bob" });
  const host = createHost(side);
  const app = express();
  app.use(express.json());
  app.use(cookies);
  app.use(
    "/sync",
    createAccountsRouter({
      ctx: mock.ctx,
      host,
      manager: new EngineManager(host, log),
      webTable,
      log,
    }),
  );
  http = await new Promise<Server>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => http.close(resolve));
  await db.close();
});

describe("accounts in one browser", () => {
  it("has no ring until a second account is started", async () => {
    const { body } = await ask("GET", "", { jwt: "alice-token" });
    expect(body).toEqual({ ring: false, accounts: [] });
  });

  it("keeps the current session and clears the sign in cookie", async () => {
    const { body, setCookies } = await ask("POST", "/begin", {
      jwt: "alice-token",
    });
    expect(body).toEqual({ success: true });
    expect(setCookies.some((c) => c.startsWith("termix_accounts="))).toBe(true);
    expect(side.cookies.termix_accounts).toMatch(/^[a-f0-9]{64}$/);
    expect(side.cookies.jwt).toBeUndefined();
    const stored = db.sqlite
      .prepare("SELECT token FROM p_sync_web_accounts")
      .all() as Array<{ token: string }>;
    expect(stored).toHaveLength(1);
    expect(stored[0].token).not.toContain("alice-token");
  });

  it("lists both accounts after the second signs in", async () => {
    await ask("POST", "/attach", {
      as: "alice",
      jwt: "alice-token",
      ring: RING,
    });
    await ask("POST", "/attach", { as: "bob", jwt: "bob-token", ring: RING });
    const { body } = await ask("GET", "", {
      as: "bob",
      jwt: "bob-token",
      ring: RING,
    });
    expect(body.ring).toBe(true);
    expect(body.accounts).toEqual([
      { userId: "alice", username: "name-alice", current: false },
      { userId: "bob", username: "name-bob", current: true },
    ]);
  });

  it("does nothing on attach without a ring", async () => {
    const { body } = await ask("POST", "/attach", { jwt: "alice-token" });
    expect(body).toEqual({ attached: false });
  });

  it("switches to the other account and keeps the one it leaves", async () => {
    await ask("POST", "/attach", {
      as: "alice",
      jwt: "alice-token",
      ring: RING,
    });
    const { status } = await ask("POST", "/switch", {
      as: "bob",
      jwt: "bob-token",
      ring: RING,
      body: { userId: "alice" },
    });
    expect(status).toBe(200);
    expect(side.cookies.jwt).toBe("alice-token");
    const users = db.sqlite
      .prepare("SELECT owner_id FROM p_sync_web_accounts ORDER BY owner_id")
      .all() as Array<{ owner_id: string }>;
    expect(users.map((row) => row.owner_id)).toEqual(["alice", "bob"]);
  });

  it("drops an account whose session ended", async () => {
    await ask("POST", "/attach", {
      as: "alice",
      jwt: "alice-token",
      ring: RING,
    });
    side.validTokens.delete("alice-token");
    const { body } = await ask("GET", "", {
      as: "bob",
      jwt: "bob-token",
      ring: RING,
    });
    expect(body.accounts).toEqual([]);
    const switched = await ask("POST", "/switch", {
      as: "bob",
      jwt: "bob-token",
      ring: RING,
      body: { userId: "alice" },
    });
    expect(switched.status).toBe(404);
  });

  it("will not switch to an account that was never signed in here", async () => {
    await ask("POST", "/attach", {
      as: "alice",
      jwt: "alice-token",
      ring: RING,
    });
    const { status } = await ask("POST", "/switch", {
      as: "alice",
      jwt: "alice-token",
      ring: RING,
      body: { userId: "bob" },
    });
    expect(status).toBe(404);
  });

  it("ignores a ring id that is not one of ours", async () => {
    const { body } = await ask("GET", "", {
      jwt: "alice-token",
      ring: "not-a-ring",
    });
    expect(body.ring).toBe(false);
  });

  it("ends the session when an account is signed out of the browser", async () => {
    await ask("POST", "/attach", {
      as: "alice",
      jwt: "alice-token",
      ring: RING,
    });
    await ask("DELETE", "/alice", { as: "bob", jwt: "bob-token", ring: RING });
    expect(side.revoked).toEqual(["s-alice"]);
    const rows = db.sqlite.prepare("SELECT * FROM p_sync_web_accounts").all();
    expect(rows).toEqual([]);
  });

  it("answers 404 on the desktop app", async () => {
    const embedded = new Side({ embedded: true, serverUrl: () => url });
    const host = createHost(embedded);
    const app = express();
    app.use(express.json());
    app.use(cookies);
    app.use(
      "/sync",
      createAccountsRouter({
        ctx: {} as never,
        host,
        manager: new EngineManager(host, log),
        webTable: {},
        log,
      }),
    );
    const other = await new Promise<Server>((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server));
    });
    const response = await fetch(
      `http://127.0.0.1:${(other.address() as AddressInfo).port}/sync/web/accounts`,
    );
    expect(response.status).toBe(404);
    await new Promise((resolve) => other.close(resolve));
  });
});
