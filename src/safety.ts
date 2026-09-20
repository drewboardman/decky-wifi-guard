import type { Runtime } from "./ports";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export function describe(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).slice(
      0,
      400,
    );
  } catch {
    return "Unknown plugin error";
  }
}

/** Deadline bounds the caller, not the underlying RPC. Track it until settlement
 * so a timeout cannot create overlapping retries or late contradictory writes. */
export class Effects {
  private unsettled = false;
  constructor(privateRuntime: Runtime, timeoutMs = 6000) {
    this.runtime = privateRuntime;
    this.timeoutMs = timeoutMs;
  }
  private runtime: Runtime;
  private timeoutMs: number;
  get busy() {
    return this.unsettled;
  }
  async run<T>(
    label: string,
    effect: () => T | Promise<T>,
  ): Promise<Result<T>> {
    if (this.unsettled)
      return {
        ok: false,
        error:
          "A previous operation is still running. Retry after it finishes, or reload Decky.",
      };
    this.unsettled = true;
    let cancel = () => {};
    try {
      const work = Promise.resolve()
        .then(effect)
        .then(
          (value) => {
            this.unsettled = false;
            return { ok: true as const, value };
          },
          (error) => {
            this.unsettled = false;
            return {
              ok: false as const,
              error: `${label}: ${describe(error)}`,
            };
          },
        );
      const deadline = new Promise<Result<T>>((resolve) => {
        cancel = this.runtime.later(this.timeoutMs, () =>
          resolve({
            ok: false,
            error: `${label} timed out. Automatic protection stopped.`,
          }),
        );
      });
      return await Promise.race([work, deadline]);
    } catch (error) {
      return { ok: false, error: `${label}: ${describe(error)}` };
    } finally {
      try {
        cancel();
      } catch {
        /* Timer disposal must not escape. */
      }
    }
  }
}
