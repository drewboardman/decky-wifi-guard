import { GuardFault } from "../errors";
import type { Dispose, Steam } from "../ports";

interface Registration {
  unregister(): void;
}
interface SteamClient {
  Downloads?: {
    EnableAllDownloads(enable: boolean, clientId: string): unknown;
    RegisterForDownloadOverview(
      callback: (value: unknown) => void,
    ): Registration;
  };
  System?: {
    Network?: {
      RegisterForDeviceChanges(
        callback: (...args: unknown[]) => void,
      ): Registration;
    };
  };
}

function dispose(registration: Registration): Dispose {
  if (typeof registration?.unregister !== "function")
    throw new GuardFault("invalid_response", "Invalid native subscription");
  return () => registration.unregister();
}

/** Decode untrusted native events at the boundary; never throw back into Steam. */
export function steamAdapter(client: SteamClient | undefined): Steam {
  return {
    onNetworkChanged(notify, fault) {
      const network = client?.System?.Network;
      if (typeof network?.RegisterForDeviceChanges !== "function")
        throw new GuardFault("steam_unavailable", "Network events unavailable");
      return dispose(
        network.RegisterForDeviceChanges(() => {
          try {
            notify();
          } catch (error) {
            try {
              fault(error);
            } catch {
              /* Native boundary. */
            }
          }
        }),
      );
    },
    onPauseChanged(notify, fault) {
      const downloads = client?.Downloads;
      if (typeof downloads?.RegisterForDownloadOverview !== "function")
        throw new GuardFault(
          "steam_unavailable",
          "Download events unavailable",
        );
      return dispose(
        downloads.RegisterForDownloadOverview((value) => {
          try {
            if (!value || typeof value !== "object")
              throw new GuardFault(
                "invalid_response",
                "Malformed Steam download event",
              );
            const overview = value as {
              paused?: unknown;
              remote_client_id?: unknown;
            };
            if (
              overview.remote_client_id != null &&
              overview.remote_client_id !== "0" &&
              overview.remote_client_id !== 0
            )
              return;
            if (typeof overview.paused !== "boolean")
              throw new GuardFault(
                "invalid_response",
                "Malformed Steam pause state",
              );
            notify(overview.paused);
          } catch (error) {
            try {
              fault(error);
            } catch {
              /* Native boundary. */
            }
          }
        }),
      );
    },
    async setDownloadsEnabled(enabled) {
      const downloads = client?.Downloads;
      if (typeof downloads?.EnableAllDownloads !== "function")
        throw new GuardFault(
          "steam_unavailable",
          "Download controls unavailable",
        );
      await downloads.EnableAllDownloads(enabled, "0");
    },
  };
}
