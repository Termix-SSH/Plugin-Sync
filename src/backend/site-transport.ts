/**
 * Carries the SSH connection of a mirrored host through the remote site. The
 * master opens the remote's relay socket with a ticket made from the API key
 * and runs SSH over it, so the remote reaches the host (jump hosts and all)
 * and the master only passes bytes. The remote applies the key's user's
 * permissions to every host.
 */

import type { Duplex } from "node:stream";
import WebSocket, { createWebSocketStream } from "ws";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Sites } from "./sites.js";

const RELAY_PATH = "/plugin-ws/core/ssh-relay";

export function relayUrl(baseUrl: string, remoteId: number): string {
  const url = new URL(baseUrl.replace(/\/+$/, "") + RELAY_PATH);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("hostId", String(remoteId));
  return url.toString();
}

export function registerSiteTransport(ctx: PluginContext, sites: Sites): void {
  ctx.ssh.transports.provide({
    claims: (hostId) => sites.siteNameOf(hostId) !== null,
    open: async (host): Promise<Duplex> => {
      const mapping = await sites.mappingOf(host.id);
      if (!mapping) throw new Error("This host is not synced from a site");
      const { baseUrl, ticket } = await sites.socketTicket(mapping.siteId);
      const socket = new WebSocket(relayUrl(baseUrl, mapping.remoteId), {
        headers: { Authorization: `Bearer ${ticket}` },
        handshakeTimeout: 15_000,
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", (error) =>
          reject(
            new Error(`The site refused the connection: ${error.message}`),
          ),
        );
      });
      return createWebSocketStream(socket);
    },
  });
}
