/**
 * Remote sites, for the admins who manage them. The API key is only ever
 * sent to the remote; it is never returned by these routes.
 */

import express, {
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type {
  PluginContext,
  PluginSyncHost,
} from "@termix-ssh/plugin-sdk/backend";
import { SiteError, normalizeBaseUrl, type Sites } from "./sites.js";

function fail(res: Response, error: unknown, fallback: string) {
  if (error instanceof SiteError) {
    return res.status(error.status).json({ error: error.message });
  }
  return res.status(500).json({ error: fallback });
}

const idOf = (req: Request) => {
  const id = Number(req.params.id);
  return Number.isSafeInteger(id) ? id : -1;
};

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

export function createSitesRouter(
  ctx: PluginContext,
  host: PluginSyncHost,
  sites: Sites,
  log: { error: (message: string, meta?: unknown) => void },
): express.Router {
  const router = express.Router();
  router.use("/sites", ctx.rbac.require("sites") as unknown as RequestHandler);
  router.use(
    "/overview",
    ctx.rbac.require("sites") as unknown as RequestHandler,
  );

  /**
   * @openapi
   * /plugin-api/sync/overview:
   *   get:
   *     summary: Health of all remote sites
   *     description: Counts of sites, how many answer, and how many of their hosts are online, from the last refresh.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: The roll up.
   */
  router.get("/overview", async (_req: Request, res: Response) => {
    try {
      res.json(await sites.overview());
    } catch (error) {
      log.error("Could not read the overview", error);
      res.status(500).json({ error: "Failed to read the overview" });
    }
  });

  /**
   * @openapi
   * /plugin-api/sync/sites:
   *   get:
   *     summary: Remote sites
   *     description: The Termix servers this server manages, with how the last refresh went. API keys are never returned.
   *     tags:
   *       - Sync
   *     responses:
   *       200:
   *         description: The sites.
   */
  router.get("/sites", async (_req: Request, res: Response) => {
    try {
      res.json({ sites: await sites.list() });
    } catch (error) {
      fail(res, error, "Failed to list sites");
    }
  });

  /**
   * @openapi
   * /plugin-api/sync/sites:
   *   post:
   *     summary: Add a remote site
   *     description: Saves the site with an API key made on it, then reads its hosts. The key's user on the remote decides what can be seen and opened.
   *     tags:
   *       - Sync
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               name:
   *                 type: string
   *               baseUrl:
   *                 type: string
   *               apiKey:
   *                 type: string
   *     responses:
   *       200:
   *         description: The site, with the result of the first refresh.
   *       400:
   *         description: Missing or invalid fields.
   *       409:
   *         description: That site is already added.
   */
  router.post("/sites", async (req: Request, res: Response) => {
    const baseUrl = normalizeBaseUrl(host, req.body?.baseUrl);
    const apiKey = text(req.body?.apiKey, 500);
    const name = text(req.body?.name, 100);
    if (!baseUrl || !apiKey || !name) {
      return res
        .status(400)
        .json({ error: "Name, address and API key are required" });
    }
    try {
      res.json({ site: await sites.create({ name, baseUrl, apiKey }) });
    } catch (error) {
      fail(res, error, "Failed to add the site");
    }
  });

  /**
   * @openapi
   * /plugin-api/sync/sites/{id}:
   *   put:
   *     summary: Rename a site or replace its API key
   *     description: A new API key is tried straight away.
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
   *         description: The site.
   *       404:
   *         description: No such site.
   */
  router.put("/sites/:id", async (req: Request, res: Response) => {
    try {
      res.json({
        site: await sites.update(idOf(req), {
          name: text(req.body?.name, 100) || undefined,
          apiKey: text(req.body?.apiKey, 500) || undefined,
        }),
      });
    } catch (error) {
      fail(res, error, "Failed to update the site");
    }
  });

  /**
   * @openapi
   * /plugin-api/sync/sites/{id}:
   *   delete:
   *     summary: Remove a remote site
   *     description: Forgets the site and its cached hosts. The API key stays valid on the remote until it is deleted there.
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
   *         description: Removed.
   */
  router.delete("/sites/:id", async (req: Request, res: Response) => {
    try {
      await sites.remove(idOf(req));
      res.json({ success: true });
    } catch (error) {
      fail(res, error, "Failed to remove the site");
    }
  });

  /**
   * @openapi
   * /plugin-api/sync/sites/{id}/refresh:
   *   post:
   *     summary: Read a site's hosts and status again
   *     description: Hosts and status are also refreshed every minute.
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
   *         description: The site after the refresh.
   *       404:
   *         description: No such site.
   */
  router.post("/sites/:id/refresh", async (req: Request, res: Response) => {
    try {
      res.json({ site: await sites.refresh(idOf(req)) });
    } catch (error) {
      fail(res, error, "Failed to refresh the site");
    }
  });

  /**
   * @openapi
   * /plugin-api/sync/sites/{id}/hosts:
   *   get:
   *     summary: A site's hosts
   *     description: Read only. The hosts the API key's user can see on the remote, as of the last refresh.
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
   *         description: The hosts.
   */
  router.get("/sites/:id/hosts", async (req: Request, res: Response) => {
    try {
      res.json({ hosts: await sites.hostsOf(idOf(req)) });
    } catch (error) {
      fail(res, error, "Failed to list hosts");
    }
  });

  return router;
}
