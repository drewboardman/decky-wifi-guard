import { GuardFault, issue, issueFor } from "./errors";
import type { UiIssue } from "./errors";
import { decide, isSettings, isSnapshot, protects } from "./domain";
import type { Settings, Snapshot } from "./domain";
import type { Dispose, Ports } from "./ports";
import { Effects } from "./safety";

export interface ViewState {
  backend: Snapshot | null;
  paused: boolean | null;
  blocked: boolean;
  issue: UiIssue | null;
  mode: "starting" | "active" | "faulted" | "stopped";
}

/** A bounded interpreter for the decision algebra. All external entry points
 * contain errors. Faults latch open until the user explicitly retries. */
export class DownloadGuard {
  state: ViewState = {
    backend: null,
    paused: null,
    blocked: false,
    issue: null,
    mode: "starting",
  };
  private listeners = new Set<() => void>();
  private subscriptions: Dispose[] = [];
  private effects: Effects;
  private ports: Ports;
  private running: Promise<void> | null = null;
  private stopped = false;
  private owned = false;
  private pending = false;
  private needsRead = false;
  private settings: Settings | null = null;
  private cancelScheduled: Dispose | null = null;
  private started = false;
  private eventWindow = 0;
  private eventCount = 0;
  private cleanupFailed = false;
  private command: boolean | null = null;
  private cancelAcknowledgement: Dispose | null = null;
  private generation = 0;

  constructor(ports: Ports, timeoutMs = 6000) {
    this.ports = ports;
    this.effects = new Effects(ports.runtime, timeoutMs);
  }
  subscribe = (listener: () => void): Dispose => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private report(context: string, error: unknown) {
    try {
      this.ports.runtime.report(context, error);
    } catch {
      /* Fault reporting cannot fault. */
    }
  }
  private publish() {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.listeners.delete(listener);
        this.report("Removed failing view listener", error);
      }
    }
  }
  private clearSubscriptions() {
    this.generation++; // Invalidate callbacks even when native unsubscribe fails.
    const subscriptions = this.subscriptions.splice(0);
    for (const unsubscribe of subscriptions) {
      try {
        unsubscribe();
      } catch (error) {
        this.cleanupFailed = true;
        this.report("Unsubscribe failed; callback disabled", error);
      }
    }
  }
  private trip = (error: unknown) => {
    if (this.halted()) return;
    this.pending = false;
    this.settings = null;
    try {
      this.cancelScheduled?.();
    } catch {
      /* Best effort. */
    }
    this.cancelScheduled = null;
    try {
      this.cancelAcknowledgement?.();
    } catch {
      /* Best effort. */
    }
    this.cancelAcknowledgement = null;
    this.state = {
      ...this.state,
      mode: "faulted",
      issue: issueFor(error),
    };
    this.report("Protection stopped", error);
    this.publish();
  };
  private halted() {
    return this.stopped || this.state.mode === "faulted";
  }
  private boundary(action: () => void) {
    if (this.halted()) return;
    try {
      action();
    } catch (error) {
      this.trip(error);
    }
  }
  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.boundary(() => {
      const generation = ++this.generation;
      const fault = (error: unknown) => {
        if (generation === this.generation) this.trip(error);
      };
      this.subscriptions.push(
        this.ports.steam.onPauseChanged((paused) => {
          if (generation !== this.generation) return;
          this.boundary(() => {
            if (typeof paused !== "boolean")
              throw new GuardFault("invalid_response", "Invalid pause event");
            if (paused === this.state.paused) return;
            this.state = { ...this.state, paused };
            if (this.command !== null && paused === !this.command) {
              this.command = null;
              this.cancelAcknowledgement?.();
              this.cancelAcknowledgement = null;
            }
            this.publish();
            this.event(false);
          });
        }, fault),
      );
      if (this.state.mode === "faulted") {
        this.clearSubscriptions();
        return;
      }
      this.subscriptions.push(
        this.ports.steam.onNetworkChanged(() => {
          if (generation === this.generation)
            this.boundary(() => this.event(true));
        }, fault),
      );
      if (this.halted()) {
        this.clearSubscriptions();
        return;
      }
      this.state = { ...this.state, mode: "active" };
      void this.refresh();
    });
    if (this.state.mode === "faulted") this.clearSubscriptions();
  }
  private event(read: boolean) {
    const now = this.ports.runtime.now();
    if (now - this.eventWindow >= 1000) {
      this.eventWindow = now;
      this.eventCount = 0;
    }
    if (++this.eventCount > 100)
      throw new GuardFault("event_overload", "Excessive event rate");
    this.pending = true;
    this.needsRead ||= read;
    // One-shot coalescing; idle plugins have no scheduled work or polling.
    if (!this.cancelScheduled && !this.running)
      this.cancelScheduled = this.ports.runtime.later(100, () => {
        this.cancelScheduled = null;
        this.boundary(() => {
          void this.refresh(false);
        });
      });
  }
  refresh(read = true): Promise<void> {
    if (this.halted()) return Promise.resolve();
    try {
      this.cancelScheduled?.();
      this.cancelScheduled = null;
      this.pending = true;
      this.needsRead ||= read;
      if (!this.running)
        this.running = Promise.resolve()
          .then(() => this.drain())
          .catch((error) => this.trip(error))
          .finally(() => {
            this.running = null;
            if (this.pending && !this.halted()) void this.refresh(false);
          });
      return this.running;
    } catch (error) {
      this.trip(error);
      return Promise.resolve();
    }
  }
  async configure(settings: Settings): Promise<void> {
    if (!isSettings(settings)) {
      this.trip(new GuardFault("invalid_settings"));
      return;
    }
    if (this.stopped) return;
    if (this.state.mode === "faulted") {
      this.publish();
      return;
    }
    this.settings = { ...settings };
    await this.refresh();
  }
  async retry(): Promise<void> {
    if (this.stopped) return;
    if (this.effects.busy || this.running || this.cleanupFailed) {
      this.state = {
        ...this.state,
        issue: issue(this.cleanupFailed ? "cleanup_failed" : "busy"),
      };
      this.publish();
      return;
    }
    // Re-subscribe to receive a fresh Steam pause snapshot: events deliberately
    // ignored while faulted may have changed the native state in the meantime.
    this.clearSubscriptions();
    if (this.cleanupFailed) {
      this.state = {
        ...this.state,
        mode: "faulted",
        issue: issue("cleanup_failed"),
      };
      this.publish();
      return;
    }
    this.state = { ...this.state, mode: "starting", paused: null, issue: null };
    this.eventCount = 0;
    this.command = null;
    this.started = false;
    this.start();
    await this.running;
  }

  private async effect<T>(
    label: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const result = await this.effects.run(label, operation);
    if (!result.ok) throw result.error;
    return result.value;
  }
  private async drain() {
    let steps = 0;
    while (this.pending && !this.halted()) {
      if (++steps > 16)
        throw new GuardFault("event_overload", "Event feedback loop detected");
      this.pending = false;
      if (this.settings) {
        const settings = this.settings;
        this.settings = null;
        await this.effect("Save settings", () =>
          this.ports.repository.save(settings),
        );
        this.needsRead = true;
      }
      if (this.needsRead) {
        this.needsRead = false;
        const snapshot = await this.effect("Read network state", () =>
          this.ports.repository.read(),
        );
        if (!isSnapshot(snapshot))
          throw new GuardFault("invalid_response", "Malformed backend state");
        if (this.halted()) return;
        this.owned = snapshot.owned_pause;
        this.state = {
          ...this.state,
          backend: snapshot,
          blocked: protects(snapshot),
          issue: null,
        };
        if (this.needsRead) continue;
      }
      if (this.halted()) return;
      const decision = decide(
        this.state.backend,
        this.state.paused,
        this.owned,
      );
      switch (decision.kind) {
        case "wait":
          this.state = { ...this.state, issue: issue(decision.reason) };
          break;
        case "hold":
          this.state = { ...this.state, issue: null };
          break;
        case "acquire":
          await this.effect("Save pause ownership", () =>
            this.ports.repository.own(true),
          );
          this.owned = true;
          this.pending = true;
          break;
        case "pause":
        case "resume": {
          const enabled = decision.kind === "resume";
          if (this.command !== enabled) {
            this.command = enabled;
            await this.effect(
              enabled ? "Resume downloads" : "Pause downloads",
              () => this.ports.steam.setDownloadsEnabled(enabled),
            );
            if (!this.halted() && this.state.paused !== !enabled) {
              this.cancelAcknowledgement?.();
              this.cancelAcknowledgement = this.ports.runtime.later(
                3000,
                () => {
                  this.cancelAcknowledgement = null;
                  this.trip(new GuardFault("command_unconfirmed"));
                },
              );
            }
          }
          break;
        }
        case "release":
          await this.effect("Release pause ownership", () =>
            this.ports.repository.own(false),
          );
          this.owned = false;
          break;
        default: {
          const unreachable: never = decision;
          throw new Error(`Unsupported decision: ${String(unreachable)}`);
        }
      }
      this.publish();
    }
  }
  /** Called by React's boundary too. Do not globally intercept Steam's errors. */
  fail(error: unknown) {
    this.trip(error);
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.state = { ...this.state, mode: "stopped" };
    try {
      this.cancelScheduled?.();
    } catch (error) {
      this.report("Timer cleanup", error);
    }
    try {
      this.cancelAcknowledgement?.();
    } catch (error) {
      this.report("Acknowledgement cleanup", error);
    }
    this.clearSubscriptions();
    this.listeners.clear();
    await this.running;
    // A timed-out RPC may still mutate state. Never issue a competing command.
    // Keep the durable journal for recovery on the next load.
    if (!this.owned || this.effects.busy) return;
    const resumed = await this.effects.run("Restore downloads", () =>
      this.ports.steam.setDownloadsEnabled(true),
    );
    if (!resumed.ok) {
      this.report("Unload recovery deferred", resumed.error);
      return;
    }
    const released = await this.effects.run("Clear ownership", () =>
      this.ports.repository.own(false),
    );
    if (!released.ok) this.report("Unload recovery deferred", released.error);
    else this.owned = false;
  }
}
