import { GuardFault } from "../errors";
import { unwrap } from "./protocol";
import { callable } from "@decky/api";
import { isSnapshot } from "../domain";
import type { Repository, Runtime } from "../ports";

export const repository: Repository = {
  async read() {
    const value = unwrap(await callable<[], unknown>("get_state")());
    if (!isSnapshot(value))
      throw new GuardFault("invalid_response", "Invalid backend state");
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
