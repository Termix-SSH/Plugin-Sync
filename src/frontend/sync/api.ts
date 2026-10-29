import { getApp } from "../app";

// Replies are read loosely, like the old client did.
/* eslint-disable @typescript-eslint/no-explicit-any */
const authApi = {
  get: (url: string, config?: unknown) => getApp().api.get<any>(url, config),
  post: (url: string, body?: unknown, config?: unknown) =>
    getApp().api.post<any>(url, body, config),
  put: (url: string, body?: unknown, config?: unknown) =>
    getApp().api.put<any>(url, body, config),
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export type SyncState = "idle" | "syncing" | "offline" | "error" | "signed_out";

export interface SyncProxyHeader {
  name: string;
  value: string;
  /** A saved header whose value is not sent back. */
  set?: boolean;
}

export interface SyncBasicAuth {
  username: string;
  password: string;
  set?: boolean;
}

export interface SyncClientCert {
  /** Base64 of the PFX/P12 file. Empty for a saved one. */
  pfx: string;
  passphrase: string;
  name: string | null;
  /** A saved certificate whose file is not sent back. */
  set?: boolean;
}

export interface SyncEntityInfo {
  type: string;
  owner: string;
  ownerName: string | null;
  readOnly: boolean;
  onServer: boolean;
  onDevice: boolean;
  enabled: boolean;
}

export interface SyncStatus {
  linked: boolean;
  serverUrl?: string;
  serverName?: string | null;
  serverVersion?: string | null;
  account?: {
    username?: string;
    isAdmin?: boolean;
    roles?: string[];
    permissions?: string[];
  };
  status?: SyncState;
  lastError?: string | null;
  linkedAt?: string;
  lastSyncAt?: string | null;
  pending?: number;
  conflicts?: number;
  errors?: number;
  firstSyncDone?: boolean;
  allowInvalidCertificate?: boolean;
  customHeaders?: SyncProxyHeader[];
  basicAuth?: SyncBasicAuth | null;
  clientCert?: SyncClientCert | null;
  entities: SyncEntityInfo[];
}

export type ProbeProblem =
  | "invalid_url"
  | "unreachable"
  | "tls_untrusted"
  | "basic_auth_required"
  | "client_cert_invalid"
  | "proxy_login"
  | "not_termix"
  | "sync_off"
  | "version_mismatch"
  | "different_account";

export interface ProbeResult {
  ok: boolean;
  serverUrl?: string;
  name?: string;
  version?: string | null;
  problem?: ProbeProblem;
  message?: string;
}

export interface ServerTarget {
  serverUrl: string;
  customHeaders?: SyncProxyHeader[];
  basicAuth?: SyncBasicAuth | null;
  allowInvalidCertificate?: boolean;
  clientCert?: SyncClientCert | null;
}

export interface SyncConflictItem {
  id: number;
  entityType: string;
  syncId: string;
  name: string;
  createdAt: string;
}

export interface SyncErrorItem {
  entityType: string;
  syncId: string;
  reason: string | null;
}

export async function getSyncStatus(): Promise<SyncStatus> {
  return (await authApi.get("/link/status")).data;
}

export async function probeServer(target: ServerTarget): Promise<ProbeResult> {
  return (await authApi.post("/link/probe", target)).data;
}

export async function getLinkPreview(): Promise<Record<string, number>> {
  return (await authApi.get("/link/preview")).data?.counts ?? {};
}

export async function completeLink(
  input: ServerTarget & {
    token: string;
    mode: "merge" | "replace";
    serverName?: string;
  },
): Promise<SyncStatus> {
  return (await authApi.post("/link/complete", input)).data;
}

export async function reloginLink(token: string): Promise<SyncStatus> {
  return (await authApi.post("/link/relogin", { token })).data;
}

export async function unlinkServer(keepData: boolean): Promise<SyncStatus> {
  return (await authApi.post("/link/unlink", { keepData })).data;
}

export async function syncNow(): Promise<SyncStatus> {
  return (await authApi.post("/link/sync", {}, { timeout: 300_000 })).data;
}

export async function updateSyncSettings(settings: {
  disabledTypes?: string[];
  customHeaders?: SyncProxyHeader[];
  basicAuth?: SyncBasicAuth | null;
  allowInvalidCertificate?: boolean;
  clientCert?: SyncClientCert | null;
}): Promise<SyncStatus> {
  return (await authApi.put("/link/settings", settings)).data;
}

export async function getSyncConflicts(): Promise<SyncConflictItem[]> {
  return (await authApi.get("/link/conflicts")).data?.conflicts ?? [];
}

export async function settleSyncConflict(
  id: number,
  keep: "mine" | "server",
): Promise<void> {
  await authApi.post(`/link/conflicts/${id}`, { keep });
}

export async function settleAllSyncConflicts(
  keep: "mine" | "server",
): Promise<{ settled: number; failed: number }> {
  return (await authApi.post("/link/conflicts", { keep })).data;
}

export async function getSyncErrors(): Promise<SyncErrorItem[]> {
  return (await authApi.get("/link/errors")).data?.errors ?? [];
}

export async function retrySyncErrors(): Promise<SyncStatus> {
  return (await authApi.post("/link/errors/retry", {}, { timeout: 300_000 }))
    .data;
}
