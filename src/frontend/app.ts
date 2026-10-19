import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";

let current: TermixApp | null = null;

export function setApp(app: TermixApp | null): void {
  current = app;
}

/** The app handed to activate, for components that open sockets. */
export function getApp(): TermixApp {
  if (!current) throw new Error("Sync is not active");
  return current;
}
