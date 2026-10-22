/**
 * The desktop's own sync routes, under /sync/link. They only exist in the
 * embedded desktop backend; on a server they answer 404.
 */

import express, { type Request, type Response } from "express";
import type {
  PluginSyncHost,
  SyncBasicAuth,
  SyncClientCert,
  SyncLinkInfo,
  SyncLinkPatch,
  SyncProxyHeader,
  SyncRemoteTarget,
  SyncRow,
} from "@termix-ssh/plugin-sdk/backend";
import { SYNC_PROTOCOL_VERSION } from "./protocol.js";
import type { EngineManager } from "./engines.js";
import type { SyncEngine } from "./engine.js";

interface AuthedRequest extends Request {
  userId: string;
}

function userOf(req: Request): string {
  return (req as AuthedRequest).userId;
}

function readHeaders(value: unknown): SyncProxyHeader[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (header): header is SyncProxyHeader =>
        !!header &&
        typeof header.name === "string" &&
        typeof header.value === "string" &&
        /^[A-Za-z0-9-]{1,100}$/.test(header.name.trim()),
    )
    .map((header) => ({ name: header.name.trim(), value: header.value }))
    .slice(0, 20);
}

function readBasicAuth(value: unknown): SyncBasicAuth | null {
  if (!value || typeof value !== "object") return null;
  const { username, password } = value as Record<string, unknown>;
  if (typeof username !== "string" || !username) return null;
  return {
    username,
    password: typeof password === "string" ? password : "",
  };
}

function readClientCert(value: unknown): SyncClientCert | null {
  if (!value || typeof value !== "object") return null;
  const { pfx, passphrase, name } = value as Record<string, unknown>;
  if (typeof pfx !== "string" || !pfx) return null;
  return {
    pfx,
    passphrase: typeof passphrase === "string" ? passphrase : "",
    name: typeof name === "string" && name ? name.slice(0, 200) : null,
  };
}

export function createClientRouter(
  host: PluginSyncHost,
  manager: EngineManager,
  deviceId: () => Promise<string | null>,
  log: {
    error: (message: string, meta?: unknown) => void;
    warn: (message: string, meta?: unknown) => void;
  },
): express.Router {
  const router = express.Router();
  const guard = [
    host.sessions.desktopOnly() as express.RequestHandler,
    host.sessions.middleware() as express.RequestHandler,
  ];

  function readTarget(body: Record<string, unknown>): SyncRemoteTarget | null {
    const serverUrl =
      typeof body.serverUrl === "string"
        ? host.http.normalizeServerUrl(body.serverUrl)
        : null;
    if (!serverUrl) return null;
    return {
      serverUrl,
      customHeaders: readHeaders(body.customHeaders),
      basicAuth: readBasicAuth(body.basicAuth),
      allowInvalidCertificate: body.allowInvalidCertificate === true,
      clientCert: readClientCert(body.clientCert),
    };
  }

  function problemFor(error: unknown) {
    if (!host.http.isRemoteError(error)) {
      return { problem: "unreachable", message: String(error) };
    }
    switch (error.kind) {
      case "tls":
        return { problem: "tls_untrusted", message: error.message };
      case "client_cert":
        return { problem: "client_cert_invalid", message: error.message };
      case "basic_auth":
        return { problem: "basic_auth_required", message: error.message };
      case "proxy":
        return error.status === 404
          ? { problem: "not_termix", message: error.message }
          : { problem: "proxy_login", message: error.message };
      case "signed_out":
      case "server":
        // A Termix older than 2.9 has no /sync/v2 and answers with an error.
        return { problem: "version_mismatch", message: error.message };
      default:
        return { problem: "unreachable", message: error.message };
    }
  }

  /** What the sync panel can show about each entity type. */
  async function describeEntities(
    link: SyncLinkInfo | null,
    engine: SyncEngine,
  ) {
    await host.entities.ensureCore();
    const names = host.plugins.localNames();
    for (const plugin of host.plugins.lastRemote()) {
      if (!names.has(plugin.id)) names.set(plugin.id, plugin.name);
    }
    const serverTypes = engine.state.serverTypes;
    const seen = new Set<string>();
    const entries = [
      ...host.entities.list().map((entity) => ({
        type: entity.type,
        owner: entity.owner,
        readOnly: !!entity.readOnly,
      })),
      ...serverTypes,
    ];
    return entries
      .filter((entry) => {
        if (seen.has(entry.type) || entry.type === "accountProfile")
          return false;
        seen.add(entry.type);
        return true;
      })
      .map((entry) => ({
        type: entry.type,
        owner: entry.owner,
        ownerName:
          entry.owner === "core"
            ? null
            : (names.get(entry.owner) ?? entry.owner),
        readOnly: entry.readOnly,
        onServer: serverTypes.some((server) => server.type === entry.type),
        onDevice: !!host.entities.get(entry.type),
        enabled: !link?.disabledTypes.includes(entry.type),
      }));
  }

  async function statusBody(userId: string) {
    const engine = manager.engineFor(userId);
    const link = await host.links.get(userId);
    if (!link) {
      return { linked: false, entities: await describeEntities(null, engine) };
    }
    return {
      linked: true,
      serverUrl: link.serverUrl,
      serverName: link.serverName,
      serverVersion: link.serverVersion,
      account: link.account ?? {
        username: link.remoteUsername ?? undefined,
      },
      status: engine.state.running ? "syncing" : link.status,
      lastError: link.lastError,
      linkedAt: link.linkedAt,
      lastSyncAt: link.lastSyncAt,
      pending: engine.state.pending,
      conflicts: (await host.replica.conflicts.list(link.userId)).length,
      errors: (await host.replica.records.listErrors(link.userId)).length,
      firstSyncDone: link.knownTypes.length > 0,
      allowInvalidCertificate: link.allowInvalidCertificate,
      customHeaders: link.customHeaders.map((header) => ({
        name: header.name,
        value: "",
        set: true,
      })),
      basicAuth: link.basicAuth
        ? { username: link.basicAuth.username, password: "", set: true }
        : null,
      clientCert: link.clientCert
        ? { name: link.clientCert.name, pfx: "", passphrase: "", set: true }
        : null,
      entities: await describeEntities(link, engine),
    };
  }

  /**
   * @openapi
   * /sync/link/status:
   *   get:
   *     summary: This desktop's link to a server
   *     description: Desktop only. Whether the app is linked, to which server and account, how syncing is going, and which kinds of data sync.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: The link status.
   */
  router.get("/link/status", ...guard, async (req: Request, res: Response) => {
    try {
      res.json(await statusBody(userOf(req)));
    } catch (error) {
      log.error("Failed to read sync status", error);
      res.status(500).json({ error: "Failed to read sync status" });
    }
  });

  /**
   * @openapi
   * /sync/link/probe:
   *   post:
   *     summary: Check a server address before linking
   *     description: Desktop only. Tries the server with the given proxy settings and says what is in the way, if anything. On success the proxy settings are also applied to the desktop's browser session so the sign-in page loads.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: The server's name and version, or the problem found.
   */
  router.post("/link/probe", ...guard, async (req: Request, res: Response) => {
    const target = readTarget(req.body ?? {});
    if (!target) return res.json({ ok: false, problem: "invalid_url" });
    try {
      const info = await host.http.json<{
        termix?: boolean;
        name?: string;
        version?: string;
        protocol?: number;
      }>(target, "/sync/v2/info", { timeoutMs: 15_000 });
      if (!info?.termix) return res.json({ ok: false, problem: "not_termix" });
      if (info.protocol !== SYNC_PROTOCOL_VERSION) {
        return res.json({
          ok: false,
          problem: "version_mismatch",
          version: info.version,
        });
      }
      await host.desktop
        .applyProxy({
          serverUrl: target.serverUrl,
          customHeaders: target.customHeaders ?? [],
          basicAuth: target.basicAuth ?? null,
          allowInvalidCertificate: !!target.allowInvalidCertificate,
          clientCert: target.clientCert ?? null,
        } as SyncLinkInfo)
        .catch(() => {});
      res.json({
        ok: true,
        serverUrl: target.serverUrl,
        name: info.name ?? "Termix",
        version: info.version ?? null,
      });
    } catch (error) {
      res.json({ ok: false, ...problemFor(error) });
    }
  });

  /**
   * @openapi
   * /sync/link/preview:
   *   get:
   *     summary: How much this desktop has that would sync
   *     description: Desktop only. Row counts per kind of data, shown before choosing whether to merge this desktop's data into the account or replace it.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: Counts per entity type.
   */
  router.get("/link/preview", ...guard, async (req: Request, res: Response) => {
    res.json({ counts: await host.replica.counts(userOf(req)) });
  });

  /**
   * @openapi
   * /sync/link/complete:
   *   post:
   *     summary: Link this desktop to a server account
   *     description: Desktop only. Takes the session from signing in to the server, trades it for a long-lived desktop session, and starts syncing. "merge" uploads this desktop's data into the account; "replace" deletes it here first and takes the account's.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: Linked; the new status.
   *       400:
   *         description: Missing server or session.
   *       502:
   *         description: The server refused the session.
   */
  router.post(
    "/link/complete",
    ...guard,
    async (req: Request, res: Response) => {
      const userId = userOf(req);
      const body = req.body ?? {};
      const target = readTarget(body);
      const token = typeof body.token === "string" ? body.token : "";
      const mode = body.mode === "replace" ? "replace" : "merge";
      if (!target || !token) {
        return res.status(400).json({ error: "Missing server or session" });
      }

      try {
        const deviceName =
          typeof body.deviceName === "string" && body.deviceName.trim()
            ? body.deviceName.trim()
            : host.desktop.deviceName();
        const linked = await host.http.json<{
          token: string;
          user: { id: string; username: string };
          server?: { version?: string | null };
        }>({ ...target, sessionToken: token }, "/sync/v2/link", {
          method: "POST",
          body: {
            deviceName,
            clientType: "desktop",
            deviceId: await deviceId(),
          },
        });

        const previous = await host.links.get(userId);
        if (previous) {
          await host.replica.removeSharedCopies(previous.userId);
          await host.replica.records.deleteForUser(previous.userId);
        }
        if (mode === "replace") {
          await host.replica.wipe(userId);
        }
        await host.replica.records.deleteForUser(userId);

        const link = await host.links.create({
          userId,
          serverUrl: target.serverUrl,
          serverName:
            typeof body.serverName === "string" ? body.serverName : null,
          serverVersion: linked.server?.version ?? null,
          sessionToken: linked.token,
          customHeaders: target.customHeaders,
          basicAuth: target.basicAuth,
          allowInvalidCertificate: target.allowInvalidCertificate,
          clientCert: target.clientCert,
          remoteUserId: linked.user.id,
          remoteUsername: linked.user.username,
        });
        const engine = manager.engineFor(userId);
        engine.reset();
        await manager.applyProxy(link);
        engine.request(0);
        res.json(await statusBody(userId));
      } catch (error) {
        log.warn("Linking to a server failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(502).json({ ...problemFor(error) });
      }
    },
  );

  /**
   * @openapi
   * /sync/link/relogin:
   *   post:
   *     summary: Sign this desktop back in after its session ended
   *     description: Desktop only. Takes a new sign-in session for the same account and resumes syncing where it stopped.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: Signed in again; the new status.
   *       409:
   *         description: The sign-in was for a different account.
   */
  router.post(
    "/link/relogin",
    ...guard,
    async (req: Request, res: Response) => {
      const userId = userOf(req);
      const token = typeof req.body?.token === "string" ? req.body.token : "";
      const link = await host.links.get(userId);
      if (!link || !token) return res.status(400).json({ error: "Not linked" });
      try {
        const linked = await host.http.json<{
          token: string;
          user: { id: string; username: string };
        }>({ ...link, sessionToken: token }, "/sync/v2/link", {
          method: "POST",
          body: {
            deviceName: host.desktop.deviceName(),
            clientType: "desktop",
            deviceId: await deviceId(),
          },
        });
        if (link.remoteUserId && linked.user.id !== link.remoteUserId) {
          return res.status(409).json({ error: "different_account" });
        }
        await host.links.update(
          {
            sessionToken: linked.token,
            status: "idle",
            lastError: null,
          },
          userId,
        );
        manager.engineFor(userId).request(0);
        res.json(await statusBody(userId));
      } catch (error) {
        res.status(502).json({ ...problemFor(error) });
      }
    },
  );

  /**
   * @openapi
   * /sync/link/unlink:
   *   post:
   *     summary: Unlink this desktop from its server
   *     description: Desktop only. Ends the desktop's session on the server when it can be reached. With keepData the synced data stays on this device as its own; otherwise it is deleted. Copies of what others shared with the account are always removed.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: Unlinked.
   */
  router.post("/link/unlink", ...guard, async (req: Request, res: Response) => {
    const keepData = req.body?.keepData !== false;
    const userId = userOf(req);
    const link = await host.links.get(userId);
    if (!link) return res.json(await statusBody(userId));
    try {
      await host.http
        .json(link, "/sync/v2/unlink", {
          method: "POST",
          body: {},
          timeoutMs: 10_000,
        })
        .catch(() => {});

      manager.stop(userId);
      await host.replica.removeSharedCopies(userId);
      if (keepData) {
        // New syncIds so this data reads as new if it is ever linked again.
        await host.replica.regenerateSyncIds(userId);
      } else {
        await host.replica.wipe(userId);
      }
      await host.replica.records.deleteForUser(userId);
      await host.links.remove(userId);
      if ((await host.accounts.activeId()) === userId) {
        await host.desktop.applyProxy(null).catch(() => {});
      }
      res.json(await statusBody(userId));
    } catch (error) {
      log.error("Unlinking failed", error);
      res.status(500).json({ error: "Failed to unlink" });
    }
  });

  /**
   * @openapi
   * /sync/link/sync:
   *   post:
   *     summary: Sync now
   *     description: Desktop only. Runs a sync pass and waits for it.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: The status after the pass.
   */
  router.post("/link/sync", ...guard, async (req: Request, res: Response) => {
    const userId = userOf(req);
    await manager.engineFor(userId).syncNow();
    res.json(await statusBody(userId));
  });

  /**
   * @openapi
   * /sync/link/settings:
   *   put:
   *     summary: Change what syncs and how the server is reached
   *     description: Desktop only. disabledTypes lists the kinds of data that stay on this device. Proxy headers, basic auth and the client certificate left blank keep their saved values.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: The new status.
   *       400:
   *         description: Not linked.
   */
  router.put(
    "/link/settings",
    ...guard,
    async (req: Request, res: Response) => {
      const userId = userOf(req);
      const link = await host.links.get(userId);
      if (!link) return res.status(400).json({ error: "Not linked" });
      const body = req.body ?? {};
      const patch: SyncLinkPatch = {};

      if (Array.isArray(body.disabledTypes)) {
        const disabled = body.disabledTypes.filter(
          (type: unknown): type is string =>
            typeof type === "string" && type !== "accountProfile",
        );
        const changed = new Set([
          ...disabled.filter(
            (type: string) => !link.disabledTypes.includes(type),
          ),
          ...link.disabledTypes.filter((type) => !disabled.includes(type)),
        ]);
        patch.disabledTypes = disabled;
        // A type switched back on is pulled again in full.
        patch.knownTypes = link.knownTypes.filter((type) => !changed.has(type));
      }
      if (Array.isArray(body.customHeaders)) {
        const saved = new Map(link.customHeaders.map((h) => [h.name, h.value]));
        const merged = (body.customHeaders as unknown[])
          .filter(
            (header): header is { name: string; value?: string } =>
              !!header &&
              typeof (header as { name?: unknown }).name === "string",
          )
          .map((header) => ({
            name: header.name,
            value: header.value || saved.get(header.name) || "",
          }))
          .filter((header) => header.value);
        patch.customHeaders = readHeaders(merged);
      }
      if (body.basicAuth === null) {
        patch.basicAuth = null;
      } else if (body.basicAuth && typeof body.basicAuth === "object") {
        const next = readBasicAuth(body.basicAuth);
        if (next && !next.password && link.basicAuth) {
          next.password = link.basicAuth.password;
        }
        patch.basicAuth = next;
      }
      if (typeof body.allowInvalidCertificate === "boolean") {
        patch.allowInvalidCertificate = body.allowInvalidCertificate;
      }
      if (body.clientCert === null) {
        patch.clientCert = null;
      } else if (body.clientCert && typeof body.clientCert === "object") {
        const next = readClientCert(body.clientCert);
        if (next) patch.clientCert = next;
      }

      let updated;
      try {
        updated = await host.links.update(patch, userId);
      } catch (error) {
        if (patch.clientCert) {
          return res.status(400).json({
            problem: "client_cert_invalid",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
      await manager.applyProxy(updated);
      manager.engineFor(userId).request(0);
      res.json(await statusBody(userId));
    },
  );

  /**
   * @openapi
   * /sync/link/conflicts:
   *   get:
   *     summary: Local edits that lost to a newer edit on the server
   *     description: Desktop only. The server's version was kept; each entry holds this device's version so it can be restored.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: The conflicts, oldest first.
   */
  router.get(
    "/link/conflicts",
    ...guard,
    async (req: Request, res: Response) => {
      const conflicts = await host.replica.conflicts.list(userOf(req));
      res.json({
        conflicts: conflicts.map((conflict) => {
          let row: SyncRow = {};
          try {
            row = JSON.parse(conflict.localRow);
          } catch {
            row = {};
          }
          return {
            id: conflict.id,
            entityType: conflict.entityType,
            syncId: conflict.syncId,
            name:
              row.name ?? row.title ?? row.label ?? row.ip ?? conflict.syncId,
            createdAt: conflict.createdAt,
          };
        }),
      });
    },
  );

  /**
   * @openapi
   * /sync/link/conflicts/{id}:
   *   post:
   *     summary: Settle a conflict
   *     description: Desktop only. keep "mine" puts this device's version back, and the next sync sends it to the server. keep "server" drops it.
   *     tags:
   *       - Sync
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Settled.
   *       404:
   *         description: No such conflict.
   */
  async function settleConflict(
    userId: string,
    conflict: {
      id: number;
      entityType: string;
      syncId: string;
      localRow: string;
    },
    keep: unknown,
  ) {
    if (keep === "mine") {
      const entity = host.entities.get(conflict.entityType);
      if (entity && !entity.readOnly) {
        const row = JSON.parse(conflict.localRow) as SyncRow;
        await host.replica.writeRow(
          conflict.entityType,
          userId,
          { ...row, syncId: conflict.syncId },
          host.replica.resolvers(userId),
        );
      }
    }
    await host.replica.conflicts.delete(userId, conflict.id);
  }

  router.post(
    "/link/conflicts/:id",
    ...guard,
    async (req: Request, res: Response) => {
      const userId = userOf(req);
      const conflict = await host.replica.conflicts.get(
        userId,
        Number(req.params.id),
      );
      if (!conflict) return res.status(404).json({ error: "Not found" });
      try {
        await settleConflict(userId, conflict, req.body?.keep);
        manager.engineFor(userId).request(0);
        res.json({ success: true });
      } catch (error) {
        log.warn("Could not settle a sync conflict", {
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Failed to settle conflict" });
      }
    },
  );

  /**
   * @openapi
   * /sync/link/conflicts:
   *   post:
   *     summary: Settle every conflict
   *     description: Desktop only. keep "mine" puts this device's version of each one back, and the next sync sends them to the server. keep "server" drops them all.
   *     tags:
   *       - Sync
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               keep:
   *                 type: string
   *                 enum: [mine, server]
   *     responses:
   *       200:
   *         description: Settled. Holds how many were settled and how many failed.
   *       400:
   *         description: keep is not mine or server.
   */
  router.post(
    "/link/conflicts",
    ...guard,
    async (req: Request, res: Response) => {
      const userId = userOf(req);
      const keep = req.body?.keep;
      if (keep !== "mine" && keep !== "server") {
        return res.status(400).json({ error: "keep must be mine or server" });
      }
      let settled = 0;
      let failed = 0;
      for (const conflict of await host.replica.conflicts.list(userId)) {
        try {
          await settleConflict(userId, conflict, keep);
          settled++;
        } catch (error) {
          failed++;
          log.warn("Could not settle a sync conflict", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      manager.engineFor(userId).request(0);
      res.json({ success: failed === 0, settled, failed });
    },
  );

  /**
   * @openapi
   * /sync/link/errors:
   *   get:
   *     summary: Changes the server refused
   *     description: Desktop only. Each entry names the record and why the server refused it. A refused change is not sent again until it changes or is retried.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: The refused changes.
   */
  router.get("/link/errors", ...guard, async (req: Request, res: Response) => {
    const errors = await host.replica.records.listErrors(userOf(req));
    res.json({
      errors: errors.map((record) => ({
        entityType: record.entityType,
        syncId: record.syncId,
        reason: record.error,
      })),
    });
  });

  /**
   * @openapi
   * /sync/link/errors/retry:
   *   post:
   *     summary: Send refused changes again
   *     description: Desktop only. Clears every refusal and syncs.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: The status after the pass.
   */
  router.post(
    "/link/errors/retry",
    ...guard,
    async (req: Request, res: Response) => {
      const userId = userOf(req);
      await host.replica.records.clearErrors(userId);
      await manager.engineFor(userId).syncNow();
      res.json(await statusBody(userId));
    },
  );

  /**
   * @openapi
   * /sync/link/session:
   *   get:
   *     summary: The linked server and session, for connecting to it directly
   *     description: Desktop only. Used when a host is set to connect through the server rather than from this device.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: The server address and session token, or nulls when not linked.
   */
  router.get("/link/session", ...guard, async (req: Request, res: Response) => {
    const link = await host.links.get(userOf(req));
    if (!link?.sessionToken || link.status === "signed_out") {
      return res.json({ serverUrl: null, token: null });
    }
    res.json({ serverUrl: link.serverUrl, token: link.sessionToken });
  });

  return router;
}
