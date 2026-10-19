import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  usePluginApi,
  useTabs,
  useTranslation,
  type TabProps,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  AddButton,
  Badge,
  Button,
  EmptyState,
  FormFooter,
  InlineView,
  ListBadge,
  ListRow,
  SecretField,
  TextField,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";

interface Site {
  id: number;
  name: string;
  baseUrl: string;
  status: "pending" | "ok" | "error";
  lastError: string | null;
  lastSeenAt: string | null;
  hostCount: number | null;
}

interface SiteHost {
  id: number;
  remoteId: number;
  name: string;
  address: string | null;
  protocol: string | null;
  folder: string | null;
  tags: string[];
  status: string | null;
}

interface Overview {
  sites: number;
  reachable: number;
  unreachable: number;
  hosts: number;
  online: number;
  offline: number;
}

function errorMessage(error: unknown): string {
  const data = (error as { response?: { data?: { error?: string } } })?.response
    ?.data;
  if (data?.error) return data.error;
  return error instanceof Error ? error.message : String(error);
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col border border-border px-3 py-2">
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function SiteHosts({ site }: { site: Site }) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const tabs = useTabs();
  const [hosts, setHosts] = useState<SiteHost[] | null>(null);

  useEffect(() => {
    let live = true;
    api
      .get<{ hosts: SiteHost[] }>(`/sites/${site.id}/hosts`)
      .then(({ data }) => live && setHosts(data.hosts))
      .catch(() => live && setHosts([]));
    return () => {
      live = false;
    };
  }, [api, site.id, site.lastSeenAt]);

  if (!hosts) return null;
  if (hosts.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        {t("sites.noHosts")}
      </p>
    );
  }

  return (
    <div className="border-l border-border pl-3">
      {hosts.map((host, index) => (
        <ListRow
          key={host.id}
          stripe={index}
          title={host.name}
          badges={
            <>
              {host.status && (
                <ListBadge>
                  {host.status === "online"
                    ? t("sites.online")
                    : host.status === "offline"
                      ? t("sites.offline")
                      : host.status}
                </ListBadge>
              )}
              {host.tags.map((tag) => (
                <ListBadge key={tag}>{tag}</ListBadge>
              ))}
            </>
          }
          meta={[host.folder, host.address, host.protocol]
            .filter(Boolean)
            .join(" | ")}
          trailing={
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                tabs.openTab(null, "site_terminal", {
                  label: `${site.name} | ${host.name}`,
                  forceNewTab: true,
                  data: { siteId: site.id, hostId: host.remoteId },
                })
              }
            >
              {t("sites.openSession")}
            </Button>
          }
        />
      ))}
    </div>
  );
}

export function SitesTab(_props: TabProps) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const confirm = useConfirm();
  const [sites, setSites] = useState<Site[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", baseUrl: "", apiKey: "" });

  const load = useCallback(async () => {
    try {
      const [list, rollup] = await Promise.all([
        api.get<{ sites: Site[] }>("/sites"),
        api.get<Overview>("/overview"),
      ]);
      setSites(list.data.sites);
      setOverview(rollup.data);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, [api]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  async function add() {
    setSaving(true);
    try {
      const { data } = await api.post<{ site: Site }>("/sites", form);
      if (data.site.status === "error") {
        toast.error(data.site.lastError ?? t("sites.failed"));
      } else {
        toast.success(t("sites.added"));
      }
      setAdding(false);
      setForm({ name: "", baseUrl: "", apiKey: "" });
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function refresh(site: Site) {
    try {
      await api.post(`/sites/${site.id}/refresh`);
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function remove(site: Site) {
    const ok = await confirm({
      title: t("sites.removeTitle"),
      description: t("sites.removeDescription", { name: site.name }),
    });
    if (!ok) return;
    try {
      await api.delete(`/sites/${site.id}`);
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const valid = form.name.trim() && form.baseUrl.trim() && form.apiKey.trim();

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{t("sites.title")}</h2>
        <AddButton label={t("sites.add")} onClick={() => setAdding(true)} />
      </div>

      {overview && overview.sites > 0 && (
        <div className="flex flex-wrap gap-2">
          <Stat label={t("sites.stats.sites")} value={overview.sites} />
          <Stat label={t("sites.stats.reachable")} value={overview.reachable} />
          <Stat
            label={t("sites.stats.unreachable")}
            value={overview.unreachable}
          />
          <Stat label={t("sites.stats.hosts")} value={overview.hosts} />
          <Stat label={t("sites.stats.online")} value={overview.online} />
          <Stat label={t("sites.stats.offline")} value={overview.offline} />
        </div>
      )}

      {sites.length === 0 ? (
        <EmptyState title={t("sites.emptyTitle")} hint={t("sites.empty")} />
      ) : (
        <div>
          {sites.map((site, index) => (
            <div key={site.id}>
              <ListRow
                stripe={index}
                title={site.name}
                tone={site.status === "error" ? "destructive" : "brand"}
                badges={
                  <Badge
                    variant={site.status === "ok" ? "default" : "secondary"}
                  >
                    {t(`sites.status.${site.status}`)}
                  </Badge>
                }
                meta={
                  site.status === "error" && site.lastError
                    ? `${site.baseUrl} | ${site.lastError}`
                    : `${site.baseUrl} | ${t("sites.hostCount", {
                        count: site.hostCount ?? 0,
                      })}`
                }
                onClick={() => setOpen(open === site.id ? null : site.id)}
                trailing={
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        void refresh(site);
                      }}
                    >
                      {t("sites.refresh")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        void remove(site);
                      }}
                    >
                      {t("sites.remove")}
                    </Button>
                  </div>
                }
              />
              {open === site.id && <SiteHosts site={site} />}
            </div>
          ))}
        </div>
      )}

      <InlineView
        open={adding}
        onOpenChange={setAdding}
        title={t("sites.addTitle")}
        footer={
          <FormFooter
            onCancel={() => setAdding(false)}
            onSave={() => void add()}
            saveLabel={t("sites.add")}
            saving={saving}
            disabled={!valid}
          />
        }
      >
        <div className="flex flex-col gap-3 p-4">
          <p className="text-xs text-muted-foreground">{t("sites.addHelp")}</p>
          <TextField
            label={t("sites.name")}
            value={form.name}
            onChange={(name) => setForm((f) => ({ ...f, name }))}
          />
          <TextField
            label={t("sites.address")}
            value={form.baseUrl}
            placeholder="https://termix.example.com"
            onChange={(baseUrl) => setForm((f) => ({ ...f, baseUrl }))}
          />
          <SecretField
            label={t("sites.apiKey")}
            value={form.apiKey}
            hint={t("sites.apiKeyHint")}
            onChange={(apiKey) => setForm((f) => ({ ...f, apiKey }))}
          />
        </div>
      </InlineView>
    </div>
  );
}
