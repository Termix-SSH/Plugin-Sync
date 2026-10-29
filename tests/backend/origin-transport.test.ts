import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { SyncLinkInfo } from "@termix-ssh/plugin-sdk/backend";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDefaultOriginReader,
  createOriginTransport,
  originRelayUrl,
} from "../../src/backend/origin-transport.js";

function link(overrides: Partial<SyncLinkInfo> = {}): SyncLinkInfo {
  return {
    id: 1,
    userId: "local-1",
    serverUrl: "http://server.test",
    serverName: null,
    serverVersion: null,
    sessionToken: "tok",
    customHeaders: [],
    basicAuth: null,
    allowInvalidCertificate: false,
    clientCert: null,
    remoteUserId: null,
    remoteUsername: null,
    ...overrides,
  } as SyncLinkInfo;
}

const host = {
  id: 4,
  ip: "10.0.0.4",
  port: 22,
  userId: "local-1",
  syncId: "sync-4",
  connectionOrigin: null,
};

describe("origin transport", () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = null;
  });

  it("builds the relay url with the sync id", () => {
    expect(originRelayUrl("https://a.test/", "x y")).toBe(
      "wss://a.test/plugin-ws/core/ssh-relay?syncId=x+y",
    );
  });

  it("claims only linked hosts whose origin is the server", async () => {
    let remoteDefault = false;
    const transport = createOriginTransport({
      links: async () => [link()],
      defaultRemote: () => remoteDefault,
    });
    await transport.refresh();

    expect(transport.claims(4)).toBe(false);
    expect(transport.claims(4, host)).toBe(false);
    expect(transport.claims(4, { ...host, connectionOrigin: "remote" })).toBe(
      true,
    );
    remoteDefault = true;
    expect(transport.claims(4, host)).toBe(true);
    expect(transport.claims(4, { ...host, connectionOrigin: "local" })).toBe(
      false,
    );
    expect(transport.claims(4, { ...host, localOnly: true })).toBe(false);
    expect(transport.claims(4, { ...host, syncId: null })).toBe(false);
    expect(transport.claims(4, { ...host, userId: "someone-else" })).toBe(
      false,
    );
  });

  it("skips links that have no session", async () => {
    const transport = createOriginTransport({
      links: async () => [link({ sessionToken: null })],
      defaultRemote: () => true,
    });
    await transport.refresh();
    expect(transport.claims(4, host)).toBe(false);
  });

  it("opens the relay with the link's token and headers", async () => {
    const seen: { url?: string; protocol?: string; header?: string } = {};
    server = http.createServer();
    const wss = new WebSocketServer({
      server,
      handleProtocols: (protocols) => protocols.values().next().value ?? false,
    });
    wss.on("connection", (socket, request) => {
      seen.url = request.url;
      seen.protocol = String(request.headers["sec-websocket-protocol"]);
      seen.header = String(request.headers["x-access"]);
      socket.on("message", (data) => socket.send(data));
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;

    const transport = createOriginTransport({
      links: async () => [
        link({
          serverUrl: `http://127.0.0.1:${port}`,
          customHeaders: [{ name: "X-Access", value: "yes" }],
        }),
      ],
      defaultRemote: () => true,
    });
    await transport.refresh();
    const stream = await transport.open(host);
    const echoed = new Promise<string>((resolve) =>
      stream.once("data", (data: Buffer) => resolve(data.toString())),
    );
    stream.write("SSH-2.0-x\r\n");
    expect(await echoed).toBe("SSH-2.0-x\r\n");
    expect(seen.url).toBe("/plugin-ws/core/ssh-relay?syncId=sync-4");
    expect(seen.protocol).toBe("termix.jwt.tok");
    expect(seen.header).toBe("yes");
    stream.destroy();
    wss.close();
  });
});

describe("desktop default origin", () => {
  it("reads the settings file and caches it briefly", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-origin-"));
    const file = path.join(dir, "desktop-settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ defaultConnectionOrigin: "remote" }),
    );
    let time = 0;
    const read = createDefaultOriginReader(file, () => time);
    expect(read()).toBe(true);
    fs.writeFileSync(
      file,
      JSON.stringify({ defaultConnectionOrigin: "local" }),
    );
    expect(read()).toBe(true);
    time = 10_000;
    expect(read()).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is local without a settings file", () => {
    expect(createDefaultOriginReader(null)()).toBe(false);
    expect(createDefaultOriginReader("/nope/settings.json")()).toBe(false);
  });
});
