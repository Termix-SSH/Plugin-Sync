import { describe, expect, it } from "vitest";
import locales from "../../locales/en.json";

// The entity types core registers for sync. Each needs a name in the panel.
const CORE_TYPES = [
  "sshCredentials",
  "sshFolders",
  "hosts",
  "hostDefaults",
  "hostDefaultsAdmin",
  "userPreferences",
  "pluginUserSettings",
  "accountProfile",
  "sharedCredentials",
  "sharedHosts",
];

describe("sync entity labels", () => {
  it("names every kind of data core syncs", () => {
    const labels = locales.sync.entities as Record<string, string>;
    expect(CORE_TYPES.filter((type) => !labels[type])).toEqual([]);
  });
});
