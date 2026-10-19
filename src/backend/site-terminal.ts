/**
 * Sessions on a remote site's hosts. The browser talks to this socket and the
 * master opens the remote's terminal socket with a ticket made from the API
 * key, so the remote does the connecting and the master only passes frames.
 * The remote applies the key's user's permissions to every host.
 */

import WebSocket from "ws";
import type {
  PluginContext,
  PluginWebSocketConnection,
} from "@termix-ssh/plugin-sdk/backend";
import { SiteError, type Sites } from "./sites.js";

const TERMINAL_PATH = "/plugin-ws/ssh-terminal/terminal";
const PING_MS = 30_000;

function socketUrl(baseUrl: string): string {
  const url = new URL(baseUrl.replace(/\/+$/, "") + TERMINAL_PATH);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function send(socket: WebSocket, type: string, data?: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(data === undefined ? { type } : { type, data }));
}

export function registerSiteTerminal(
  ctx: PluginContext,
  sites: Sites,
  log: { warn: (message: string, meta?: unknown) => void },
): void {
  const open = new Set<() => void>();

  ctx.ws.route(
    "/site-terminal",
    async (connection: PluginWebSocketConnection) => {
      const browser = connection.socket as WebSocket;
      const query = new URL(
        String((connection.request as { url?: string }).url),
        "http://local",
      ).searchParams;
      const siteId = Number(query.get("siteId"));
      const hostId = Number(query.get("hostId"));
      const cols = Math.min(Math.max(Number(query.get("cols")) || 80, 10), 500);
      const rows = Math.min(Math.max(Number(query.get("rows")) || 24, 5), 200);

      const closeBrowser = (message: string, code = 1011) => {
        send(browser, "error", { message });
        browser.close(code, message.slice(0, 120));
      };

      if (!(await ctx.rbac.hasFor(connection.userId, "sites"))) {
        return closeBrowser("You can't open sessions on remote sites", 1008);
      }
      if (!Number.isSafeInteger(siteId) || !Number.isSafeInteger(hostId)) {
        return closeBrowser("Missing site or host", 1008);
      }

      let remote: WebSocket | null = null;
      let ping: NodeJS.Timeout | null = null;
      const close = () => {
        if (ping) clearInterval(ping);
        remote?.close();
        if (browser.readyState <= WebSocket.OPEN) browser.close();
        open.delete(close);
      };
      open.add(close);

      try {
        const [config, { baseUrl, ticket }] = await Promise.all([
          sites.hostConfig(siteId, hostId),
          sites.socketTicket(siteId),
        ]);
        remote = new WebSocket(socketUrl(baseUrl), {
          headers: { Authorization: `Bearer ${ticket}` },
          handshakeTimeout: 15_000,
        });
        const link = remote;

        link.once("open", () => {
          send(link, "connectToHost", { cols, rows, hostConfig: config });
          ping = setInterval(() => send(link, "ping"), PING_MS);
        });
        // Frames pass untouched, so the browser speaks the remote's protocol.
        link.on("message", (data, isBinary) => {
          if (browser.readyState === WebSocket.OPEN)
            browser.send(data, { binary: isBinary });
        });
        let size = { cols, rows };
        browser.on("message", (data, isBinary) => {
          if (link.readyState !== WebSocket.OPEN) return;
          if (isBinary) {
            link.send(data, { binary: true });
            return;
          }
          const text = data.toString();
          try {
            const message = JSON.parse(text) as {
              type?: string;
              data?: Record<string, unknown>;
            };
            if (message.type === "resize" && message.data) {
              size = {
                cols: Number(message.data.cols) || size.cols,
                rows: Number(message.data.rows) || size.rows,
              };
            }
            // The browser does not know the host, so the retry gets it here.
            if (message.type === "reconnect_with_credentials") {
              send(link, message.type, {
                ...size,
                hostConfig: config,
                ...message.data,
              });
              return;
            }
          } catch {
            // Not JSON: pass it on as it is.
          }
          link.send(text);
        });
        link.once("error", (error) => {
          log.warn("A remote session failed", { error: error.message });
          closeBrowser("The remote site refused the session");
        });
        link.once("close", close);
        browser.once("close", close);
      } catch (error) {
        const message =
          error instanceof SiteError
            ? error.message
            : "Could not reach the remote site";
        closeBrowser(message);
        open.delete(close);
      }
    },
  );

  ctx.disposables.add(() => {
    for (const close of [...open]) close();
  });
}
