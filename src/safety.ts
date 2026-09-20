import type { Runtime } from "./ports";
import { GuardFault } from "./errors";

export type Result<T> = { ok: true; value: T } | { ok: false; error: unknown };
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
        error: new GuardFault("busy"),
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
              error: new GuardFault(
                error instanceof GuardFault ? error.code : "unknown",
                { operation: label, cause: error },
              ),
            };
          },
        );
      const deadline = new Promise<Result<T>>((resolve) => {
        cancel = this.runtime.later(this.timeoutMs, () =>
          resolve({
            ok: false,
            error: new GuardFault("timeout", { operation: label }),
          }),
        );
      });
      return await Promise.race([work, deadline]);
    } catch (error) {
      return {
        ok: false,
        error: new GuardFault("unknown", { operation: label, cause: error }),
      };
    } finally {
      try {
        cancel();
      } catch {
        /* Timer disposal must not escape. */
      }
    }
  }
}
