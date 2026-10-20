/**
 * Remote sites: other Termix servers a master manages. The master holds an
 * API key made on each remote and keeps that remote's SSH hosts as real hosts
 * of its own, in a folder named after the site. They are locked, so the site
 * stays the source of truth. The logins are copied too, so every tool works,
 * and the SSH connection is carried through the remote relay socket: the
 * remote reaches the host and the master only passes bytes.
 * What the key's user can see on the remote is all the master can mirror.
 */

import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type {
  PluginContext,
  PluginHostCreateInput,
  PluginSyncHost,
} from "@termix-ssh/plugin-sdk/backend";

export interface SiteRecord {
  id: number;
  name: string;
  baseUrl: string;
  ownerId: string;
  shareRoles: number[];
  status: "pending" | "ok" | "error";
  lastError: string | null;
  lastSeenAt: string | null;
  hostCount: number | null;
}

export interface Overview {
  sites: number;
  reachable: number;
  unreachable: number;
  hosts: number;
  online: number;
  offline: number;
}

/** What the remote's own API says about a host, trimmed to what is mirrored. */
interface RemoteHost {
  id: number;
  name?: string | null;
  ip?: string | null;
  port?: number | null;
  username?: string | null;
  connectionType?: string | null;
  enableSsh?: boolean | null;
  folder?: string | null;
  tags?: string[] | string | null;
  authType?: string | null;
  credentialId?: number | null;
}

/** A host's login as the remote's export carries it. */
interface RemoteSecret {
  exportId?: number;
  username?: string | null;
  authType?: string | null;
  password?: string | null;
  key?: string | null;
  keyPassword?: string | null;
  keyType?: string | null;
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
  return typeof value === "string" ? value : null;
}

function parseRoles(value: unknown): number[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed)
      ? parsed.filter((id): id is number => Number.isSafeInteger(id))
      : [];
  } catch {
    return [];
  }
}

/** Only SSH hosts can be carried through the remote's relay. */
const SITE_FOLDER_ICON = "cloud-cog";

function mirrorable(host: RemoteHost): boolean {
  const type = host.connectionType || "ssh";
  return type === "ssh" && host.enableSsh !== false && !!host.ip;
}

export function createSites(
  ctx: PluginContext,
  host: PluginSyncHost,
  stores: SiteStores,
  log: { warn: (message: string, meta?: unknown) => void },
) {
  const db = () => ctx.db.client<any>();
  /** Host id to the name of the site it mirrors, for the lock note. */
  const mirrored = new Map<number, string>();

  const toRecord = (row: any, hostCount: number | null): SiteRecord => ({
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    ownerId: row.ownerId,
    shareRoles: parseRoles(row.shareRoles),
    status: (row.status as SiteRecord["status"]) ?? "pending",
    lastError: row.lastError ?? null,
    lastSeenAt: row.lastSeenAt ?? null,
    hostCount,
  });

  async function countOf(siteId: number): Promise<number> {
    const rows = await (
      await db()
    )
      .select()
      .from(stores.hosts)
      .where(eq(stores.hosts.siteId, siteId));
    return rows.length;
  }

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

  async function view(row: any): Promise<SiteRecord> {
    return toRecord(row, await countOf(row.id));
  }

  async function list(): Promise<SiteRecord[]> {
    const rows = await (await db()).select().from(stores.sites);
    const out = await Promise.all(rows.map((row: any) => view(row)));
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  const grantsFor = (roles: number[]) =>
    roles.map((id) => ({
      target: { type: "role" as const, id },
      permissionLevel: "connect" as const,
    }));

  /** Rebuilds the lock lookup from what is mirrored now. */
  async function loadMirrored(): Promise<void> {
    const client = await db();
    const siteRows = await client.select().from(stores.sites);
    const names = new Map<number, string>(
      siteRows.map((row: any) => [row.id, row.name]),
    );
    const rows = await client.select().from(stores.hosts);
    mirrored.clear();
    for (const row of rows) {
      mirrored.set(row.hostId, names.get(row.siteId) ?? "a remote site");
    }
  }

  /** Copies the saved login. A host with none asks for it when opened. */
  function login(
    secret?: RemoteSecret,
  ): Pick<
    PluginHostCreateInput,
    "authType" | "password" | "key" | "keyPassword" | "keyType"
  > {
    if (secret?.key) {
      return {
        authType: "key",
        key: secret.key,
        keyPassword: secret.keyPassword || null,
        keyType: secret.keyType || null,
      };
    }
    if (secret?.password)
      return { authType: "password", password: secret.password };
    return { authType: "none" };
  }

  function desired(
    site: { id: number; name: string },
    remote: RemoteHost,
    status: string | null,
    secret?: RemoteSecret,
  ): PluginHostCreateInput {
    const folder = remote.folder
      ? `${site.name} / ${remote.folder}`
      : site.name;
    return {
      name: String(remote.name || remote.ip).slice(0, 255),
      ip: String(remote.ip),
      port: remote.port ?? 22,
      username: String(secret?.username || remote.username || ""),
      ...login(secret),
      connectionType: "ssh",
      enableSsh: true,
      // The remote checks status, and the dot comes from its answer.
      statusCheckEnabled: false,
      folder,
      tags: parseTags(remote.tags),
      pluginSettings: {
        [ctx.pluginId]: {
          siteId: site.id,
          remoteId: remote.id,
          remoteStatus: status ?? "unknown",
        },
      },
    };
  }

  const signatureOf = (input: PluginHostCreateInput, roles: number[]) =>
    crypto
      .createHash("sha256")
      .update(JSON.stringify([input, roles]))
      .digest("hex")
      .slice(0, 40);

  /** Brings the mirrored hosts in line with what the remote lists. */
  async function mirror(
    row: any,
    remoteHosts: RemoteHost[],
    statuses: Record<string, unknown>,
    secrets: Map<number, RemoteSecret>,
  ): Promise<number> {
    const client = await db();
    const roles = parseRoles(row.shareRoles);
    const mapped = await client
      .select()
      .from(stores.hosts)
      .where(eq(stores.hosts.siteId, row.id));
    const byRemote = new Map<number, any>(
      mapped.map((entry: any) => [entry.remoteId, entry]),
    );
    const seen = new Set<number>();
    let failed = 0;

    await ctx.asUser(row.ownerId, async () => {
      await ctx.hosts.folders
        .ensure(row.name, { icon: SITE_FOLDER_ICON })
        .catch(() => {});
      for (const remote of remoteHosts.filter(mirrorable).slice(0, 5000)) {
        seen.add(remote.id);
        const status = statusOf(statuses[String(remote.id)]);
        const input = desired(row, remote, status, secrets.get(remote.id));
        const signature = signatureOf(input, roles);
        const existing = byRemote.get(remote.id);
        try {
          if (existing && existing.signature === signature) continue;
          if (existing) {
            // Pins and order stay with each user, so they are never written.
            const updated = await ctx.hosts.update(existing.hostId, input);
            if (updated) {
              await client
                .update(stores.hosts)
                .set({ signature, status })
                .where(eq(stores.hosts.id, existing.id));
              continue;
            }
            // Deleted outside the plugin, so it comes back as a new host.
            await client
              .delete(stores.hosts)
              .where(eq(stores.hosts.id, existing.id));
          }
          const created = await ctx.hosts.create(input);
          if (roles.length > 0) {
            await ctx.hosts.setShares(created.id, grantsFor(roles));
          }
          await client.insert(stores.hosts).values({
            siteId: row.id,
            remoteId: remote.id,
            hostId: created.id,
            signature,
            status,
          });
        } catch (error) {
          failed++;
          log.warn("Could not mirror a host", {
            site: row.name,
            host: remote.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      for (const entry of mapped) {
        if (seen.has(entry.remoteId)) continue;
        try {
          await ctx.hosts.delete(entry.hostId);
          await client
            .delete(stores.hosts)
            .where(eq(stores.hosts.id, entry.id));
        } catch (error) {
          failed++;
          log.warn("Could not remove a mirrored host", {
            site: row.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
    if (failed > 0) {
      throw new SiteError(`${failed} hosts could not be written here`, 500);
    }
    return seen.size;
  }

  /**
   * The key's own hosts with their logins. It needs the import and export
   * plugin on the remote. Without it hosts are mirrored with no saved login.
   */
  async function secretsOf(row: {
    baseUrl: string;
    apiKey: string;
  }): Promise<Map<number, RemoteSecret>> {
    try {
      const out = await call<{ hosts?: RemoteSecret[] }>(
        row,
        "/plugin-api/import-export/export",
      );
      return new Map(
        (out.hosts ?? [])
          .filter((entry) => typeof entry.exportId === "number")
          .map((entry) => [entry.exportId as number, entry]),
      );
    } catch {
      return new Map();
    }
  }

  /** Reads the remote's hosts and status and mirrors them. */
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
        // Hosts are still worth mirroring without their status.
      }
      await mirror(row, remote, statuses, await secretsOf(row));
      await client
        .update(stores.sites)
        .set({
          status: "ok",
          lastError: null,
          lastSeenAt: new Date().toISOString(),
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
    await loadMirrored();
    return view((await getRow(id))!);
  }

  async function create(input: {
    name: string;
    baseUrl: string;
    apiKey: string;
    ownerId: string;
    shareRoles: number[];
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
      ownerId: input.ownerId,
      shareRoles: JSON.stringify(input.shareRoles),
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
    input: { name?: string; apiKey?: string; shareRoles?: number[] },
  ): Promise<SiteRecord> {
    const row = await getRow(id);
    if (!row) throw new SiteError("No such site", 404);
    const set: Record<string, unknown> = {};
    if (input.name) set.name = input.name;
    if (input.apiKey) set.apiKey = await ctx.secrets.seal(input.apiKey);
    if (input.shareRoles) set.shareRoles = JSON.stringify(input.shareRoles);
    if (Object.keys(set).length > 0) {
      await (
        await db()
      )
        .update(stores.sites)
        .set(set)
        .where(eq(stores.sites.id, id));
      await ctx.db.persist();
    }
    // A new name moves the folder and new roles change who can see the hosts,
    // so both rewrite every host on the next pass.
    if (input.name || input.shareRoles) {
      await (
        await db()
      )
        .update(stores.hosts)
        .set({ signature: null })
        .where(eq(stores.hosts.siteId, id));
      if (input.shareRoles) await reshare(id, input.shareRoles);
    }
    if (!(input.apiKey || input.name || input.shareRoles)) {
      return view((await getRow(id))!);
    }
    const refreshed = await refresh(id);
    if (input.name && input.name !== row.name) {
      await ctx.asUser(row.ownerId, () =>
        ctx.hosts.folders.removeEmpty(row.name).catch(() => false),
      );
    }
    return refreshed;
  }

  async function reshare(id: number, roles: number[]): Promise<void> {
    const row = await getRow(id);
    if (!row) return;
    const mapped = await (
      await db()
    )
      .select()
      .from(stores.hosts)
      .where(eq(stores.hosts.siteId, id));
    await ctx.asUser(row.ownerId, async () => {
      for (const entry of mapped) {
        await ctx.hosts
          .setShares(entry.hostId, grantsFor(roles))
          .catch((error: unknown) =>
            log.warn("Could not share a mirrored host", {
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      }
    });
  }

  async function remove(id: number): Promise<void> {
    const row = await getRow(id);
    const client = await db();
    if (row) {
      const mapped = await client
        .select()
        .from(stores.hosts)
        .where(eq(stores.hosts.siteId, id));
      await ctx.asUser(row.ownerId, async () => {
        for (const entry of mapped) {
          await ctx.hosts.delete(entry.hostId).catch(() => false);
        }
        await ctx.hosts.folders.removeEmpty(row.name).catch(() => false);
      });
    }
    await client.delete(stores.hosts).where(eq(stores.hosts.siteId, id));
    await client.delete(stores.sites).where(eq(stores.sites.id, id));
    await ctx.db.persist();
    await loadMirrored();
  }

  async function overview(): Promise<Overview> {
    const sites = await list();
    const rows = await (await db()).select().from(stores.hosts);
    return {
      sites: sites.length,
      reachable: sites.filter((site) => site.status === "ok").length,
      unreachable: sites.filter((site) => site.status === "error").length,
      hosts: rows.length,
      online: rows.filter((row: any) => row.status === "online").length,
      offline: rows.filter((row: any) => row.status === "offline").length,
    };
  }

  async function refreshAll(): Promise<void> {
    for (const site of await list()) {
      await refresh(site.id).catch(() => {});
    }
  }

  /** The site and remote id a mirrored host stands for. */
  async function mappingOf(
    hostId: number,
  ): Promise<{ siteId: number; remoteId: number } | null> {
    const [entry] = await (
      await db()
    )
      .select()
      .from(stores.hosts)
      .where(eq(stores.hosts.hostId, hostId))
      .limit(1);
    return entry ? { siteId: entry.siteId, remoteId: entry.remoteId } : null;
  }

  /** A one minute ticket for opening the remote's relay socket as the key's user. */
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
    overview,
    mappingOf,
    socketTicket,
    loadMirrored,
    /** For the host lock: the site a host is mirrored from, if any. */
    siteNameOf: (hostId: number) => mirrored.get(hostId) ?? null,
    get: async (id: number) => {
      const row = await getRow(id);
      return row ? view(row) : null;
    },
  };
}

export type Sites = ReturnType<typeof createSites>;
