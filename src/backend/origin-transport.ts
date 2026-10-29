/**
 * On the desktop, a host whose connections start on the server (its own
 * Connection Origin, or the desktop default) is reached through the linked
 * server's SSH relay. The terminal already goes to the server itself; this
 * covers every other plugin that opens its own SSH connection here (file
 * manager, metrics, tmux monitor, docker and so on). The SSH login still
 * happens on this machine, only the bytes pass through the server.
 *
 * Termix 26.10.6 and later tell transports the host's owner, sync id and
 * origin. Older cores do not, and then nothing is claimed.
 */

import fs from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import WebSocket, { createWebSocketStream } from "ws";
import type {
  PluginContext,
  PluginSyncHost,
  SyncLinkInfo,
} from "@termix-ssh/plugin-sdk/backend";

const RELAY_PATH = "/plugin-ws/core/ssh-relay";
const JWT_PROTOCOL_PREFIX = "termix.jwt.";
const LINKS_REFRESH_MS = 30_000;
const SETTINGS_CACHE_MS = 5_000;

export interface OriginHost {
  id: number;
  ip: string;
  port: number;
  userId?: string | null;
  syncId?: string | null;
  connectionOrigin?: "local" | "remote" | null;
  localOnly?: boolean;
}

export function originRelayUrl(serverUrl: string, syncId: string): string {
  const url = new URL(serverUrl.replace(/\/+$/, "") + RELAY_PATH);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("syncId", syncId);
  return url.toString();
}

/** Reads the desktop wide default from the app's settings file. */
export function createDefaultOriginReader(
  settingsFile: string | null,
  now: () => number = Date.now,
): () => boolean {
  let cached: { at: number; remote: boolean } | null = null;
  return () => {
    if (!settingsFile) return false;
    if (cached && now() - cached.at < SETTINGS_CACHE_MS) return cached.remote;
    let remote = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as {
        defaultConnectionOrigin?: unknown;
      };
      remote = parsed.defaultConnectionOrigin === "remote";
    } catch {
      remote = false;
    }
    cached = { at: now(), remote };
    return remote;
  };
}

export function createOriginTransport(options: {
  links: () => Promise<SyncLinkInfo[]>;
  defaultRemote: () => boolean;
}) {
  const linked = new Map<string, SyncLinkInfo>();

  async function refresh(): Promise<void> {
    try {
      const list = await options.links();
      linked.clear();
      for (const link of list)
        if (link.sessionToken) linked.set(link.userId, link);
    } catch {
      // Keep the last known links.
    }
  }

  function claims(_hostId: number, host?: OriginHost): boolean {
    if (!host?.syncId || !host.userId || host.localOnly) return false;
    if (!linked.has(host.userId)) return false;
    if (host.connectionOrigin === "local") return false;
    return host.connectionOrigin === "remote" || options.defaultRemote();
  }

  async function open(host: OriginHost): Promise<Duplex> {
    const link = host.userId ? linked.get(host.userId) : undefined;
    if (!link?.sessionToken || !host.syncId)
      throw new Error("This desktop is not linked to a server");
    const headers: Record<string, string> = {};
    for (const header of link.customHeaders ?? [])
      if (header.name) headers[header.name] = header.value;
    if (link.basicAuth?.username) {
      headers.Authorization = `Basic ${Buffer.from(
        `${link.basicAuth.username}:${link.basicAuth.password ?? ""}`,
      ).toString("base64")}`;
    }
    const wsOptions: WebSocket.ClientOptions = {
      headers,
      handshakeTimeout: 15_000,
      ...(link.allowInvalidCertificate ? { rejectUnauthorized: false } : {}),
      ...(link.clientCert
        ? {
            pfx: Buffer.from(link.clientCert.pfx, "base64"),
            passphrase: link.clientCert.passphrase,
          }
        : {}),
    };
    const url = originRelayUrl(link.serverUrl, host.syncId);
    const protocols = [`${JWT_PROTOCOL_PREFIX}${link.sessionToken}`];
    const socket = new WebSocket(url, protocols, wsOptions);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error) =>
        reject(
          new Error(`The server refused the connection: ${error.message}`),
        ),
      );
    });
    return createWebSocketStream(socket);
  }

  return { refresh, claims, open };
}

export function registerOriginTransport(
  ctx: PluginContext,
  host: PluginSyncHost,
): void {
  if (!host.embedded) return;
  const userData = process.env.ELECTRON_USER_DATA;
  const transport = createOriginTransport({
    links: () => host.links.list(),
    defaultRemote: createDefaultOriginReader(
      userData ? path.join(userData, "desktop-settings.json") : null,
    ),
  });
  void transport.refresh();
  ctx.schedule.every(LINKS_REFRESH_MS, () => transport.refresh());
  ctx.ssh.transports.provide({
    claims: transport.claims,
    open: transport.open,
  });
}
