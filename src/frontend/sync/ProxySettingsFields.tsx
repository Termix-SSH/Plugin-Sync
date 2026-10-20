import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Plus, Trash2 } from "lucide-react";
import { Input, PasswordInput, Switch } from "@termix-ssh/plugin-sdk/ui";
import type { SyncBasicAuth, SyncClientCert, SyncProxyHeader } from "./api";

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface ProxySettingsFieldsProps {
  customHeaders: SyncProxyHeader[];
  basicAuth: SyncBasicAuth | null;
  clientCert: SyncClientCert | null;
  onChange: (next: {
    customHeaders?: SyncProxyHeader[];
    basicAuth?: SyncBasicAuth | null;
    clientCert?: SyncClientCert | null;
  }) => void;
}

/**
 * What a reverse proxy in front of the server wants: extra headers (a
 * Cloudflare Access service token, a gateway key), basic auth and a client
 * certificate for mutual TLS.
 */
export function ProxySettingsFields({
  customHeaders,
  basicAuth,
  clientCert,
  onChange,
}: ProxySettingsFieldsProps) {
  const { t } = useTranslation();

  const setHeader = (index: number, patch: Partial<SyncProxyHeader>) => {
    onChange({
      customHeaders: customHeaders.map((header, i) =>
        i === index ? { ...header, ...patch } : header,
      ),
    });
  };

  return (
    <div className="flex flex-col gap-4 border border-border p-3">
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold">
            {t("sync.proxy.headersTitle")}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {t("sync.proxy.headersHint")}
          </span>
        </div>
        {customHeaders.map((header, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              className="rounded-none h-8 text-xs"
              placeholder={t("sync.proxy.headerName")}
              value={header.name}
              onChange={(event) =>
                setHeader(index, { name: event.target.value })
              }
            />
            <PasswordInput
              className="rounded-none h-8 text-xs"
              placeholder={
                header.set
                  ? t("sync.proxy.savedValue")
                  : t("sync.proxy.headerValue")
              }
              value={header.value}
              onChange={(event) =>
                setHeader(index, { value: event.target.value })
              }
            />
            <button
              type="button"
              aria-label={t("sync.proxy.removeHeader")}
              className="p-1.5 text-muted-foreground hover:text-destructive"
              onClick={() =>
                onChange({
                  customHeaders: customHeaders.filter((_, i) => i !== index),
                })
              }
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="self-start flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground"
          onClick={() =>
            onChange({
              customHeaders: [...customHeaders, { name: "", value: "" }],
            })
          }
        >
          <Plus className="size-3" />
          {t("sync.proxy.addHeader")}
        </button>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-semibold">
              {t("sync.proxy.basicAuthTitle")}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {t("sync.proxy.basicAuthHint")}
            </span>
          </div>
          <Switch
            checked={!!basicAuth}
            onCheckedChange={(checked) =>
              onChange({
                basicAuth: checked ? { username: "", password: "" } : null,
              })
            }
          />
        </div>
        {basicAuth && (
          <div className="flex items-center gap-2">
            <Input
              className="rounded-none h-8 text-xs"
              placeholder={t("sync.proxy.username")}
              value={basicAuth.username}
              onChange={(event) =>
                onChange({
                  basicAuth: { ...basicAuth, username: event.target.value },
                })
              }
            />
            <PasswordInput
              className="rounded-none h-8 text-xs"
              placeholder={
                basicAuth.set
                  ? t("sync.proxy.savedValue")
                  : t("sync.proxy.password")
              }
              value={basicAuth.password}
              onChange={(event) =>
                onChange({
                  basicAuth: { ...basicAuth, password: event.target.value },
                })
              }
            />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-semibold">
              {t("sync.proxy.clientCertTitle")}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {t("sync.proxy.clientCertHint")}
            </span>
          </div>
          <Switch
            checked={!!clientCert}
            onCheckedChange={(checked) =>
              onChange({
                clientCert: checked
                  ? { pfx: "", passphrase: "", name: null }
                  : null,
              })
            }
          />
        </div>
        {clientCert && (
          <div className="flex items-center gap-2">
            <label className="flex h-8 shrink-0 cursor-pointer items-center border border-border px-2 text-xs hover:bg-muted">
              {t("sync.proxy.chooseCert")}
              <input
                type="file"
                accept=".pfx,.p12"
                className="hidden"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  const pfx = await readFileAsBase64(file).catch(() => "");
                  if (!pfx) return;
                  onChange({
                    clientCert: {
                      ...clientCert,
                      pfx,
                      name: file.name,
                      set: false,
                    },
                  });
                }}
              />
            </label>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {clientCert.name ?? t("sync.proxy.noCert")}
            </span>
            <PasswordInput
              className="rounded-none h-8 w-40 text-xs"
              placeholder={t("sync.proxy.certPassphrase")}
              value={clientCert.passphrase}
              onChange={(event) =>
                onChange({
                  clientCert: { ...clientCert, passphrase: event.target.value },
                })
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
