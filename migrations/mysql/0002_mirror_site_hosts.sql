-- sync 0002: mirror_site_hosts
-- Hand written: sites get an owner and roles, and the host cache becomes the
-- map from a mirrored host to its site. Both tables only held a site list that
-- is read again from the remote, so they are rebuilt. Sites are added again.

DROP TABLE IF EXISTS `p_sync_site_hosts`;
DROP TABLE IF EXISTS `p_sync_sites`;
CREATE TABLE `p_sync_sites` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `name` varchar(100) NOT NULL,
  `base_url` varchar(255) NOT NULL,
  `api_key` longtext NOT NULL,
  `owner_id` varchar(255) NOT NULL,
  `share_roles` longtext,
  `options` longtext,
  `status` varchar(20) NOT NULL,
  `last_error` longtext,
  `last_seen_at` text,
  `host_count` int,
  `created_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `uq_p_sync_sites_base_url` ON `p_sync_sites` (`base_url`);
CREATE TABLE `p_sync_site_hosts` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `site_id` int NOT NULL,
  `remote_id` int NOT NULL,
  `host_id` int NOT NULL,
  `signature` varchar(64),
  `status` varchar(20),
  FOREIGN KEY (`host_id`) REFERENCES `ssh_data` (`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `uq_p_sync_site_hosts_site_remote` ON `p_sync_site_hosts` (`site_id`, `remote_id`);
CREATE INDEX `idx_p_sync_site_hosts_site` ON `p_sync_site_hosts` (`site_id`);
