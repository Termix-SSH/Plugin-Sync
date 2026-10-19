/** Bumped when a desktop and server can no longer understand each other. */
export const SYNC_PROTOCOL_VERSION = 1;

/** What kind of client is syncing. Sent when linking, optional for older clients. */
export const CLIENT_TYPES = [
  "desktop",
  "mobile",
  "web",
  "cli",
  "master",
] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

export function readClientType(value: unknown): ClientType {
  return typeof value === "string" &&
    (CLIENT_TYPES as readonly string[]).includes(value)
    ? (value as ClientType)
    : "desktop";
}

/** A device id is a short opaque string the client keeps. */
export function readDeviceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[A-Za-z0-9._-]{8,100}$/.test(id) ? id : null;
}
