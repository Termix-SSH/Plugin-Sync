import type {
  PluginSyncHost,
  SyncLinkInfo,
} from "@termix-ssh/plugin-sdk/backend";
import { SyncEngine, type EngineLog } from "./engine.js";

/**
 * One engine per linked account, so every server syncs into its own replica
 * user. Only the active account's link is handed to the app's main process,
 * since that is the server the window talks to.
 */
export class EngineManager {
  private readonly engines = new Map<string, SyncEngine>();

  constructor(
    private readonly host: PluginSyncHost,
    private readonly log: EngineLog,
  ) {}

  /** Tells the main process how to reach the link, when it is the active one. */
  applyProxy = async (link: SyncLinkInfo | null): Promise<void> => {
    if (!link) return;
    const active = await this.host.accounts.activeId();
    if (active === link.userId) await this.host.desktop.applyProxy(link);
  };

  /** The active account's link, or nothing when it has none. */
  async applyActiveProxy(): Promise<void> {
    await this.host.desktop.applyProxy(await this.host.links.get());
  }

  engineFor(userId: string): SyncEngine {
    let engine = this.engines.get(userId);
    if (!engine) {
      engine = new SyncEngine(
        this.host,
        {
          get: () => this.host.links.get(userId),
          update: (patch) => this.host.links.update(patch, userId),
        },
        this.log,
        this.applyProxy,
      );
      this.engines.set(userId, engine);
      engine.start();
    }
    return engine;
  }

  /** Starts an engine for every link that exists. */
  async startAll(): Promise<void> {
    for (const link of await this.host.links.list())
      this.engineFor(link.userId);
  }

  stop(userId: string): void {
    const engine = this.engines.get(userId);
    if (!engine) return;
    engine.reset();
    engine.stop();
    this.engines.delete(userId);
  }

  stopAll(): void {
    for (const userId of [...this.engines.keys()]) this.stop(userId);
  }

  has(userId: string): boolean {
    return this.engines.has(userId);
  }
}
