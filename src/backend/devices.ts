import { and, eq } from "drizzle-orm";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { devices } from "./tables.js";
import type { ClientType } from "./protocol.js";

export interface DeviceInfo {
  deviceId: string;
  clientType: string;
  name: string;
  lastSeenAt: string;
}

export interface DeviceStore {
  /** The clients this account linked, newest first. */
  list: (userId: string) => Promise<DeviceInfo[]>;
  /** Records that a client linked or synced. A client without an id is not kept. */
  touch: (
    userId: string,
    device: { clientType: ClientType; deviceId: string | null; name: string },
  ) => Promise<void>;
}

export function createDeviceStore(ctx: PluginContext, table: any): DeviceStore {
  return {
    list: async (userId) => {
      const db = await ctx.db.client<any>();
      const rows = await db
        .select()
        .from(table)
        .where(eq(table.ownerId, userId));
      return rows
        .map((row: any) => ({
          deviceId: row.deviceId,
          clientType: row.clientType,
          name: row.name,
          lastSeenAt: row.lastSeenAt,
        }))
        .sort((a: DeviceInfo, b: DeviceInfo) =>
          b.lastSeenAt.localeCompare(a.lastSeenAt),
        );
    },
    touch: async (userId, device) => {
      if (!device.deviceId) return;
      const db = await ctx.db.client<any>();
      const where = and(
        eq(table.ownerId, userId),
        eq(table.deviceId, device.deviceId),
      );
      const [existing] = await db.select().from(table).where(where).limit(1);
      const now = new Date().toISOString();
      if (existing) {
        await db
          .update(table)
          .set({
            clientType: device.clientType,
            name: device.name,
            lastSeenAt: now,
          })
          .where(where);
      } else {
        await db.insert(table).values({
          ownerId: userId,
          deviceId: device.deviceId,
          clientType: device.clientType,
          name: device.name,
        });
      }
      await ctx.db.persist();
    },
  };
}

export { devices };
