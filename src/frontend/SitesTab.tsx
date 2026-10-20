import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import type { SettingsComponentProps } from "@termix-ssh/plugin-sdk/frontend";
import {
  AddButton,
  Badge,
  Button,
  EmptyState,
  FormFooter,
  InlineView,
  ListRow,
  SecretField,
  TextField,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";

interface Site {
  id: number;
  name: string;
  baseUrl: string;
  shareRoles: number[];
  status: "pending" | "ok" | "error";
  lastError: string | null;
  lastSeenAt: string | null;
  hostCount: number | null;
}

interface Role {
  id: number;
  name: string;
  displayName?: string;
}

interface Overview {
  sites: number;
  reachable: number;
  unreachable: number;
  hosts: number;
  online: number;
  offline: number;
}

interface Form {
  id: number | null;
  name: string;
  baseUrl: string;
  apiKey: string;
  shareRoles: number[];
}

const EMPTY: Form = {
  id: null,
  name: "",
  baseUrl: "",
  apiKey: "",
  shareRoles: [],
};

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

export function SitesSetting(_props: SettingsComponentProps) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const confirm = useConfirm();
  const [sites, setSites] = useState<Site[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);

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

  useEffect(() => {
    api
      .get<{ roles: Role[] }>("/roles")
      .then(({ data }) => setRoles(data.roles ?? []))
      .catch(() => setRoles([]));
  }, [api]);

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const body = {
        name: form.name,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        shareRoles: form.shareRoles,
      };
      const { data } =
        form.id === null
          ? await api.post<{ site: Site }>("/sites", body)
          : await api.put<{ site: Site }>(`/sites/${form.id}`, body);
      if (data.site.status === "error") {
        toast.error(data.site.lastError ?? t("sites.failed"));
      } else {
        toast.success(form.id === null ? t("sites.added") : t("sites.saved"));
      }
      setForm(null);
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

  const toggleRole = (id: number) =>
    setForm((current) =>
      current
        ? {
            ...current,
            shareRoles: current.shareRoles.includes(id)
              ? current.shareRoles.filter((role) => role !== id)
              : [...current.shareRoles, id],
          }
        : current,
    );

  const adding = form?.id === null;
  const valid =
    !!form &&
    form.name.trim() &&
    (!adding || (form.baseUrl.trim() && form.apiKey.trim()));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{t("sites.title")}</h2>
        <AddButton label={t("sites.add")} onClick={() => setForm(EMPTY)} />
      </div>

      <p className="text-xs text-muted-foreground">{t("sites.intro")}</p>

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
            <ListRow
              key={site.id}
              stripe={index}
              title={site.name}
              tone={site.status === "error" ? "destructive" : "brand"}
              badges={
                <Badge variant={site.status === "ok" ? "default" : "secondary"}>
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
              trailing={
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void refresh(site)}
                  >
                    {t("sites.refresh")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setForm({
                        id: site.id,
                        name: site.name,
                        baseUrl: site.baseUrl,
                        apiKey: "",
                        shareRoles: site.shareRoles,
                      })
                    }
                  >
                    {t("sites.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void remove(site)}
                  >
                    {t("sites.remove")}
                  </Button>
                </div>
              }
            />
          ))}
        </div>
      )}

      <InlineView
        open={form !== null}
        onOpenChange={(open) => !open && setForm(null)}
        title={adding ? t("sites.addTitle") : t("sites.editTitle")}
        footer={
          <FormFooter
            onCancel={() => setForm(null)}
            onSave={() => void save()}
            saveLabel={adding ? t("sites.add") : t("sites.save")}
            saving={saving}
            disabled={!valid}
          />
        }
      >
        {form && (
          <div className="flex flex-col gap-3 p-4">
            {adding && (
              <p className="text-xs text-muted-foreground">
                {t("sites.addHelp")}
              </p>
            )}
            <TextField
              label={t("sites.name")}
              value={form.name}
              hint={t("sites.nameHint")}
              onChange={(name) => setForm({ ...form, name })}
            />
            {adding && (
              <TextField
                label={t("sites.address")}
                value={form.baseUrl}
                placeholder="https://termix.example.com"
                onChange={(baseUrl) => setForm({ ...form, baseUrl })}
              />
            )}
            <SecretField
              label={t("sites.apiKey")}
              value={form.apiKey}
              hint={adding ? t("sites.apiKeyHint") : t("sites.apiKeyKeep")}
              onChange={(apiKey) => setForm({ ...form, apiKey })}
            />
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium">
                {t("sites.shareWith")}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("sites.shareHint")}
              </span>
              {roles.length === 0 && (
                <span className="text-xs text-muted-foreground">
                  {t("sites.noRoles")}
                </span>
              )}
              {roles.map((role) => (
                <label
                  key={role.id}
                  className="flex items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={form.shareRoles.includes(role.id)}
                    onChange={() => toggleRole(role.id)}
                  />
                  {role.displayName || role.name}
                </label>
              ))}
            </div>
          </div>
        )}
      </InlineView>
    </div>
  );
}
