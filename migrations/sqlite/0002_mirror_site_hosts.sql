-- sync 0002: mirror_site_hosts
-- Hand written: sites get an owner and roles, and the host cache becomes the
-- map from a mirrored host to its site. Both tables only held a site list that
-- is read again from the remote, so they are rebuilt. Sites are added again.

DROP TABLE IF EXISTS "p_sync_site_hosts";
DROP TABLE IF EXISTS "p_sync_sites";
CREATE TABLE "p_sync_sites" (
  "id" integer PRIMARY KEY AUTOINCREMENT,
  "name" text NOT NULL,
  "base_url" text NOT NULL,
  "api_key" text NOT NULL,
  "owner_id" text NOT NULL,
  "share_roles" text,
  "options" text,
  "status" text NOT NULL,
  "last_error" text,
  "last_seen_at" text,
  "host_count" integer,
  "created_at" text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_p_sync_sites_base_url" ON "p_sync_sites" ("base_url");
CREATE TABLE "p_sync_site_hosts" (
  "id" integer PRIMARY KEY AUTOINCREMENT,
  "site_id" integer NOT NULL,
  "remote_id" integer NOT NULL,
  "host_id" integer NOT NULL,
  "signature" text,
  "status" text,
  FOREIGN KEY ("host_id") REFERENCES "ssh_data" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_p_sync_site_hosts_site_remote" ON "p_sync_site_hosts" ("site_id", "remote_id");
CREATE INDEX IF NOT EXISTS "idx_p_sync_site_hosts_site" ON "p_sync_site_hosts" ("site_id");
