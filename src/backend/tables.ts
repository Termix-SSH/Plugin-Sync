import {
  defineTable,
  id,
  integer,
  refHost,
  refUser,
  text,
  timestamp,
  varchar,
} from "@termix-ssh/plugin-sdk/db";

// p_sync_devices: the clients that linked to this server, for the sessions
// list and for telling a desktop from a phone.
export const devices = defineTable(
  "devices",
  {
    id: id(),
    ownerId: refUser(),
    deviceId: varchar(100).notNull(),
    clientType: varchar(20).notNull(),
    name: varchar(100).notNull(),
    lastSeenAt: timestamp().notNull().defaultNow(),
  },
  {
    uniques: [
      {
        name: "uq_p_sync_devices_owner_device",
        columns: ["ownerId", "deviceId"],
      },
    ],
  },
);

// p_sync_web_accounts: the other accounts signed in on one browser of a
// server, so a person can switch without typing a password again. The token
// is sealed with the installation key and the browser holds only the ring id.
export const webAccounts = defineTable(
  "web_accounts",
  {
    id: id(),
    ringId: varchar(64).notNull(),
    ownerId: refUser(),
    username: varchar(100).notNull(),
    token: text().notNull(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  {
    uniques: [
      {
        name: "uq_p_sync_web_accounts_ring_owner",
        columns: ["ringId", "ownerId"],
      },
    ],
    indexes: [{ name: "idx_p_sync_web_accounts_ring", columns: ["ringId"] }],
  },
);

// p_sync_sites: other Termix servers a master manages. The API key is made on
// the remote and stored encrypted.
export const sites = defineTable(
  "sites",
  {
    id: id(),
    name: varchar(100).notNull(),
    baseUrl: varchar(255).notNull(),
    // Sealed with the installation key.
    apiKey: text().notNull(),
    // The user who owns the hosts mirrored from this site.
    ownerId: refUser(),
    // Role ids the mirrored hosts are shared with, as JSON.
    shareRoles: text(),
    options: text(),
    status: varchar(20).notNull(),
    lastError: text(),
    lastSeenAt: timestamp(),
    hostCount: integer(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  {
    uniques: [{ name: "uq_p_sync_sites_base_url", columns: ["baseUrl"] }],
  },
);

// p_sync_site_hosts: which Termix host mirrors which host of a site. The host
// itself is a normal host; this row only remembers where it came from. It goes
// with the host if the host is deleted.
export const siteHosts = defineTable(
  "site_hosts",
  {
    id: id(),
    siteId: integer().notNull(),
    remoteId: integer().notNull(),
    hostId: refHost(),
    // What was last written, so an unchanged host is not written again.
    signature: varchar(64),
    status: varchar(20),
  },
  {
    uniques: [
      {
        name: "uq_p_sync_site_hosts_site_remote",
        columns: ["siteId", "remoteId"],
      },
    ],
    indexes: [{ name: "idx_p_sync_site_hosts_site", columns: ["siteId"] }],
  },
);

// termix-plugin migrations reads this list.
export const tables = [devices, webAccounts, sites, siteHosts];
