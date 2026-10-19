import { Globe } from "lucide-react";
import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { AccountSwitcher } from "./AccountSwitcher";
import { SitesTab } from "./SitesTab";
import { SiteTerminal } from "./SiteTerminal";
import { setApp } from "./app";

export const ACCOUNT_SLOT = "shell.accountSwitcher";

export function activate(app: TermixApp): void {
  setApp(app);

  app.registerSlotContribution(ACCOUNT_SLOT, {
    actionId: "sync.accountSwitcher",
    titleKey: "accounts.title",
    kind: "component",
    component: AccountSwitcher,
    order: 10,
  });

  app.registerTab("sites", SitesTab, {
    icon: Globe,
    titleKey: "sites.title",
    singleton: true,
    hostless: true,
  });

  app.registerTab("site_terminal", SiteTerminal, {
    icon: Globe,
    titleKey: "sites.terminal.title",
    hostless: true,
    session: true,
  });

  app.registerRailItem({
    id: "sites",
    icon: Globe,
    titleKey: "sites.title",
    kind: "tab",
    permission: "sites",
  });
}

export function deactivate(): void {
  setApp(null);
}
