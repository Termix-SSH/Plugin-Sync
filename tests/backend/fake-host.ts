/**
 * An in memory PluginSyncHost for tests: one entity type ("things") with
 * revisions, a change feed and a push applier that follow the same rules as
 * core's. A "side" is a server or a desktop. A desktop's http goes to a real
 * express server running the plugin's server routes over a server side.
 */

import type {
  PluginSyncHost,
  SyncConflictInfo,
  SyncLinkCreate,
  SyncLinkInfo,
  SyncLinkPatch,
  SyncPushOp,
  SyncPushResult,
  SyncRecordInfo,
  SyncRow,
  SyncWireRow,
} from "@termix-ssh/plugin-sdk/backend";

export const SERVER_USER = "srv-user";
export const DESKTOP_USER = "desk-user";

export class FakeRemoteError extends Error {
  constructor(
    readonly kind: "offline" | "signed_out" | "server",
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const hashOf = (wire: SyncRow) => JSON.stringify(wire);
const key = (type: string, syncId: string) => `${type}\u0000${syncId}`;

export interface SideOptions {
  embedded: boolean;
  /** For a desktop: the base url of the server to talk to. */
  serverUrl?: () => string;
}

export class Side {
  rows = new Map<string, Map<string, SyncRow>>();
  records = new Map<string, Map<string, SyncRecordInfo>>();
  conflicts = new Map<string, SyncConflictInfo[]>();
  links = new Map<string, SyncLinkInfo>();
  /** The account requests are made as; defaults to the side's one user. */
  currentUser: string | null = null;
  activeUser = DESKTOP_USER;
  accountIds: string[] = [DESKTOP_USER];
  sealed = new Map<string, string>();
  cookies: Record<string, string> = {};
  validTokens = new Map<string, { userId: string; sessionId: string }>();

  get link(): SyncLinkInfo | null {
    return this.links.get(DESKTOP_USER) ?? null;
  }

  set link(value: SyncLinkInfo | null) {
    if (value) this.links.set(DESKTOP_USER, value);
    else this.links.delete(DESKTOP_USER);
  }
  seq = 0;
  nextConflict = 1;
  sessions: string[] = [];
  revoked: string[] = [];
  proxy: unknown[] = [];
  alerts: unknown[] = [];
  pluginsMirrored = 0;
  /** Syncids whose push the side refuses. */
  refuse = new Set<string>();
  offline = false;

  constructor(readonly options: SideOptions) {}

  rowsOf(userId: string) {
    let map = this.rows.get(userId);
    if (!map) this.rows.set(userId, (map = new Map()));
    return map;
  }

  recordsOf(userId: string) {
    let map = this.records.get(userId);
    if (!map) this.records.set(userId, (map = new Map()));
    return map;
  }

  put(userId: string, syncId: string, name: string) {
    this.rowsOf(userId).set(syncId, { syncId, name });
  }

  remove(userId: string, syncId: string) {
    this.rowsOf(userId).delete(syncId);
  }

  names(userId: string): Record<string, string> {
    return Object.fromEntries(
      [...this.rowsOf(userId).values()].map((row) => [
        String(row.syncId),
        String(row.name),
      ]),
    );
  }

  /** Brings the records up to date with the rows, like core's reconcile. */
  reconcile(userId: string) {
    const records = this.recordsOf(userId);
    for (const wire of this.rowsOf(userId).values()) {
      const k = key("things", String(wire.syncId));
      const record = records.get(k);
      const hash = hashOf(wire);
      if (!record || record.deleted || record.hash !== hash) {
        records.set(k, {
          entityType: "things",
          syncId: String(wire.syncId),
          revision: (record?.revision ?? 0) + 1,
          hash,
          deleted: false,
          error: null,
          errorHash: null,
          seq: ++this.seq,
        });
      }
    }
    for (const record of records.values()) {
      if (record.deleted) continue;
      if (!this.rowsOf(userId).has(record.syncId)) {
        records.set(key("things", record.syncId), {
          ...record,
          revision: record.revision + 1,
          hash: null,
          deleted: true,
          seq: ++this.seq,
        });
      }
    }
  }

  changes(userId: string, cursor: number, limit: number) {
    this.reconcile(userId);
    const all = [...this.recordsOf(userId).values()]
      .filter((record) => record.seq > cursor)
      .sort((a, b) => a.seq - b.seq);
    const page = all.slice(0, limit);
    return {
      records: page.map((record) => ({
        seq: record.seq,
        entityType: record.entityType,
        syncId: record.syncId,
        revision: record.revision,
        deleted: record.deleted,
        row: record.deleted
          ? null
          : (this.rowsOf(userId).get(record.syncId) ?? null),
      })),
      hasMore: all.length > limit,
      nextCursor: page.length ? page[page.length - 1].seq : cursor,
      entityTypes: [
        { type: "things", owner: "core", order: 1, readOnly: false },
      ],
    };
  }

  applyPush(userId: string, ops: SyncPushOp[]): SyncPushResult[] {
    this.reconcile(userId);
    return ops.map((op): SyncPushResult => {
      const base = { syncId: op.syncId, entityType: op.entityType };
      if (this.refuse.has(op.syncId)) {
        return { ...base, status: "rejected", reason: "invalid" };
      }
      const k = key(op.entityType, op.syncId);
      const record = this.recordsOf(userId).get(k);
      const current = record?.revision ?? 0;
      if (op.baseRevision !== current) {
        return {
          ...base,
          status: "conflict",
          revision: current,
          deleted: !!record?.deleted,
          row: record?.deleted
            ? null
            : (this.rowsOf(userId).get(op.syncId) ?? null),
        };
      }
      if (op.op === "delete") this.remove(userId, op.syncId);
      else this.rowsOf(userId).set(op.syncId, { ...op.row, syncId: op.syncId });
      this.reconcile(userId);
      return {
        ...base,
        status: "ok",
        revision: this.recordsOf(userId).get(k)!.revision,
      };
    });
  }
}

/** Express middleware: everyone is the one user of that side. */
function middlewareFor(side: Side) {
  return () => (req: any, _res: unknown, next: () => void) => {
    req.userId =
      side.currentUser ?? (side.options.embedded ? DESKTOP_USER : SERVER_USER);
    req.sessionId = "login-session";
    next();
  };
}

export function createHost(
  side: Side,
  serverSide?: () => Side,
): PluginSyncHost {
  const remote = () => side.options.serverUrl!();
  const userKey = (userId?: string) => userId ?? side.activeUser;
  const links = {
    list: async () => [...side.links.values()],
    get: async (userId?: string) => side.links.get(userKey(userId)) ?? null,
    create: async (input: SyncLinkCreate) => {
      const link: SyncLinkInfo = {
        id: side.links.size + 1,
        userId: input.userId,
        serverUrl: input.serverUrl,
        serverName: input.serverName ?? null,
        serverVersion: input.serverVersion ?? null,
        sessionToken: input.sessionToken,
        customHeaders: input.customHeaders ?? [],
        basicAuth: input.basicAuth ?? null,
        allowInvalidCertificate: !!input.allowInvalidCertificate,
        remoteUserId: input.remoteUserId ?? null,
        remoteUsername: input.remoteUsername ?? null,
        account: null,
        disabledTypes: [],
        options: {},
        knownTypes: [],
        cursor: 0,
        status: "idle",
        lastError: null,
        linkedAt: new Date().toISOString(),
        lastSyncAt: null,
      };
      side.links.set(input.userId, link);
      return link;
    },
    update: async (patch: SyncLinkPatch, userId?: string) => {
      const current = side.links.get(userKey(userId));
      if (!current) return null;
      const next = { ...current, ...patch } as SyncLinkInfo;
      side.links.set(current.userId, next);
      return next;
    },
    remove: async (userId?: string) => {
      side.links.delete(userKey(userId));
    },
  };

  const accounts = {
    list: async () =>
      side.accountIds.map((id) => ({
        id,
        username: id,
        isAdmin: true,
        active: id === side.activeUser,
      })),
    create: async () => {
      const id = `account-${side.accountIds.length + 1}`;
      side.accountIds.push(id);
      return id;
    },
    setActive: async (userId: string) => {
      side.activeUser = userId;
    },
    activeId: async () => side.activeUser,
    remove: async (userId: string) => {
      side.accountIds = side.accountIds.filter((id) => id !== userId);
      side.links.delete(userId);
    },
  };

  const host: Partial<PluginSyncHost> = {
    embedded: side.options.embedded,
    info: { appName: async () => "Test", version: () => "26.10.3" },
    entities: {
      list: () => [
        { type: "things", owner: "core", order: 1, readOnly: false },
      ],
      get: (type) =>
        type === "things"
          ? { type, owner: "core", order: 1, readOnly: false }
          : undefined,
      ensureCore: async () => {},
      onChanged: () => () => {},
      onLocalWrite: () => () => {},
    },
    replica: {
      resolvers: () => ({}),
      loadRows: async (_type, userId) => {
        const rows = new Map<string, SyncWireRow>();
        for (const wire of side.rowsOf(userId).values()) {
          rows.set(String(wire.syncId), {
            syncId: String(wire.syncId),
            wire,
            hash: hashOf(wire),
          });
        }
        return { rows, failed: new Set<string>() };
      },
      loadRow: async (_type, userId, syncId) => {
        const wire = side.rowsOf(userId).get(syncId);
        return wire ? { syncId, wire, hash: hashOf(wire) } : null;
      },
      writeRow: async (_type, userId, wire) => {
        side.rowsOf(userId).set(String(wire.syncId), { ...wire });
      },
      deleteRow: async (_type, userId, syncId) => {
        side.remove(userId, syncId);
      },
      orderSelfReferences: (_type, rows) => rows,
      counts: async (userId) => ({ things: side.rowsOf(userId).size }),
      wipe: async (userId) => {
        side.rowsOf(userId).clear();
      },
      regenerateSyncIds: async (userId) => {
        const rows = side.rowsOf(userId);
        const copy = [...rows.values()];
        rows.clear();
        copy.forEach((row, index) => {
          const syncId = `new-${index}-${row.syncId}`;
          rows.set(syncId, { ...row, syncId });
        });
      },
      removeSharedCopies: async () => {},
      records: {
        list: async (userId) => new Map(side.recordsOf(userId)),
        put: async (userId, type, syncId, values) => {
          const record = side.recordsOf(userId).get(key(type, syncId));
          side.recordsOf(userId).set(key(type, syncId), {
            entityType: type,
            syncId,
            revision: values.revision,
            hash: values.hash,
            deleted: values.deleted,
            error: null,
            errorHash: null,
            seq: record?.seq ?? 0,
          });
        },
        setError: async (userId, type, syncId, reason, hash) => {
          const record = side.recordsOf(userId).get(key(type, syncId));
          side.recordsOf(userId).set(key(type, syncId), {
            entityType: type,
            syncId,
            revision: record?.revision ?? 0,
            hash: record?.hash ?? null,
            deleted: record?.deleted ?? false,
            error: reason,
            errorHash: hash,
            seq: record?.seq ?? 0,
          });
        },
        clearErrors: async (userId) => {
          for (const [k, record] of side.recordsOf(userId)) {
            side.recordsOf(userId).set(k, {
              ...record,
              error: null,
              errorHash: null,
            });
          }
        },
        listErrors: async (userId) =>
          [...side.recordsOf(userId).values()].filter((r) => !!r.error),
        deleteForUser: async (userId) => {
          side.records.delete(userId);
          side.conflicts.delete(userId);
        },
        key,
      },
      conflicts: {
        save: async (userId, type, syncId, row, revision) => {
          const list = (side.conflicts.get(userId) ?? []).filter(
            (c) => !(c.entityType === type && c.syncId === syncId),
          );
          list.push({
            id: side.nextConflict++,
            entityType: type,
            syncId,
            localRow: JSON.stringify(row),
            createdAt: new Date().toISOString(),
          });
          side.conflicts.set(userId, list);
          void revision;
        },
        list: async (userId) => side.conflicts.get(userId) ?? [],
        get: async (userId, id) =>
          (side.conflicts.get(userId) ?? []).find((c) => c.id === id) ?? null,
        delete: async (userId, id) => {
          side.conflicts.set(
            userId,
            (side.conflicts.get(userId) ?? []).filter((c) => c.id !== id),
          );
        },
      },
    },
    feed: {
      withUserLock: (_userId, run) => run(),
      changes: async (userId, cursor, limit) =>
        side.changes(userId, cursor, limit) as never,
      parsePushOps: async (body) => {
        const ops = (body as { ops?: unknown })?.ops;
        return Array.isArray(ops) ? (ops as SyncPushOp[]) : null;
      },
      applyPush: async (userId, ops) => side.applyPush(userId, ops),
      listen: async () => () => {},
    },
    links,
    accounts,
    http: {
      json: async (target, pathname, request = {}) => {
        if (side.offline) throw new FakeRemoteError("offline", "offline");
        const base = /^https?:/.test(target.serverUrl)
          ? target.serverUrl
          : remote();
        const response = await fetch(`${base}${pathname}`, {
          method: request.method ?? "GET",
          headers: {
            "Content-Type": "application/json",
            ...(target.sessionToken
              ? { Authorization: `Bearer ${target.sessionToken}` }
              : {}),
            ...Object.fromEntries(
              (target.customHeaders ?? []).map((h) => [h.name, h.value]),
            ),
          },
          body:
            request.body !== undefined
              ? JSON.stringify(request.body)
              : undefined,
        });
        const data = await response.json();
        if (response.status === 401) {
          throw new FakeRemoteError("signed_out", "Signed out", 401);
        }
        if (!response.ok) {
          throw new FakeRemoteError(
            "server",
            data?.error ?? "error",
            response.status,
          );
        }
        return data;
      },
      // The event stream is not under test.
      fetch: (() => new Promise(() => {})) as never,
      normalizeServerUrl: (input) =>
        /^https?:\/\//.test(input) ? input.replace(/\/+$/, "") : null,
      isRemoteError: ((error: unknown) =>
        error instanceof FakeRemoteError) as never,
    },
    sessions: {
      issueDesktop: async (userId) => {
        const token = `desktop-session-${userId}-${side.sessions.length + 1}`;
        side.sessions.push(token);
        return token;
      },
      revoke: async (id) => {
        side.revoked.push(id);
      },
      find: async () => ({
        expiresAt: new Date(Date.now() + 1000).toISOString(),
        deviceInfo: "Laptop (sync)",
      }),
      findUser: async (userId) => ({ id: userId, username: `name-${userId}` }),
      verify: async (token) => side.validTokens.get(token) ?? null,
      setCookie: (_req, res, value, options) => {
        const name = options?.name ?? "jwt";
        side.cookies[name] = value;
        (res as { cookie: (n: string, v: string) => void }).cookie(name, value);
      },
      clearCookie: (_req, res, name) => {
        delete side.cookies[name ?? "jwt"];
        (res as { clearCookie: (n: string) => void }).clearCookie(
          name ?? "jwt",
        );
      },
      middleware: middlewareFor(side),
      desktopOnly: () => (_req: unknown, _res: unknown, next: () => void) =>
        next(),
    },
    hosts: {
      findForSync: async () => null,
      statusBySyncId: async () => ({}),
    },
    plugins: {
      listForDesktop: async () => ({ plugins: [], registryKeys: [] }),
      sendPackage: async () => false,
      mirror: async () => {
        side.pluginsMirrored++;
      },
      lastRemote: () => [],
      localNames: () => new Map(),
    },
    desktop: {
      applyProxy: async (link) => {
        side.proxy.push(link);
      },
      deviceName: () => "Test Laptop",
    },
    alerts: {
      send: async (alert) => {
        side.alerts.push(alert);
      },
    },
  };
  void serverSide;
  return host as PluginSyncHost;
}
