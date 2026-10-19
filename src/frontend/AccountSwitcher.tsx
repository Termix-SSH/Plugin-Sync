import { useCallback, useEffect, useState } from "react";
import { Check, ChevronsUpDown, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";

interface DesktopAccount {
  id: string;
  active: boolean;
  linked: boolean;
  serverUrl: string | null;
  serverName: string | null;
  username: string;
  status: string | null;
}

interface WebAccount {
  userId: string;
  username: string;
  current: boolean;
}

interface Row {
  id: string;
  title: string;
  detail: string;
  active: boolean;
  /** Colour of the small status dot, if the row has one. */
  state?: "ok" | "busy" | "bad";
}

const isDesktop = () =>
  typeof window !== "undefined" &&
  Boolean((window as { electronAPI?: unknown }).electronAPI);

/** The app starts again as whoever is now active. A token replaces the old one. */
function reloadApp(token?: string): void {
  try {
    if (token) localStorage.setItem("jwt", token);
    else localStorage.removeItem("jwt");
  } catch {
    // Storage can be blocked; the cookie still decides.
  }
  window.location.reload();
}

function errorMessage(error: unknown): string {
  const data = (error as { response?: { data?: { error?: string } } })?.response
    ?.data;
  if (data?.error) return data.error;
  return error instanceof Error ? error.message : String(error);
}

const DOT = {
  ok: "bg-green-500",
  busy: "bg-amber-500",
  bad: "bg-red-500",
} as const;

function stateOf(status: string | null): Row["state"] {
  if (status === "idle") return "ok";
  if (status === "syncing") return "busy";
  if (status === "offline" || status === "error" || status === "signed_out") {
    return "bad";
  }
  return undefined;
}

function AccountList({
  rows,
  onPick,
  onRemove,
  addLabel,
  onAdd,
}: {
  rows: Row[];
  onPick: (id: string) => void;
  onRemove: (row: Row) => void;
  addLabel: string;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col">
      <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("accounts.title")}
      </div>
      <ul className="max-h-72 overflow-auto border-y border-border">
        {rows.map((row) => (
          <li
            key={row.id}
            className="group flex items-center gap-3 px-3 py-2 hover:bg-muted/60"
          >
            <button
              type="button"
              disabled={row.active}
              onClick={() => onPick(row.id)}
              className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-accent-brand/30 bg-accent-brand/20 text-sm font-bold text-accent-brand">
                {row.title.charAt(0).toUpperCase() || "?"}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">
                  {row.title}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {row.detail}
                </span>
              </span>
              {row.state && (
                <span
                  className={`size-2 shrink-0 rounded-full ${DOT[row.state]}`}
                />
              )}
              {row.active && (
                <Check className="size-4 shrink-0 text-accent-brand" />
              )}
            </button>
            {!row.active && (
              <button
                type="button"
                onClick={() => onRemove(row)}
                aria-label={t("accounts.removeLabel", { name: row.title })}
                title={t("accounts.removeLabel", { name: row.title })}
                className="shrink-0 p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Trash2 className="size-4" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onAdd}
        className="flex items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/60"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground">
          <Plus className="size-4" />
        </span>
        {addLabel}
      </button>
    </div>
  );
}

function Shell({
  children,
  open,
  onOpenChange,
}: {
  children: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t("accounts.switch")}
          aria-label={t("accounts.switch")}
          className="flex size-7 items-center justify-center text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronsUpDown className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="end"
        sideOffset={8}
        className="w-80 p-0"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

function DesktopSwitcher() {
  const { t } = useTranslation();
  const api = usePluginApi();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<DesktopAccount[]>([]);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<{ accounts: DesktopAccount[] }>(
        "/accounts",
      );
      setAccounts(data.accounts);
    } catch {
      setAccounts([]);
    }
  }, [api]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    void load();
  }, [load]);

  async function switchTo(id: string) {
    try {
      const { data } = await api.post<{ token?: string }>("/accounts/switch", {
        userId: id,
      });
      reloadApp(data.token);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function addServer() {
    try {
      const { data } = await api.post<{ id: string }>("/accounts");
      await switchTo(data.id);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const rows: Row[] = accounts.map((account) => ({
    id: account.id,
    title: account.linked
      ? (account.serverName ?? account.serverUrl ?? account.username)
      : t("accounts.thisDevice"),
    detail: account.linked
      ? `${account.username} | ${account.serverUrl ?? ""}`
      : t("accounts.notLinked"),
    active: account.active,
    state: stateOf(account.status),
  }));

  async function remove(row: Row) {
    const ok = await confirm({
      title: t("accounts.removeTitle"),
      description: t("accounts.removeDescription", { name: row.title }),
    });
    if (!ok) return;
    try {
      await api.delete(`/accounts/${row.id}`);
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  if (rows.length === 0) return null;

  return (
    <Shell open={open} onOpenChange={setOpen}>
      <AccountList
        rows={rows}
        onPick={(id) => void switchTo(id)}
        onRemove={(row) => void remove(row)}
        addLabel={t("accounts.addServer")}
        onAdd={() => void addServer()}
      />
    </Shell>
  );
}

function WebSwitcher() {
  const { t } = useTranslation();
  const api = usePluginApi();
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<WebAccount[]>([]);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<{ ring: boolean; accounts: WebAccount[] }>(
        "/web/accounts",
      );
      if (data.ring && !data.accounts.some((account) => account.current)) {
        // This browser started adding an account and this one just signed in.
        await api.post("/web/accounts/attach");
        const next = await api.get<{ ring: boolean; accounts: WebAccount[] }>(
          "/web/accounts",
        );
        setAccounts(next.data.accounts);
        return;
      }
      setAccounts(data.accounts);
    } catch {
      setAccounts([]);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function switchTo(userId: string) {
    try {
      await api.post("/web/accounts/switch", { userId });
      reloadApp();
    } catch (error) {
      toast.error(errorMessage(error));
      await load();
    }
  }

  async function addAccount() {
    try {
      await api.post("/web/accounts/begin");
      reloadApp();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function signOut(row: Row) {
    try {
      await api.delete(`/web/accounts/${row.id}`);
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const rows: Row[] = accounts.map((account) => ({
    id: account.userId,
    title: account.username,
    detail: account.current
      ? t("accounts.signedIn")
      : t("accounts.signedInHere"),
    active: account.current,
  }));

  return (
    <Shell open={open} onOpenChange={setOpen}>
      <AccountList
        rows={rows}
        onPick={(id) => void switchTo(id)}
        onRemove={(row) => void signOut(row)}
        addLabel={t("accounts.addAccount")}
        onAdd={() => void addAccount()}
      />
    </Shell>
  );
}

export function AccountSwitcher() {
  return isDesktop() ? <DesktopSwitcher /> : <WebSwitcher />;
}
