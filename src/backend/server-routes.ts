/**
 * The server side of sync, under /sync/v2. Core forwards these paths to the
 * plugin. A linked desktop, or any other client, signs in, trades that login
 * for a long lived device session, then pulls and pushes by revision.
 */

import express, { type Request, type Response } from "express";
import type { PluginSyncHost } from "@termix-ssh/plugin-sdk/backend";
import {
  SYNC_PROTOCOL_VERSION,
  readClientType,
  readDeviceId,
} from "./protocol.js";
import type { DeviceStore } from "./devices.js";

const SESSION_DAYS = 365;
const REFRESH_WITHIN_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_PAGE = 1000;

interface AuthedRequest extends Request {
  userId: string;
  sessionId?: string;
  apiKeyId?: string;
}

function userOf(req: Request): string {
  return (req as AuthedRequest).userId;
}

/** A non-negative integer query value, the fallback when absent, null when malformed. */
function queryInt(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return typeof value === "string" &&
    /^\d+$/.test(value) &&
    Number.isSafeInteger(parsed)
    ? parsed
    : null;
}

export function createServerRouter(
  host: PluginSyncHost,
  devices: DeviceStore,
  log: { error: (message: string, meta?: unknown) => void },
): express.Router {
  const router = express.Router();
  const authenticate = host.sessions.middleware() as express.RequestHandler;

  /**
   * @openapi
   * /sync/v2/info:
   *   get:
   *     summary: Is this a Termix server that can sync
   *     description: Public. Used by a client before it signs in. The client may send clientType and deviceId as query values, which are not stored.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: Server name, version and sync protocol version.
   */
  router.get("/v2/info", async (_req: Request, res: Response) => {
    res.setHeader("X-Termix-Sync", String(SYNC_PROTOCOL_VERSION));
    res.json({
      termix: true,
      name: await host.info.appName(),
      version: host.info.version(),
      protocol: SYNC_PROTOCOL_VERSION,
      clientTypes: ["desktop", "mobile", "web", "cli", "master"],
    });
  });

  /**
   * @openapi
   * /sync/v2/link:
   *   post:
   *     summary: Link a client to this account
   *     description: Trades the short login session the client just signed in with for a long lived device session, which shows in the account's sessions list and is revoked like any other. The login session is ended. clientType and deviceId are optional and default to desktop and none.
   *     tags:
   *       - Sync
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               deviceName:
   *                 type: string
   *               clientType:
   *                 type: string
   *                 enum: [desktop, mobile, web, cli, master]
   *               deviceId:
   *                 type: string
   *     responses:
   *       200:
   *         description: The device session token and the account it belongs to.
   *       401:
   *         description: Not signed in.
   *       403:
   *         description: API keys cannot link a client.
   */
  router.post("/v2/link", authenticate, async (req: Request, res: Response) => {
    const userId = userOf(req);
    const authed = req as AuthedRequest;
    if (authed.apiKeyId) {
      return res.status(403).json({ error: "API keys cannot link a desktop" });
    }
    try {
      const user = await host.sessions.findUser(userId);
      if (!user) return res.status(401).json({ error: "User not found" });
      const rawName =
        typeof req.body?.deviceName === "string" ? req.body.deviceName : "";
      const deviceName = rawName.trim().slice(0, 100) || "Termix Desktop";
      const clientType = readClientType(req.body?.clientType);
      const deviceId = readDeviceId(req.body?.deviceId);
      const token = await host.sessions.issueDesktop(userId, {
        days: SESSION_DAYS,
        deviceInfo: `${deviceName} (sync)`,
      });
      if (authed.sessionId) await host.sessions.revoke(authed.sessionId);
      await devices.touch(userId, { clientType, deviceId, name: deviceName });
      res.json({
        token,
        user: { id: user.id, username: user.username },
        server: { version: host.info.version() },
      });
    } catch (error) {
      log.error("Failed to link a desktop", error);
      res.status(500).json({ error: "Failed to link" });
    }
  });

  /**
   * @openapi
   * /sync/v2/session/refresh:
   *   post:
   *     summary: Keep a linked client's session from expiring
   *     description: Returns a fresh device session when the current one ends within 60 days, and ends the old one. Otherwise returns null and the client keeps its token.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: The new token, or null.
   *       401:
   *         description: Session revoked or expired.
   */
  router.post(
    "/v2/session/refresh",
    authenticate,
    async (req: Request, res: Response) => {
      const userId = userOf(req);
      const sessionId = (req as AuthedRequest).sessionId;
      try {
        if (!sessionId) return res.json({ token: null });
        const session = await host.sessions.find(sessionId);
        if (!session)
          return res.status(401).json({ error: "Session not found" });
        const remaining = new Date(session.expiresAt).getTime() - Date.now();
        if (remaining > REFRESH_WITHIN_MS) return res.json({ token: null });
        const token = await host.sessions.issueDesktop(userId, {
          days: SESSION_DAYS,
          deviceInfo: session.deviceInfo ?? "Termix Desktop (sync)",
        });
        await host.sessions.revoke(sessionId);
        res.json({ token });
      } catch (error) {
        log.error("Failed to refresh a desktop session", error);
        res.status(500).json({ error: "Failed to refresh session" });
      }
    },
  );

  /**
   * @openapi
   * /sync/v2/unlink:
   *   post:
   *     summary: End a linked client's session
   *     description: Called by a client when it unlinks, so its session stops working here right away.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: The session was ended.
   */
  router.post(
    "/v2/unlink",
    authenticate,
    async (req: Request, res: Response) => {
      const sessionId = (req as AuthedRequest).sessionId;
      try {
        if (sessionId) await host.sessions.revoke(sessionId);
        res.json({ success: true });
      } catch (error) {
        log.error("Failed to end a desktop session", error);
        res.status(500).json({ error: "Failed to unlink" });
      }
    },
  );

  /**
   * @openapi
   * /sync/v2/devices:
   *   get:
   *     summary: The clients linked to this account
   *     description: Each client that linked with a deviceId, with its type, name and when it last linked. Clients that sent no deviceId are not listed.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: The devices.
   */
  router.get(
    "/v2/devices",
    authenticate,
    async (req: Request, res: Response) => {
      try {
        res.json({ devices: await devices.list(userOf(req)) });
      } catch (error) {
        log.error("Failed to list devices", error);
        res.status(500).json({ error: "Failed to list devices" });
      }
    },
  );

  /**
   * @openapi
   * /sync/v2/changes:
   *   get:
   *     summary: Pull what changed for this account after a cursor
   *     description: Returns records in change order. Each has the entity type, syncId, revision, whether it is deleted, and the row when it is not. Records of entity types this server does not currently run are skipped but still move the cursor.
   *     tags:
   *       - Sync
   *     parameters:
   *       - in: query
   *         name: cursor
   *         schema:
   *           type: integer
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *       - in: query
   *         name: types
   *         description: Comma-separated entity types, to backfill only those.
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: A page of changes, the next cursor and whether more remain.
   *       400:
   *         description: The cursor or limit is not a non-negative integer.
   *       500:
   *         description: Failed to read changes.
   */
  router.get(
    "/v2/changes",
    authenticate,
    async (req: Request, res: Response) => {
      const userId = userOf(req);
      const cursor = queryInt(req.query.cursor, 0);
      const pageSize = queryInt(req.query.limit, MAX_PAGE);
      if (cursor === null || pageSize === null) {
        return res.status(400).json({ error: "Invalid cursor or limit" });
      }
      const limit = Math.min(MAX_PAGE, Math.max(1, pageSize));
      const types =
        typeof req.query.types === "string" && req.query.types
          ? req.query.types.split(",").filter(Boolean)
          : undefined;
      try {
        const page = await host.feed.changes(userId, cursor, limit, types);
        res.json({
          changes: page.records,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          entityTypes: page.entityTypes,
        });
      } catch (error) {
        log.error("Failed to read sync changes", error);
        res.status(500).json({ error: "Failed to read changes" });
      }
    },
  );

  /**
   * @openapi
   * /sync/v2/push:
   *   post:
   *     summary: Push a client's changes
   *     description: Each op carries the revision the client last saw. Ops are applied in dependency order and each gets its own result, ok with the new revision, conflict with the server's version, or rejected with a reason.
   *     tags:
   *       - Sync
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               ops:
   *                 type: array
   *                 items:
   *                   type: object
   *     responses:
   *       200:
   *         description: One result per op, in the order sent.
   *       400:
   *         description: Malformed ops, or more than 500.
   *       500:
   *         description: Failed to apply changes.
   */
  router.post("/v2/push", authenticate, async (req: Request, res: Response) => {
    const userId = userOf(req);
    const ops = await host.feed.parsePushOps(req.body);
    if (!ops) return res.status(400).json({ error: "Invalid ops" });
    try {
      const results = await host.feed.applyPush(userId, ops);
      res.json({ results });
    } catch (error) {
      log.error("Failed to apply pushed changes", error);
      res.status(500).json({ error: "Failed to apply changes" });
    }
  });

  /**
   * @openapi
   * /sync/v2/events:
   *   get:
   *     summary: Stream a notice whenever this account's data changes
   *     description: Server-sent events. A "change" event means there is something new to pull. Comments are sent every 25 seconds to keep proxies from closing the stream.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: An event stream.
   */
  router.get(
    "/v2/events",
    authenticate,
    async (req: Request, res: Response) => {
      const userId = userOf(req);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      res.write(`event: ready\ndata: {}\n\n`);
      let remove: (() => void) | null = null;
      let closed = false;
      req.on("close", () => {
        closed = true;
        remove?.();
      });
      remove = await host.feed.listen(userId, res);
      if (closed) remove();
    },
  );

  /**
   * @openapi
   * /sync/v2/hosts/{syncId}:
   *   get:
   *     summary: This server's id for a host, by its sync id
   *     description: For a linked desktop that asks the server to act on a host (a tunnel through it), which needs the server's own id. Only for hosts the caller can connect to.
   *     tags:
   *       - Sync
   *     parameters:
   *       - in: path
   *         name: syncId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The host's id and name.
   *       404:
   *         description: No such host the caller can connect to.
   */
  router.get(
    "/v2/hosts/:syncId",
    authenticate,
    async (req: Request, res: Response) => {
      try {
        const found = await host.hosts.findForSync(
          userOf(req),
          String(req.params.syncId),
        );
        if (!found) return res.status(404).json({ error: "Not found" });
        res.json(found);
      } catch (error) {
        log.error("Failed to look up a host by sync id", error);
        res.status(500).json({ error: "Failed to look up host" });
      }
    },
  );

  /**
   * @openapi
   * /sync/v2/host-status:
   *   get:
   *     summary: Status of the hosts this account can see, keyed by sync id
   *     description: For a linked desktop whose hosts connect through this server, so it can show their status against its own copies.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: Status entries by host sync id.
   */
  router.get(
    "/v2/host-status",
    authenticate,
    async (req: Request, res: Response) => {
      try {
        res.json(await host.hosts.statusBySyncId(userOf(req)));
      } catch (error) {
        log.error("Failed to read host status for sync", error);
        res.status(500).json({ error: "Failed to read host status" });
      }
    },
  );

  /**
   * @openapi
   * /sync/v2/plugins:
   *   get:
   *     summary: The features this server runs, for a linked desktop to mirror
   *     description: Every installed plugin with its version, where it came from, whether it is on, how a desktop should treat it and which sync entities it owns. registryKeys lists the signing keys of the custom registries an admin added, so plugins from them load on the desktop.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: The plugin list.
   */
  router.get(
    "/v2/plugins",
    authenticate,
    async (_req: Request, res: Response) => {
      try {
        res.json(await host.plugins.listForDesktop());
      } catch (error) {
        log.error("Failed to list plugins for sync", error);
        res.status(500).json({ error: "Failed to list plugins" });
      }
    },
  );

  /**
   * @openapi
   * /sync/v2/plugins/{id}/package:
   *   get:
   *     summary: Download an installed plugin so a linked desktop can install it
   *     description: Only for plugins installed on this server, or bundled ones replaced by a signed update. Sends the original .tmxplug when there is one, with its signature in the X-Termix-Signature header, otherwise a fresh archive of the plugin folder.
   *     tags:
   *       - Sync
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The plugin archive.
   *       404:
   *         description: No installed plugin with that id.
   */
  router.get(
    "/v2/plugins/:id/package",
    authenticate,
    async (req: Request, res: Response) => {
      try {
        const sent = await host.plugins.sendPackage(String(req.params.id), res);
        if (!sent) res.status(404).json({ error: "Plugin not found" });
      } catch (error) {
        log.error("Failed to package a plugin for sync", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to package plugin" });
        }
      }
    },
  );

  return router;
}
