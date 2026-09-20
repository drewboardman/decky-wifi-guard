import type { Settings, Snapshot } from "./domain";

/** Effect algebras. The policy and supervisor depend only on these capabilities. */
export interface Repository {
  read(): Promise<Snapshot>;
  save(settings: Settings): Promise<void>;
  own(owned: boolean): Promise<void>;
}
export type Dispose = () => void;
export interface Steam {
  onNetworkChanged(
    notify: () => void,
    fault: (error: unknown) => void,
  ): Dispose;
  onPauseChanged(
    notify: (paused: boolean) => void,
    fault: (error: unknown) => void,
  ): Dispose;
  setDownloadsEnabled(enabled: boolean): Promise<void>;
}
export interface Runtime {
  now(): number;
  later(ms: number, run: () => void): Dispose;
  report(context: string, error: unknown): void;
}
export interface Ports {
  repository: Repository;
  steam: Steam;
  runtime: Runtime;
}
