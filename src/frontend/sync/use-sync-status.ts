import { useSyncExternalStore } from "react";
import { getSyncStatusSnapshot, subscribeSyncStatus } from "./status";

/** The desktop's sync status, kept current while the component is mounted. */
export function useSyncStatus() {
  return useSyncExternalStore(
    subscribeSyncStatus,
    getSyncStatusSnapshot,
    () => null,
  );
}

/** What needs the user's attention in Sync, for the rail badge. */
export function useSyncAttentionCount(): number | null {
  const status = useSyncStatus();
  if (!status?.linked) return null;
  const count =
    (status.conflicts ?? 0) +
    (status.errors ?? 0) +
    (status.status === "signed_out" ? 1 : 0);
  return count || null;
}

export type SyncTone = "ok" | "warning" | "error";

/** Connected, or not, for the dot on the rail icon. */
export function syncTone(
  status: { linked?: boolean; status?: string } | null,
): SyncTone | null {
  if (!status?.linked) return null;
  if (status.status === "offline" || status.status === "signed_out")
    return "error";
  if (status.status === "error") return "warning";
  return "ok";
}

export function useSyncTone(): SyncTone | null {
  return syncTone(useSyncStatus());
}
