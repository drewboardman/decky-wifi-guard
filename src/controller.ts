export interface BackendState {
  enabled: boolean;
  ssid: string;
  owned_pause: boolean;
  networks: string[];
  network_error: string | null;
}
export interface Subscription { unregister(): void }
export interface DownloadOverview { paused: boolean; remote_client_id?: string | number }
export interface Downloads {
  EnableAllDownloads(enable: boolean, clientId?: string): void;
  RegisterForDownloadOverview(callback: (overview: DownloadOverview) => void): Subscription;
}
export interface Network {
  RegisterForDeviceChanges(callback: (...args: unknown[]) => void): Subscription;
}
export interface Dependencies {
  read(): Promise<BackendState>;
  own(value: boolean): Promise<void>;
  downloads: Downloads;
  network: Network;
}
export interface ViewState {
  backend: BackendState | null;
  paused: boolean | null;
  blocked: boolean;
  error: string | null;
}

// Event subscriptions live for the plugin lifetime, not the panel lifetime.
export class DownloadGuard {
  state: ViewState = { backend: null, paused: null, blocked: false, error: null };
  private listeners = new Set<() => void>();
  private subscriptions: Subscription[] = [];
  private running: Promise<void> | null = null;
  private pending = false;
  private needsRead = false;
  private ready = false;
  private stopped = false;
  private owned = false;
  private deps: Dependencies;

  constructor(deps: Dependencies) { this.deps = deps; }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish() { for (const listener of this.listeners) listener(); }
  start() {
    try {
      if (typeof this.deps.downloads?.EnableAllDownloads !== "function" ||
          typeof this.deps.downloads?.RegisterForDownloadOverview !== "function" ||
          typeof this.deps.network?.RegisterForDeviceChanges !== "function") {
        throw new Error("This Steam client does not expose the required network/download events. Update Steam and reload the plugin.");
      }
      this.subscriptions.push(this.deps.downloads.RegisterForDownloadOverview((overview) => {
        // New clients also publish remote PCs' downloads. Only control this Deck.
        if (overview.remote_client_id != null && String(overview.remote_client_id) !== "0") return;
        if (typeof overview.paused !== "boolean" || this.state.paused === overview.paused) return;
        this.state = { ...this.state, paused: overview.paused };
        this.publish();
        if (this.ready) void this.refresh(false);
      }));
      this.subscriptions.push(this.deps.network.RegisterForDeviceChanges(() => {
        if (this.ready) void this.refresh();
      }));
      this.ready = true;
      void this.refresh();
    } catch (error) { this.fail(error); }
  }
  private fail(error: unknown) {
    this.state = { ...this.state, error: error instanceof Error ? error.message : String(error) };
    this.publish();
  }
  refresh(read = true): Promise<void> {
    if (this.stopped || !this.ready) return Promise.resolve();
    this.pending = true;
    this.needsRead ||= read;
    if (!this.running) {
      // Defer one microtask to coalesce synchronous events and set running first.
      this.running = Promise.resolve().then(() => this.drain()).finally(() => { this.running = null; if (this.pending && !this.stopped) void this.refresh(false); });
    }
    return this.running;
  }
  private async drain() {
    while (this.pending && !this.stopped) {
      this.pending = false;
      try {
        if (this.needsRead) {
          this.needsRead = false;
          let backend: BackendState;
          try { backend = await this.deps.read(); }
          catch (error) {
            if (this.state.backend) this.state = { ...this.state, backend: { ...this.state.backend, network_error: "Could not refresh network status. Retry before resuming downloads." } };
            throw error;
          }
          if (this.stopped) return;
          this.owned = backend.owned_pause;
          this.state = { ...this.state, backend };
          // A network event arrived during the snapshot: get the latest state
          // before resuming downloads on a potentially stale connection.
          if (this.needsRead) continue;
        }
        const backend = this.state.backend;
        if (!backend) return;
        const blocked = backend.enabled && !!backend.ssid && backend.networks.includes(backend.ssid);
        this.state = { ...this.state, blocked, error: null };
        if (backend.enabled && backend.ssid && backend.network_error) throw new Error(backend.network_error);
        if (this.state.paused === null) throw new Error("Waiting for Steam download status…");
        if (blocked && !this.state.paused) {
          if (!this.owned) {
            await this.deps.own(true);
            this.owned = true;
          }
          if (!this.stopped && !this.needsRead) this.deps.downloads.EnableAllDownloads(false, "0");
        } else if (!blocked && this.owned) {
          if (this.state.paused) {
            this.deps.downloads.EnableAllDownloads(true, "0");
            // Keep ownership until Steam confirms the resume with an event.
          } else {
            await this.deps.own(false);
            this.owned = false;
          }
        }
        this.publish();
      } catch (error) { this.fail(error); }
    }
  }
  async stop() {
    this.stopped = true;
    for (const subscription of this.subscriptions) subscription?.unregister();
    this.subscriptions = [];
    this.listeners.clear();
    await this.running;
    if (!this.owned) return;
    try {
      this.deps.downloads.EnableAllDownloads(true, "0");
      await this.deps.own(false);
      this.owned = false;
    } catch (error) {
      // If Decky tears down RPC first, the durable journal enables recovery.
      console.error("Wi-Fi Download Guard: cleanup incomplete; reload plugin or resume downloads manually", error);
    }
  }
}
