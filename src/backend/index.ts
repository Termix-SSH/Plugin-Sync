import crypto from "node:crypto";
import express from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { devices, siteHosts, sites, webAccounts } from "./tables.js";
import { createDeviceStore } from "./devices.js";
import { createServerRouter } from "./server-routes.js";
import { createClientRouter } from "./client-routes.js";
import { createAccountsRouter } from "./accounts-routes.js";
import { EngineManager } from "./engines.js";
import { createSites } from "./sites.js";
import { createSitesRouter } from "./sites-routes.js";
import { registerSiteTerminal } from "./site-terminal.js";

const SITE_REFRESH_MS = 60_000;

export async function activate(ctx: PluginContext) {
  const host = ctx.sync.host;
  const devicesTable = await ctx.db.define(devices);
  const webTable = await ctx.db.define(webAccounts);
  const sitesTable = await ctx.db.define(sites);
  const siteHostsTable = await ctx.db.define(siteHosts);
  const deviceStore = createDeviceStore(ctx, devicesTable);

  const log = {
    error: (message: string, meta?: unknown) =>
      ctx.log.error(`${message}${meta ? `: ${String(meta)}` : ""}`),
    warn: (message: string, meta?: unknown) =>
      ctx.log.warn(`${message}${meta ? `: ${JSON.stringify(meta)}` : ""}`),
  };

  const manager = new EngineManager(host, log);

  // A stable id for this install, sent when it links so a server can list it.
  const deviceId = async (): Promise<string | null> => {
    const saved = await ctx.kv.get("deviceId");
    if (typeof saved === "string" && saved) return saved;
    const created = crypto.randomUUID().replace(/-/g, "");
    await ctx.kv.set("deviceId", created);
    return created;
  };
  const siteStore = createSites(
    ctx,
    host,
    { sites: sitesTable, hosts: siteHostsTable },
    log,
  );

  const router = express.Router();
  router.use(createServerRouter(host, deviceStore, log));
  // The plugin's own screens talk to the plugin API, the protocol stays on /sync.
  const api = ctx.http.router<express.Router>();
  api.use(createAccountsRouter({ ctx, host, manager, webTable, log }));
  api.use(createSitesRouter(ctx, host, siteStore, log));
  registerSiteTerminal(ctx, siteStore, log);

  // Hosts mirrored from a site stay read only here; the site is the source.
  ctx.hosts.locks.provide({
    isLocked: (hostId) => siteStore.siteNameOf(hostId) !== null,
    note: (hostId) => {
      const name = siteStore.siteNameOf(hostId);
      return name ? `Synced from ${name}. Change it on that site.` : null;
    },
    allowManualCreate: () => true,
  });
  await siteStore.loadMirrored();
  if (host.embedded) {
    // The same routes answer on /sync for core and on the plugin API for the
    // plugin's own screens.
    const client = createClientRouter(host, manager, deviceId, log);
    router.use(client);
    api.use(client);
  }

  ctx.sync.provide({
    handle: (req, res, next) => {
      router(req as express.Request, res as express.Response, next);
    },
  });

  if (!host.embedded) {
    ctx.schedule.every(SITE_REFRESH_MS, () => siteStore.refreshAll());
  }

  if (host.embedded) {
    await manager.startAll();
    void manager.applyActiveProxy().catch(() => {});
    ctx.disposables.add(() => manager.stopAll());
  }
}

export async function deactivate() {
  // Everything above was registered through ctx and is disposed by core.
}
