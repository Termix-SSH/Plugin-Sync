/**
 * Remote sites: other Termix servers a master manages. The master holds an
 * API key made on each remote, reads its hosts and status with it, and opens
 * sessions through it. What the key's user can see on the remote is all the
 * master can see, and the remote does the connecting.
 */

import { eq } from "drizzle-orm";
import type {
  PluginContext,
  PluginSyncHost,
} from "@termix-ssh/plugin-sdk/backend";

export interface SiteRecord {
  id: number;
  name: string;
  baseUrl: string;
  status: "pending" | "ok" | "error";
  lastError: string | null;
  lastSeenAt: string | null;
  hostCount: number | null;
}

export interface SiteHostRecord {
  id: number;
  siteId: number;
  remoteId: number;
  name: string;
  address: string | null;
  protocol: string | null;
  folder: string | null;
  tags: string[];
  status: string | null;
}

export interface Overview {
  sites: number;
  reachable: number;
  unreachable: number;
  hosts: number;
  online: number;
  offline: number;
}

/** What the remote's own API says about a host, trimmed to what the master shows. */
interface RemoteHost {
  id: number;
  name?: string | null;
  ip?: string | null;
  port?: number | null;
  username?: string | null;
  connectionType?: string | null;
  folder?: string | null;
  tags?: string[] | string | null;
  authType?: string | null;
  credentialId?: number | null;
}

export interface SiteStores {
  sites: any;
  hosts: any;
}

export class SiteError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function normalizeBaseUrl(
  host: PluginSyncHost,
  input: unknown,
): string | null {
  return typeof input === "string" ? host.http.normalizeServerUrl(input) : null;
}

function parseTags(tags: RemoteHost["tags"]): string[] {
  if (Array.isArray(tags)) return tags.map(String).slice(0, 20);
  if (typeof tags === "string") {
    return tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  return [];
}

function statusOf(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const value = (entry as { status?: unknown }).status;
  if (typeof value === "string") return value;
  return null;
}

export function createSites(
  ctx: PluginContext,
  host: PluginSyncHost,
  stores: SiteStores,
  log: { warn: (message: string, meta?: unknown) => void },
) {
  const db = () => ctx.db.client<any>();

  const toRecord = (row: any): SiteRecord => ({
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    status: (row.status as SiteRecord["status"]) ?? "pending",
    lastError: row.lastError ?? null,
    lastSeenAt: row.lastSeenAt ?? null,
    hostCount: row.hostCount ?? null,
  });

  async function keyOf(row: { apiKey: string }): Promise<string> {
    const key = await ctx.secrets.unseal(row.apiKey);
    if (!key) throw new SiteError("The saved API key can't be read", 500);
    return key;
  }

  /** A request to the remote, as the key's user. */
  async function call<T>(
    row: { baseUrl: string; apiKey: string },
    pathname: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const key = await keyOf(row);
    return host.http.json<T>(
      {
        serverUrl: row.baseUrl,
        customHeaders: [{ name: "Authorization", value: `Bearer ${key}` }],
      },
      pathname,
      { method: init.method, body: init.body, timeoutMs: 20_000 },
    );
  }

  function describeError(error: unknown): string {
    if (host.http.isRemoteError(error)) {
      if (error.kind === "signed_out") return "The API key was refused";
      if (error.kind === "offline") return "The site can't be reached";
      if (error.kind === "tls") return "The site's certificate isn't trusted";
      return error.message;
    }
    return error instanceof Error ? error.message : String(error);
  }

  async function list(): Promise<SiteRecord[]> {
    const rows = await (await db()).select().from(stores.sites);
    return rows
      .map(toRecord)
      .sort((a: SiteRecord, b: SiteRecord) => a.name.localeCompare(b.name));
  }

  async function getRow(id: number) {
    const [row] = await (
      await db()
    )
      .select()
      .from(stores.sites)
      .where(eq(stores.sites.id, id))
      .limit(1);
    return row ?? null;
  }

  /** Reads the remote's hosts and status and keeps the answer. */
  async function refresh(id: number): Promise<SiteRecord> {
    const row = await getRow(id);
    if (!row) throw new SiteError("No such site", 404);
    const client = await db();
    try {
      const remote = await call<RemoteHost[]>(row, "/host/db/host");
      if (!Array.isArray(remote)) {
        throw new SiteError("That doesn't look like a Termix server");
      }
      let statuses: Record<string, unknown> = {};
      try {
        statuses = await call<Record<string, unknown>>(row, "/host/status");
      } catch {
        // Hosts are still worth listing without their status.
      }
      await client.delete(stores.hosts).where(eq(stores.hosts.siteId, id));
      const hosts = remote.slice(0, 5000).map((entry) => ({
        siteId: id,
        remoteId: entry.id,
        name: String(entry.name || entry.ip || `Host ${entry.id}`).slice(
          0,
          255,
        ),
        address: entry.ip ? String(entry.ip).slice(0, 255) : null,
        protocol: entry.connectionType
          ? String(entry.connectionType).slice(0, 40)
          : null,
        folder: entry.folder ? String(entry.folder).slice(0, 255) : null,
        tags: JSON.stringify(parseTags(entry.tags)),
        status: statusOf(statuses[String(entry.id)]),
      }));
      for (let i = 0; i < hosts.length; i += 200) {
        await client.insert(stores.hosts).values(hosts.slice(i, i + 200));
      }
      await client
        .update(stores.sites)
        .set({
          status: "ok",
          lastError: null,
          lastSeenAt: new Date().toISOString(),
          hostCount: hosts.length,
        })
        .where(eq(stores.sites.id, id));
    } catch (error) {
      const message = describeError(error);
      log.warn("Could not refresh a site", { site: row.name, error: message });
      await client
        .update(stores.sites)
        .set({ status: "error", lastError: message })
        .where(eq(stores.sites.id, id));
    }
    await ctx.db.persist();
    return toRecord((await getRow(id))!);
  }

  async function create(input: {
    name: string;
    baseUrl: string;
    apiKey: string;
  }): Promise<SiteRecord> {
    const client = await db();
    const [existing] = await client
      .select()
      .from(stores.sites)
      .where(eq(stores.sites.baseUrl, input.baseUrl))
      .limit(1);
    if (existing) throw new SiteError("That site is already added", 409);
    await client.insert(stores.sites).values({
      name: input.name,
      baseUrl: input.baseUrl,
      apiKey: await ctx.secrets.seal(input.apiKey),
      status: "pending",
    });
    const [row] = await client
      .select()
      .from(stores.sites)
      .where(eq(stores.sites.baseUrl, input.baseUrl))
      .limit(1);
    await ctx.db.persist();
    return refresh(row.id);
  }

  async function update(
    id: number,
    input: { name?: string; apiKey?: string },
  ): Promise<SiteRecord> {
    const row = await getRow(id);
    if (!row) throw new SiteError("No such site", 404);
    const set: Record<string, unknown> = {};
    if (input.name) set.name = input.name;
    if (input.apiKey) set.apiKey = await ctx.secrets.seal(input.apiKey);
    if (Object.keys(set).length > 0) {
      await (
        await db()
      )
        .update(stores.sites)
        .set(set)
        .where(eq(stores.sites.id, id));
      await ctx.db.persist();
    }
    return input.apiKey ? refresh(id) : toRecord((await getRow(id))!);
  }

  async function remove(id: number): Promise<void> {
    const client = await db();
    await client.delete(stores.hosts).where(eq(stores.hosts.siteId, id));
    await client.delete(stores.sites).where(eq(stores.sites.id, id));
    await ctx.db.persist();
  }

  async function hostsOf(id: number): Promise<SiteHostRecord[]> {
    const rows = await (
      await db()
    )
      .select()
      .from(stores.hosts)
      .where(eq(stores.hosts.siteId, id));
    return rows
      .map((row: any) => ({
        id: row.id,
        siteId: row.siteId,
        remoteId: row.remoteId,
        name: row.name,
        address: row.address ?? null,
        protocol: row.protocol ?? null,
        folder: row.folder ?? null,
        tags: (() => {
          try {
            return JSON.parse(row.tags ?? "[]") as string[];
          } catch {
            return [];
          }
        })(),
        status: row.status ?? null,
      }))
      .sort((a: SiteHostRecord, b: SiteHostRecord) =>
        a.name.localeCompare(b.name),
      );
  }

  async function overview(): Promise<Overview> {
    const sites = await list();
    const rows = await (await db()).select().from(stores.hosts);
    const online = rows.filter((row: any) => row.status === "online").length;
    const offline = rows.filter((row: any) => row.status === "offline").length;
    return {
      sites: sites.length,
      reachable: sites.filter((site) => site.status === "ok").length,
      unreachable: sites.filter((site) => site.status === "error").length,
      hosts: rows.length,
      online,
      offline,
    };
  }

  async function refreshAll(): Promise<void> {
    for (const site of await list()) {
      await refresh(site.id).catch(() => {});
    }
  }

  /**
   * What the remote needs to start a session on a host: the host as its own
   * API describes it. Secrets stay on the remote and are found there by id.
   */
  async function hostConfig(id: number, remoteId: number) {
    const row = await getRow(id);
    if (!row) throw new SiteError("No such site", 404);
    const remote = await call<RemoteHost>(row, `/host/db/host/${remoteId}`);
    return {
      id: remote.id,
      ip: remote.ip,
      port: remote.port ?? 22,
      username: remote.username,
      authType: remote.authType,
      credentialId: remote.credentialId ?? undefined,
    };
  }

  /** A one minute ticket for opening the remote's terminal socket as the key's user. */
  async function socketTicket(
    id: number,
  ): Promise<{ baseUrl: string; ticket: string }> {
    const row = await getRow(id);
    if (!row) throw new SiteError("No such site", 404);
    const { ticket } = await call<{ ticket: string }>(
      row,
      "/users/ws-ticket/api-key",
      { method: "POST", body: {} },
    );
    return { baseUrl: row.baseUrl, ticket };
  }

  return {
    list,
    create,
    update,
    remove,
    refresh,
    refreshAll,
    hostsOf,
    overview,
    hostConfig,
    socketTicket,
    get: async (id: number) => {
      const row = await getRow(id);
      return row ? toRecord(row) : null;
    },
  };
}

export type Sites = ReturnType<typeof createSites>;
