import type {
  DataResult,
  DataTone,
  PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
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

const TONE: Record<string, DataTone> = {
  online: "good",
  reachable: "good",
  offline: "bad",
};

/**
 * The dot on a mirrored host's row: the status the remote site reports. A
 * value the shell draws, so it works from a frame too.
 */
export function useRemoteStatusValue(host: PluginHostRecord): DataResult {
  const { t } = useTranslation();
  const remote = remoteOf(host, "sync");
  if (!remote) return null;
  return {
    shape: "dot",
    tone: TONE[remote.status] ?? "muted",
    label: t("sites.remoteStatus", { status: remote.status }),
  };
}
