/**
 * Account switching. On the desktop app each linked server is its own local
 * account with its own copy of the data, and switching changes which one the
 * app signs in as. On a server, the browser keeps a ring of the other
 * accounts of the same server that were signed in on it. A browser can only
 * hold sessions for the server it is on, so accounts on other servers need
 * the desktop app.
 */

import crypto from "crypto";
import express, { type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import type {
  PluginContext,
  PluginSyncHost,
} from "@termix-ssh/plugin-sdk/backend";
import type { EngineManager } from "./engines.js";

const RING_COOKIE = "termix_accounts";
const RING_DAYS = 365;

interface AuthedRequest extends Request {
  userId: string;
}

const userOf = (req: Request) => (req as AuthedRequest).userId;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface AccountsDeps {
  ctx: PluginContext;
  host: PluginSyncHost;
  manager: EngineManager;
  webTable: any;
  log: { error: (message: string, meta?: unknown) => void };
}

export function createAccountsRouter({
  ctx,
  host,
  manager,
  webTable,
  log,
}: AccountsDeps): express.Router {
  const router = express.Router();
  const authenticate = host.sessions.middleware() as express.RequestHandler;
  const desktopOnly = host.sessions.desktopOnly() as express.RequestHandler;

  const onlyServer: express.RequestHandler = (_req, res, next) => {
    if (host.embedded) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    next();
  };

  /**
   * @openapi
   * /plugin-api/sync/accounts:
   *   get:
   *     summary: The accounts on this desktop
   *     description: Desktop only. Each account is a local user that holds the copy of one linked server, or this device's own data. Exactly one is active.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: The accounts and which one is active.
   */
  router.get(
    "/accounts",
    desktopOnly,
    authenticate,
    async (_req: Request, res: Response) => {
      const accounts = await host.accounts.list();
      const out = [];
      let unlinked = 0;
      for (const account of accounts) {
        const link = await host.links.get(account.id);
        if (!link) unlinked++;
        out.push({
          id: account.id,
          active: account.active,
          linked: !!link,
          serverUrl: link?.serverUrl ?? null,
          serverName:
            link?.serverName ?? (link ? hostOf(link.serverUrl) : null),
          username: link?.remoteUsername ?? account.username,
          status: link?.status ?? null,
        });
      }
      res.json({ accounts: out, unlinked });
    },
  );

  /**
   * @openapi
   * /plugin-api/sync/accounts:
   *   post:
   *     summary: Add an empty account for another server
   *     description: Desktop only. Makes a new local account and does not switch to it. Switch to it, then link it to a server like any other.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: The new account id.
   */
  router.post(
    "/accounts",
    desktopOnly,
    authenticate,
    async (_req: Request, res: Response) => {
      try {
        res.json({ id: await host.accounts.create() });
      } catch (error) {
        log.error("Could not add an account", error);
        res.status(500).json({ error: "Failed to add account" });
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/sync/accounts/switch:
   *   post:
   *     summary: Switch the active account
   *     description: Desktop only. Returns a session for that account and sets it as the cookie, so the app should store the token and reload after this. Data of the accounts never mixes.
   *     tags:
   *       - Sync
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               userId:
   *                 type: string
   *     responses:
   *       200:
   *         description: Switched.
   *       404:
   *         description: No such account.
   */
  router.post(
    "/accounts/switch",
    desktopOnly,
    authenticate,
    async (req: Request, res: Response) => {
      const userId =
        typeof req.body?.userId === "string" ? req.body.userId : "";
      const accounts = await host.accounts.list();
      if (!accounts.some((account) => account.id === userId)) {
        return res.status(404).json({ error: "No such account" });
      }
      await host.accounts.setActive(userId);
      await manager.applyActiveProxy().catch(() => {});
      // The app is signed in as the old account until it holds this one's
      // session, so the new session replaces the cookie and goes back as well.
      const token = await host.sessions.issueDesktop(userId, {
        days: 30,
        deviceInfo: "Termix Desktop (local)",
      });
      host.sessions.setCookie(req, res, token);
      res.json({ success: true, token });
    },
  );

  /**
   * @openapi
   * /plugin-api/sync/accounts/{id}:
   *   delete:
   *     summary: Remove an account
   *     description: Desktop only. Ends its link to the server when it can be reached, then deletes the account and its copy of the data. The active account cannot be removed.
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
   *         description: Removed.
   *       400:
   *         description: This account is active, or the last one.
   *       404:
   *         description: No such account.
   */
  router.delete(
    "/accounts/:id",
    desktopOnly,
    authenticate,
    async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const accounts = await host.accounts.list();
      const account = accounts.find((entry) => entry.id === id);
      if (!account) return res.status(404).json({ error: "No such account" });
      if (account.active || accounts.length <= 1) {
        return res
          .status(400)
          .json({ error: "Switch to another account first" });
      }
      try {
        const link = await host.links.get(id);
        if (link) {
          await host.http
            .json(link, "/sync/v2/unlink", {
              method: "POST",
              body: {},
              timeoutMs: 10_000,
            })
            .catch(() => {});
          manager.stop(id);
        }
        await host.accounts.remove(id);
        res.json({ success: true });
      } catch (error) {
        log.error("Could not remove an account", error);
        res.status(500).json({ error: "Failed to remove account" });
      }
    },
  );

  // Same server accounts in a browser.

  const db = () => ctx.db.client<any>();

  function cookieOf(req: Request, name: string): string | null {
    const value = (req as Request & { cookies?: Record<string, string> })
      .cookies?.[name];
    return typeof value === "string" && value ? value : null;
  }

  function ringOf(req: Request): string | null {
    const value = cookieOf(req, RING_COOKIE);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
  }

  async function store(
    ringId: string,
    userId: string,
    username: string,
    token: string,
  ): Promise<void> {
    const client = await db();
    const sealed = await ctx.secrets.seal(token);
    await client
      .delete(webTable)
      .where(and(eq(webTable.ringId, ringId), eq(webTable.ownerId, userId)));
    await client
      .insert(webTable)
      .values({ ringId, ownerId: userId, username, token: sealed });
    await ctx.db.persist();
  }

  async function usernameOf(userId: string): Promise<string> {
    return (await host.sessions.findUser(userId))?.username ?? "account";
  }

  /** The ring's accounts whose sessions still work. */
  async function liveAccounts(ringId: string) {
    const client = await db();
    const rows = await client
      .select()
      .from(webTable)
      .where(eq(webTable.ringId, ringId));
    const live = [];
    for (const row of rows) {
      const token = await ctx.secrets.unseal(row.token);
      const valid = token ? await host.sessions.verify(token) : null;
      if (!token || !valid || valid.userId !== row.ownerId) {
        await client.delete(webTable).where(eq(webTable.id, row.id));
        continue;
      }
      live.push({ row, token, sessionId: valid.sessionId });
    }
    await ctx.db.persist();
    return live;
  }

  /**
   * @openapi
   * /plugin-api/sync/web/accounts:
   *   get:
   *     summary: The accounts signed in on this browser
   *     description: Server only. The other accounts of this server that were signed in here and still have a working session. Accounts on other servers cannot be held by a browser, since the session cookie belongs to one address.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: The accounts, whether this browser has a ring, and which one is current.
   */
  router.get(
    "/web/accounts",
    onlyServer,
    authenticate,
    async (req: Request, res: Response) => {
      const ringId = ringOf(req);
      if (!ringId) return res.json({ ring: false, accounts: [] });
      const live = await liveAccounts(ringId);
      res.json({
        ring: true,
        accounts: live.map(({ row }) => ({
          userId: row.ownerId,
          username: row.username,
          current: row.ownerId === userOf(req),
        })),
      });
    },
  );

  /**
   * @openapi
   * /plugin-api/sync/web/accounts/begin:
   *   post:
   *     summary: Keep this account and go sign in with another
   *     description: Server only. Remembers the current session for this browser and removes the sign in cookie, so the sign in page shows. The session itself is not ended.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: Ready for another sign in.
   */
  router.post(
    "/web/accounts/begin",
    onlyServer,
    authenticate,
    async (req: Request, res: Response) => {
      const token = cookieOf(req, "jwt");
      if (!token) return res.status(400).json({ error: "No session" });
      let ringId = ringOf(req);
      if (!ringId) {
        ringId = crypto.randomBytes(32).toString("hex");
        host.sessions.setCookie(req, res, ringId, {
          name: RING_COOKIE,
          days: RING_DAYS,
        });
      }
      const userId = userOf(req);
      await store(ringId, userId, await usernameOf(userId), token);
      host.sessions.clearCookie(req, res);
      res.json({ success: true });
    },
  );

  /**
   * @openapi
   * /plugin-api/sync/web/accounts/attach:
   *   post:
   *     summary: Add the account that just signed in to this browser's accounts
   *     description: Server only. Does nothing when this browser has no accounts ring.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: Added, or nothing to add to.
   */
  router.post(
    "/web/accounts/attach",
    onlyServer,
    authenticate,
    async (req: Request, res: Response) => {
      const ringId = ringOf(req);
      const token = cookieOf(req, "jwt");
      if (!ringId || !token) return res.json({ attached: false });
      const userId = userOf(req);
      await store(ringId, userId, await usernameOf(userId), token);
      res.json({ attached: true });
    },
  );

  /**
   * @openapi
   * /plugin-api/sync/web/accounts/switch:
   *   post:
   *     summary: Switch this browser to another signed in account
   *     description: Server only. Sets the sign in cookie to that account's session. The app should reload after this.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: Switched.
   *       404:
   *         description: That account is not signed in here any more.
   */
  router.post(
    "/web/accounts/switch",
    onlyServer,
    authenticate,
    async (req: Request, res: Response) => {
      const ringId = ringOf(req);
      const userId =
        typeof req.body?.userId === "string" ? req.body.userId : "";
      if (!ringId) return res.status(404).json({ error: "Not found" });
      const live = await liveAccounts(ringId);
      const target = live.find(({ row }) => row.ownerId === userId);
      if (!target) return res.status(404).json({ error: "Not found" });
      // Keep the account being left, so the person can come back.
      const current = cookieOf(req, "jwt");
      if (current && userOf(req) !== userId) {
        await store(
          ringId,
          userOf(req),
          await usernameOf(userOf(req)),
          current,
        );
      }
      host.sessions.setCookie(req, res, target.token);
      res.json({ success: true });
    },
  );

  /**
   * @openapi
   * /plugin-api/sync/web/accounts/{userId}:
   *   delete:
   *     summary: Sign an account out of this browser
   *     description: Server only. Ends that account's session and forgets it here. Signing out the current account also removes the sign in cookie.
   *     tags:
   *       - Sync
   *     parameters:
   *       - in: path
   *         name: userId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Removed.
   */
  router.delete(
    "/web/accounts/:userId",
    onlyServer,
    authenticate,
    async (req: Request, res: Response) => {
      const ringId = ringOf(req);
      const userId = String(req.params.userId);
      if (ringId) {
        const live = await liveAccounts(ringId);
        const target = live.find(({ row }) => row.ownerId === userId);
        if (target?.sessionId) await host.sessions.revoke(target.sessionId);
        const client = await db();
        await client
          .delete(webTable)
          .where(
            and(eq(webTable.ringId, ringId), eq(webTable.ownerId, userId)),
          );
        await ctx.db.persist();
      }
      if (userOf(req) === userId) host.sessions.clearCookie(req, res);
      res.json({ success: true });
    },
  );

  return router;
}
