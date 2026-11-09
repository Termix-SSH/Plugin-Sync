import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Sites } from "./sites.js";

/** Remote sites as actions: see whether each one answers and refresh one. */
export function registerOperations(ctx: PluginContext, sites: Sites): void {
  if (typeof ctx.operations?.register !== "function") return;

  ctx.operations.register("sync.list-sites", {
    run: async () => {
      const rows = await sites.list();
      const failing = rows.filter((site) => site.status === "error");
      const label = rows.length
        ? failing.length
          ? `${failing.length} of ${rows.length} unreachable`
          : `${rows.length} sites reachable`
        : "No sites";
      return {
        summary: label,
        data: {
          rows: rows.map((site) => ({
            id: String(site.id),
            name: site.name,
            url: site.baseUrl,
            status: site.status,
            hosts: site.hostCount ?? 0,
            lastSeen: site.lastSeenAt ?? "",
          })),
          options: rows.map((site) => ({
            value: String(site.id),
            label: site.name,
          })),
          value: failing.length,
          status: !rows.length ? "unknown" : failing.length ? "fail" : "ok",
          label,
        },
      };
    },
  });

  ctx.operations.register("sync.refresh-site", {
    describe: (input) => `Would refresh site ${String(input.site)}`,
    run: async (input) => {
      const id = Number(input.site);
      if (!Number.isInteger(id)) throw new Error("Site not found");
      const site = await sites.refresh(id);
      return {
        summary: `${site.name}: ${site.status}`,
        changed: true,
        data: { status: site.status, hosts: site.hostCount },
      };
    },
  });
}
