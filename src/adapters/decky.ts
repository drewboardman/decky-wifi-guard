import { callable } from "@decky/api";
import { isSnapshot } from "../domain";
import type { Repository, Runtime } from "../ports";

function unwrap(response: unknown): unknown {
  if (!response || typeof response !== "object" || !("ok" in response))
    throw new Error("Invalid backend response");
  const result = response as { ok: unknown; value?: unknown; error?: unknown };
  if (result.ok !== true)
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : "Backend operation failed",
    );
  return result.value;
}
export const repository: Repository = {
  async read() {
    const value = unwrap(await callable<[], unknown>("get_state")());
    if (!isSnapshot(value))
      throw new Error("Invalid backend state; protection stopped");
    return value;
  },
  async save(settings) {
    unwrap(
      await callable<[boolean, string], unknown>("save_settings")(
        settings.enabled,
        settings.ssid,
      ),
    );
  },
  async own(value) {
    unwrap(await callable<[boolean], unknown>("set_owned_pause")(value));
  },
};
export const runtime: Runtime = {
  now: () => performance.now(),
  later(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
  report(context, error) {
    try {
      console.error(`[Wi-Fi Guard] ${context}`, error);
    } catch {
      /* Logging is best effort. */
    }
  },
};
