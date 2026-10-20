import type { PluginHostRecord } from "@termix-ssh/plugin-sdk/frontend";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";

interface SiteSettings {
  siteId?: number;
  remoteId?: number;
  remoteStatus?: string;
}

/** The site and host a mirrored host came from, or null for any other host. */
export function remoteOf(
  host: PluginHostRecord,
  pluginId: string,
): { siteId: number; remoteId: number; status: string } | null {
  const settings = host.pluginSettings?.[pluginId] as SiteSettings | undefined;
  if (
    !settings ||
    !Number.isSafeInteger(settings.siteId) ||
    !Number.isSafeInteger(settings.remoteId)
  ) {
    return null;
  }
  return {
    siteId: settings.siteId as number,
    remoteId: settings.remoteId as number,
    status: settings.remoteStatus ?? "unknown",
  };
}

const COLOR: Record<string, string> = {
  online: "bg-green-500",
  reachable: "bg-green-500",
  offline: "bg-red-500",
};

/** The dot on a mirrored host's row: the status the remote site reports. */
export function RemoteStatusDot({ host }: { host: PluginHostRecord }) {
  const { t } = useTranslation();
  const remote = remoteOf(host, "sync");
  if (!remote) return null;
  return (
    <span
      title={t("sites.remoteStatus", { status: remote.status })}
      className={`inline-block size-2 shrink-0 rounded-full ${
        COLOR[remote.status] ?? "bg-muted-foreground/40"
      }`}
    />
  );
}
