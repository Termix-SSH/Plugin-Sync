/**
 * The linked desktop's side of sync, for one link.
 *
 * A pass pushes local edits, then pulls what changed on the server after the
 * saved cursor, then backfills any entity type this device has never pulled
 * (first link, a feature switched on, a category turned back on). Local
 * edits are found the same way the server finds changes: by comparing each
 * row's hash with the one recorded at the last sync.
 */

import type {
  PluginSyncHost,
  SyncEntityInfo,
  SyncLinkInfo,
  SyncLinkPatch,
  SyncPushOp,
  SyncPushResult,
  SyncRecordInfo,
  SyncRow,
} from "@termix-ssh/plugin-sdk/backend";

export interface RemoteChange {
  seq: number;
  entityType: string;
  syncId: string;
  revision: number;
  deleted: boolean;
  row: SyncRow | null;
}

interface ChangesPage {
  changes: RemoteChange[];
  nextCursor: number;
  hasMore: boolean;
  entityTypes: Array<{
    type: string;
    owner: string;
    order: number;
    readOnly: boolean;
  }>;
}

const MAX_BATCH_OPS = 200;
const MAX_BATCH_BYTES = 1_000_000;
const MAX_PAGES = 500;
const SAFETY_INTERVAL_MS = 5 * 60_000;
const REFRESH_CHECK_MS = 24 * 60 * 60_000;
const DELETED_HASH = "deleted";

export interface EngineState {
  running: boolean;
  /** Local changes found in the last pass that the server has not taken. */
  pending: number;
  /** Entity types the server runs, from the last pull. */
  serverTypes: Array<{ type: string; owner: string; readOnly: boolean }>;
  lastPassAt: string | null;
}

/** Reads and changes the one link an engine syncs. */
export interface LinkAccess {
  get: () => Promise<SyncLinkInfo | null>;
  update: (patch: SyncLinkPatch) => Promise<SyncLinkInfo | null>;
}

export interface EngineLog {
  warn: (message: string, meta?: unknown) => void;
}

/** An entity this device could sync: registered here, and on the server. */
function syncable(
  entity: SyncEntityInfo,
  link: SyncLinkInfo,
  serverTypes: Set<string> | null,
): boolean {
  if (link.disabledTypes.includes(entity.type)) return false;
  if (serverTypes && !serverTypes.has(entity.type)) return false;
  return true;
}

export class SyncEngine {
  private running = false;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private safety: NodeJS.Timeout | null = null;
  private backoffMs = 0;
  private events: AbortController | null = null;
  private eventsFor: string | null = null;
  private lastRefreshCheck = 0;
  private serverTypes: Set<string> | null = null;
  private stopFns: Array<() => void> = [];
  private alerted = false;
  readonly state: EngineState = {
    running: false,
    pending: 0,
    serverTypes: [],
    lastPassAt: null,
  };

  constructor(
    private readonly host: PluginSyncHost,
    private readonly link: LinkAccess,
    private readonly log: EngineLog,
    private readonly applyProxy: (link: SyncLinkInfo | null) => Promise<void>,
  ) {}

  private getLink() {
    return this.link.get();
  }

  private updateLink(patch: SyncLinkPatch) {
    return this.link.update(patch);
  }

  start(): void {
    if (this.safety) return;
    void this.host.entities.ensureCore();
    this.safety = setInterval(() => this.request(0), SAFETY_INTERVAL_MS);
    this.safety.unref?.();
    this.stopFns.push(
      this.host.entities.onLocalWrite(() => this.request(2000)),
    );
    // A plugin that came up may bring entity types to backfill.
    this.stopFns.push(this.host.entities.onChanged(() => this.request(3000)));
    this.request(3000);
  }

  stop(): void {
    if (this.safety) clearInterval(this.safety);
    if (this.timer) clearTimeout(this.timer);
    this.safety = this.timer = null;
    this.closeEvents();
    for (const stop of this.stopFns.splice(0)) stop();
  }

  /** Runs a pass after `delayMs`, folding requests that arrive meanwhile. */
  request(delayMs = 0): void {
    if (this.timer) {
      if (delayMs > 0) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delayMs);
    this.timer.unref?.();
  }

  /** Runs a pass now and waits for it. */
  async syncNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      while (this.running) await new Promise((r) => setTimeout(r, 100));
      return;
    }
    await this.run();
  }

  /** Forgets what the server runs, after a relink or unlink. */
  reset(): void {
    this.serverTypes = null;
    this.state.serverTypes = [];
    this.state.pending = 0;
    this.alerted = false;
    this.backoffMs = 0;
    this.closeEvents();
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.state.running = true;
    try {
      await this.pass();
    } finally {
      this.running = this.state.running = false;
      this.state.lastPassAt = new Date().toISOString();
      if (this.again) {
        this.again = false;
        this.request(0);
      }
    }
  }

  private sortChanges(changes: RemoteChange[]): RemoteChange[] {
    const { entities, replica } = this.host;
    const byType = new Map<string, RemoteChange[]>();
    for (const change of changes) {
      const list = byType.get(change.entityType) ?? [];
      list.push(change);
      byType.set(change.entityType, list);
    }
    const types = [...byType.keys()].sort(
      (a, b) =>
        (entities.get(a)?.order ?? 1e6) - (entities.get(b)?.order ?? 1e6),
    );
    const out: RemoteChange[] = [];
    for (const type of types) {
      const list = byType.get(type)!;
      const entity = entities.get(type);
      // Only the latest record of each row matters.
      const latest = new Map<string, RemoteChange>();
      for (const change of list) latest.set(change.syncId, change);
      const live = [...latest.values()].filter((change) => !change.deleted);
      const gone = [...latest.values()].filter((change) => change.deleted);
      if (entity) {
        const bySyncId = new Map(live.map((change) => [change.syncId, change]));
        const ordered = replica.orderSelfReferences(
          type,
          live.map((change) => ({
            ...(change.row ?? {}),
            syncId: change.syncId,
          })),
        );
        out.push(...ordered.map((row) => bySyncId.get(row.syncId as string)!));
      } else {
        out.push(...live);
      }
      out.push(...gone);
    }
    return out;
  }

  private async pass(): Promise<void> {
    const link = await this.getLink();
    if (!link?.sessionToken) {
      this.closeEvents();
      return;
    }
    await this.updateLink({ status: "syncing" });

    try {
      await this.refreshSession(link);
      const fresh = (await this.getLink())!;
      await this.host.plugins.mirror(fresh);

      // A first pass pulls before it pushes, so rows both sides already
      // have are matched up instead of sent back as edits.
      const firstPass = fresh.knownTypes.length === 0;
      if (!firstPass) {
        await this.push(fresh);
        await this.pull(fresh);
      }
      await this.backfill((await this.getLink())!);
      if (firstPass) await this.push((await this.getLink())!);

      this.backoffMs = 0;
      this.alerted = false;
      await this.updateLink({
        status: "idle",
        lastError: null,
        lastSyncAt: new Date().toISOString(),
      });
      const done = (await this.getLink())!;
      await this.applyProxy(done).catch(() => {});
      this.openEvents(done);
    } catch (error) {
      await this.fail(error);
    }
  }

  private async fail(error: unknown): Promise<void> {
    const remote = this.host.http.isRemoteError(error) ? error : null;
    const message = error instanceof Error ? error.message : String(error);
    this.log.warn("Sync pass failed", {
      kind: remote?.kind ?? "internal",
      error: message,
    });

    if (remote?.kind === "signed_out") {
      const link = await this.updateLink({
        status: "signed_out",
        lastError: message,
      });
      await this.applyProxy(link).catch(() => {});
      this.closeEvents();
      if (!this.alerted) {
        this.alerted = true;
        await this.host.alerts.send({
          title: "Sync is paused",
          body: "This device was signed out of the server it syncs with. Sign in again from Sync to keep going.",
          severity: "warning",
          category: "termix.sync.signed_out",
          dedupeKey: "sync:signed_out",
          link: { tab: "sync" },
        });
      }
      return;
    }

    const offline = remote?.kind === "offline";
    await this.updateLink({
      status: offline ? "offline" : "error",
      lastError: message,
    });
    this.backoffMs = Math.min(
      this.backoffMs ? this.backoffMs * 2 : 15_000,
      10 * 60_000,
    );
    this.request(this.backoffMs);
  }

  private async refreshSession(link: SyncLinkInfo): Promise<void> {
    if (Date.now() - this.lastRefreshCheck < REFRESH_CHECK_MS) return;
    const result = await this.host.http.json<{ token: string | null }>(
      link,
      "/sync/v2/session/refresh",
      { method: "POST", body: {} },
    );
    this.lastRefreshCheck = Date.now();
    if (result.token) await this.updateLink({ sessionToken: result.token });
  }

  /** Local rows the server does not have in this form yet. */
  async outbox(link: SyncLinkInfo): Promise<{
    ops: SyncPushOp[];
    hashes: Map<string, string>;
  }> {
    const { replica, entities } = this.host;
    const records = await replica.records.list(link.userId);
    const resolvers = replica.resolvers(link.userId);
    const ops: SyncPushOp[] = [];
    const hashes = new Map<string, string>();

    for (const entity of entities.list()) {
      if (entity.readOnly) continue;
      if (!link.knownTypes.includes(entity.type)) continue;
      if (!syncable(entity, link, this.serverTypes)) continue;

      const { rows, failed } = await replica.loadRows(
        entity.type,
        link.userId,
        resolvers,
      );
      for (const row of rows.values()) {
        const key = replica.records.key(entity.type, row.syncId);
        const record = records.get(key);
        if (record && !record.deleted && record.hash === row.hash) continue;
        // Unavailable server rows can recover without another local edit.
        if (record?.errorHash === row.hash && record.error !== "unavailable") {
          continue;
        }
        ops.push({
          entityType: entity.type,
          syncId: row.syncId,
          baseRevision: record?.revision ?? 0,
          op: "upsert",
          row: row.wire,
        });
        hashes.set(key, row.hash);
      }

      for (const record of records.values()) {
        if (record.entityType !== entity.type || record.deleted) continue;
        if (record.revision === 0) continue;
        if (rows.has(record.syncId) || failed.has(record.syncId)) continue;
        if (entity.covers && !entity.covers(record.syncId)) continue;
        if (
          record.errorHash === DELETED_HASH &&
          record.error !== "unavailable"
        ) {
          continue;
        }
        ops.push({
          entityType: entity.type,
          syncId: record.syncId,
          baseRevision: record.revision,
          op: "delete",
        });
      }
    }
    return { ops, hashes };
  }

  private async push(link: SyncLinkInfo): Promise<void> {
    const { ops, hashes } = await this.outbox(link);
    this.state.pending = ops.length;
    if (ops.length === 0) return;

    for (const batch of batches(ops)) {
      const { results } = await this.host.http.json<{
        results: SyncPushResult[];
      }>(link, "/sync/v2/push", {
        method: "POST",
        body: { ops: batch },
        timeoutMs: 120_000,
      });
      const byKey = new Map(
        batch.map((op) => [
          this.host.replica.records.key(op.entityType, op.syncId),
          op,
        ]),
      );
      for (const result of results) {
        const key = this.host.replica.records.key(
          result.entityType,
          result.syncId,
        );
        const op = byKey.get(key);
        if (!op) continue;
        await this.settle(link, op, result, hashes.get(key) ?? null);
      }
      this.state.pending = Math.max(0, this.state.pending - batch.length);
    }
  }

  private async settle(
    link: SyncLinkInfo,
    op: SyncPushOp,
    result: SyncPushResult,
    hash: string | null,
  ): Promise<void> {
    const userId = link.userId;
    const { replica, entities } = this.host;
    if (!entities.get(op.entityType)) return;

    if (result.status === "ok") {
      await replica.records.put(userId, op.entityType, op.syncId, {
        revision: result.revision,
        hash: op.op === "delete" ? null : hash,
        deleted: op.op === "delete",
      });
      return;
    }

    if (result.status === "rejected") {
      await replica.records.setError(
        userId,
        op.entityType,
        op.syncId,
        result.reason,
        hash ?? DELETED_HASH,
      );
      return;
    }

    // Revision 0 with no row: the server has no record of it at all (lost in
    // a restore, say). Start over so the next pass sends it as new.
    if (!result.deleted && !result.row && result.revision === 0) {
      await replica.records.put(userId, op.entityType, op.syncId, {
        revision: 0,
        hash: null,
        deleted: op.op === "delete",
      });
      if (op.op === "upsert") this.request(1000);
      return;
    }

    // A live row the server could not send says nothing; keep ours to retry.
    if (!result.deleted && !result.row) return;

    // Conflict: the server moved on since this device last saw the row. Its
    // version wins here, and a local edit it replaced is kept for the user.
    if (op.op === "upsert" && op.row) {
      await replica.conflicts.save(
        userId,
        op.entityType,
        op.syncId,
        op.row,
        result.revision,
      );
    }
    const resolvers = replica.resolvers(userId);
    if (result.deleted) {
      await replica.deleteRow(op.entityType, userId, op.syncId);
      await replica.records.put(userId, op.entityType, op.syncId, {
        revision: result.revision,
        hash: null,
        deleted: true,
      });
      return;
    }
    await replica.writeRow(
      op.entityType,
      userId,
      { ...result.row, syncId: op.syncId },
      resolvers,
    );
    const written = await replica.loadRow(
      op.entityType,
      userId,
      op.syncId,
      resolvers,
    );
    await replica.records.put(userId, op.entityType, op.syncId, {
      revision: result.revision,
      hash: written?.hash ?? null,
      deleted: false,
    });
  }

  private async fetchChanges(
    link: SyncLinkInfo,
    cursor: number,
    types?: string[],
  ): Promise<{ changes: RemoteChange[]; cursor: number }> {
    const all: RemoteChange[] = [];
    let next = cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({
        cursor: String(next),
        limit: "1000",
      });
      if (types?.length) query.set("types", types.join(","));
      const result = await this.host.http.json<ChangesPage>(
        link,
        `/sync/v2/changes?${query.toString()}`,
        { timeoutMs: 120_000 },
      );
      all.push(...result.changes);
      next = result.nextCursor;
      this.learnTypes(result);
      if (!result.hasMore) break;
    }
    return { changes: all, cursor: next };
  }

  private learnTypes(page: ChangesPage): void {
    this.serverTypes = new Set(page.entityTypes.map((entry) => entry.type));
    this.state.serverTypes = page.entityTypes.map((entry) => ({
      type: entry.type,
      owner: entry.owner,
      readOnly: entry.readOnly,
    }));
  }

  private async pull(link: SyncLinkInfo): Promise<void> {
    const { changes, cursor } = await this.fetchChanges(link, link.cursor);
    const known = new Set(link.knownTypes);
    await this.apply(
      link,
      changes.filter(
        (change) =>
          known.has(change.entityType) &&
          !link.disabledTypes.includes(change.entityType),
      ),
      false,
    );
    await this.updateLink({ cursor });
  }

  /** Pulls every row of types this device has not pulled before. */
  private async backfill(link: SyncLinkInfo): Promise<void> {
    if (!this.serverTypes) {
      // Only the entity types are wanted, so a one-row page is enough.
      this.learnTypes(
        await this.host.http.json<ChangesPage>(
          link,
          `/sync/v2/changes?cursor=${link.cursor}&limit=1`,
          { timeoutMs: 120_000 },
        ),
      );
    }
    const fresh = this.host.entities
      .list()
      .map((entity) => entity.type)
      .filter(
        (type) =>
          !link.knownTypes.includes(type) &&
          !link.disabledTypes.includes(type) &&
          this.serverTypes?.has(type),
      );
    if (fresh.length === 0) return;

    const { changes, cursor } = await this.fetchChanges(link, 0, fresh);
    await this.apply(link, changes, true);
    const current = (await this.getLink())!;
    await this.updateLink({
      knownTypes: [...new Set([...current.knownTypes, ...fresh])],
      // On a first pass the backfill is the whole pull, so it sets the cursor.
      ...(link.knownTypes.length === 0 ? { cursor } : {}),
    });
  }

  /**
   * Writes pulled changes. `adopt` is for a first pull of a type: a local row
   * with no record yet takes the server's version without a conflict.
   */
  private async apply(
    link: SyncLinkInfo,
    changes: RemoteChange[],
    adopt: boolean,
  ): Promise<void> {
    if (changes.length === 0) return;
    const userId = link.userId;
    const { replica, entities } = this.host;
    const records = await replica.records.list(userId);
    let missed = false;
    const resolvers = replica.resolvers(userId, () => {
      missed = true;
    });
    const retry: RemoteChange[] = [];

    for (const change of this.sortChanges(changes)) {
      const entity = entities.get(change.entityType);
      if (!entity) continue;
      const key = replica.records.key(change.entityType, change.syncId);
      const record = records.get(key);
      if (record && record.revision >= change.revision) continue;

      try {
        if (!entity.readOnly) {
          await this.keepLocalEdit(
            entity,
            userId,
            change,
            record,
            adopt,
            resolvers,
          );
        }
        if (change.deleted) {
          await replica.deleteRow(change.entityType, userId, change.syncId);
          await replica.records.put(userId, change.entityType, change.syncId, {
            revision: change.revision,
            hash: null,
            deleted: true,
          });
          continue;
        }
        missed = false;
        await replica.writeRow(
          change.entityType,
          userId,
          { ...(change.row ?? {}), syncId: change.syncId },
          resolvers,
        );
        if (missed) retry.push(change);
        await this.recordApplied(entity, userId, change, resolvers);
      } catch (error) {
        this.log.warn("Could not apply a synced change", {
          entityType: change.entityType,
          syncId: change.syncId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Rows that pointed at something written later in the same pull.
    for (const change of retry) {
      const entity = entities.get(change.entityType)!;
      try {
        await replica.writeRow(
          change.entityType,
          userId,
          { ...(change.row ?? {}), syncId: change.syncId },
          resolvers,
        );
        await this.recordApplied(entity, userId, change, resolvers);
      } catch {
        // The first write stands.
      }
    }
  }

  private async recordApplied(
    entity: SyncEntityInfo,
    userId: string,
    change: RemoteChange,
    resolvers: unknown,
  ): Promise<void> {
    const { replica } = this.host;
    const written = entity.readOnly
      ? null
      : await replica.loadRow(
          change.entityType,
          userId,
          change.syncId,
          resolvers,
        );
    await replica.records.put(userId, change.entityType, change.syncId, {
      revision: change.revision,
      hash: written?.hash ?? null,
      deleted: false,
    });
  }

  /** Saves a local edit the incoming change is about to replace. */
  private async keepLocalEdit(
    entity: SyncEntityInfo,
    userId: string,
    change: RemoteChange,
    record: SyncRecordInfo | undefined,
    adopt: boolean,
    resolvers: unknown,
  ): Promise<void> {
    if (!record && adopt) return;
    const local = await this.host.replica
      .loadRow(entity.type, userId, change.syncId, resolvers)
      .catch(() => null);
    if (!local) return;
    if (record && !record.deleted && record.hash === local.hash) return;
    await this.host.replica.conflicts.save(
      userId,
      change.entityType,
      change.syncId,
      local.wire,
      change.revision,
    );
  }

  private openEvents(link: SyncLinkInfo): void {
    const key = `${link.serverUrl}|${link.sessionToken}`;
    if (this.events && this.eventsFor === key) return;
    this.closeEvents();
    const controller = new AbortController();
    this.events = controller;
    this.eventsFor = key;
    void this.listen(link, controller);
  }

  private closeEvents(): void {
    this.events?.abort();
    this.events = null;
    this.eventsFor = null;
  }

  private async listen(
    link: SyncLinkInfo,
    controller: AbortController,
  ): Promise<void> {
    try {
      const response = await this.host.http.fetch(link, "/sync/v2/events", {
        signal: controller.signal,
      });
      if (!response.ok || !response.body)
        throw new Error(`HTTP ${response.status}`);
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (/^event: change$/m.test(block)) this.request(500);
        }
      }
    } catch {
      // Dropped or refused: the safety interval still syncs, and the next
      // successful pass reopens the stream.
    }
    if (this.events === controller) {
      this.events = null;
      this.eventsFor = null;
      if (!controller.signal.aborted) {
        setTimeout(() => this.request(0), 30_000).unref?.();
      }
    }
  }

  /** Where the link's proxy settings have to reach outside the backend. */
  async applyProxyConfig(): Promise<void> {
    await this.applyProxy(await this.getLink());
  }
}

function* batches(ops: SyncPushOp[]): Generator<SyncPushOp[]> {
  let batch: SyncPushOp[] = [];
  let bytes = 0;
  for (const op of ops) {
    const size = JSON.stringify(op).length;
    if (
      batch.length > 0 &&
      (batch.length >= MAX_BATCH_OPS || bytes + size > MAX_BATCH_BYTES)
    ) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(op);
    bytes += size;
  }
  if (batch.length > 0) yield batch;
}
