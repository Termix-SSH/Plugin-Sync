import { useEffect, useState } from "react";
import { Cloud } from "lucide-react";
import {
  usePermission,
  usePluginApi,
  useTranslation,
  type DashboardCardProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { ListRow, PanelList, LoadingState } from "@termix-ssh/plugin-sdk/ui";

interface Overview {
  sites: number;
  reachable: number;
  unreachable: number;
  hosts: number;
  online: number;
  offline: number;
}

const POLL_MS = 60_000;

/** Dashboard card: remote sites that answer and their hosts. */
export function SitesCard({ isVisible }: DashboardCardProps) {
  const { t } = useTranslation();
  const allowed = usePermission("sites");
  const api = usePluginApi();
  const [overview, setOverview] = useState<Overview | null>(null);

  useEffect(() => {
    if (!isVisible || !allowed) return;
    const load = () =>
      api
        .get<Overview>("/overview")
        .then((res) => setOverview(res.data))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [isVisible, allowed, api]);

  if (!allowed) return null;
  if (!overview) {
    return <LoadingState compact label={t("card.loading")} />;
  }
  return (
    <PanelList
      empty={
        <p className="p-3 text-xs text-muted-foreground">{t("card.empty")}</p>
      }
    >
      {overview.sites > 0 && (
        <ListRow
          stripe={0}
          tone={overview.unreachable > 0 ? "destructive" : "none"}
          icon={<Cloud className="size-3.5" />}
          title={t("card.sites", {
            reachable: overview.reachable,
            total: overview.sites,
          })}
          meta={t("card.hosts", {
            online: overview.online,
            offline: overview.offline,
          })}
        />
      )}
    </PanelList>
  );
}
