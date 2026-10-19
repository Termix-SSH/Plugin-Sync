import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
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

const isDesktop = () =>
  typeof window !== "undefined" &&
  Boolean((window as { electronAPI?: unknown }).electronAPI);

/** The app signs in again as whoever is now active. */
function reloadApp(): void {
  try {
    localStorage.removeItem("jwt");
  } catch {
    // Storage can be blocked; the cookie or a new auto session still decides.
  }
  window.location.reload();
}

function errorMessage(error: unknown): string {
  const data = (error as { response?: { data?: { error?: string } } })?.response
    ?.data;
  if (data?.error) return data.error;
  return error instanceof Error ? error.message : String(error);
}

function DesktopSwitcher() {
  const { t } = useTranslation();
  const api = usePluginApi();
  const confirm = useConfirm();
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
    void load();
  }, [load]);

  const label = (account: DesktopAccount) =>
    account.linked
      ? `${account.serverName ?? account.serverUrl} | ${account.username}`
      : t("accounts.thisDevice");

  async function switchTo(id: string) {
    try {
      await api.post("/accounts/switch", { userId: id });
      reloadApp();
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

  async function remove(account: DesktopAccount) {
    const ok = await confirm({
      title: t("accounts.removeTitle"),
      description: t("accounts.removeDescription", { name: label(account) }),
    });
    if (!ok) return;
    try {
      await api.delete(`/accounts/${account.id}`);
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const active = accounts.find((account) => account.active);
  if (!active) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="max-w-full justify-start truncate"
          aria-label={t("accounts.switch")}
        >
          {label(active)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("accounts.title")}</DropdownMenuLabel>
        {accounts.map((account) => (
          <DropdownMenuItem
            key={account.id}
            disabled={account.active}
            onSelect={() => void switchTo(account.id)}
          >
            {label(account)}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void addServer()}>
          {t("accounts.addServer")}
        </DropdownMenuItem>
        {accounts
          .filter((account) => !account.active)
          .map((account) => (
            <DropdownMenuItem
              key={`remove-${account.id}`}
              onSelect={() => void remove(account)}
            >
              {t("accounts.remove", { name: label(account) })}
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WebSwitcher() {
  const { t } = useTranslation();
  const api = usePluginApi();
  const [ring, setRing] = useState(false);
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
        setRing(next.data.ring);
        setAccounts(next.data.accounts);
        return;
      }
      setRing(data.ring);
      setAccounts(data.accounts);
    } catch {
      setAccounts([]);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

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

  async function signOut(userId: string) {
    try {
      await api.delete(`/web/accounts/${userId}`);
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const current = accounts.find((account) => account.current);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="max-w-full justify-start truncate"
          aria-label={t("accounts.switch")}
        >
          {current?.username ?? t("accounts.title")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("accounts.title")}</DropdownMenuLabel>
        {ring &&
          accounts.map((account) => (
            <DropdownMenuItem
              key={account.userId}
              disabled={account.current}
              onSelect={() => void switchTo(account.userId)}
            >
              {account.username}
            </DropdownMenuItem>
          ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void addAccount()}>
          {t("accounts.addAccount")}
        </DropdownMenuItem>
        {ring &&
          accounts
            .filter((account) => !account.current)
            .map((account) => (
              <DropdownMenuItem
                key={`out-${account.userId}`}
                onSelect={() => void signOut(account.userId)}
              >
                {t("accounts.signOut", { name: account.username })}
              </DropdownMenuItem>
            ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AccountSwitcher() {
  return isDesktop() ? <DesktopSwitcher /> : <WebSwitcher />;
}
