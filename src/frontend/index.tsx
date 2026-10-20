import { Cloud, Monitor } from "lucide-react";
import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { AccountSwitcher } from "./AccountSwitcher";
import { SitesSetting } from "./SitesTab";
import { setApp } from "./app";
import { RemoteStatusDot, remoteOf } from "./RemoteHost";
import { SyncPanel } from "./sync/SyncPanel";
import { DesktopSyncStep } from "./sync/OnboardingStep";
import { subscribeSyncStatus } from "./sync/status";
import { useSyncAttentionCount } from "./sync/use-sync-status";

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

  app.registerPanel("sync", SyncPanel);
  app.registerRailItem({
    id: "sync",
    icon: Cloud,
    titleKey: "sync.navTitle",
    kind: "panel",
    electronOnly: true,
    placement: "footer",
    group: "system",
    useBadge: useSyncAttentionCount,
  });

  app.registerOnboardingStep({
    id: "desktop",
    version: 1,
    titleKey: "onboarding.desktopTitle",
    icon: Monitor,
    component: DesktopSyncStep,
    audience: "all",
    position: 20,
    replaces: ["desktop-sync"],
    when: (context) => context.isDesktop,
  });

  // Keeps the sync status polled while the app is open, so views reload after
  // a pass even when no panel shows it.
  app.onDispose(subscribeSyncStatus(() => {}));

  app.registerSettingsComponent("sites", SitesSetting);

  app.registerHostStatusIndicator({
    id: "site-status",
    when: (host) => remoteOf(host, "sync") !== null,
    component: RemoteStatusDot,
  });
}

export function deactivate(): void {
  setApp(null);
}
