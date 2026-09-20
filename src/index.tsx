import { definePlugin } from "@decky/api";
import { staticClasses } from "@decky/ui";
import { FaWifi } from "react-icons/fa";
import { DownloadGuard } from "./controller";
import { repository, runtime } from "./adapters/decky";
import { steamAdapter } from "./adapters/steam";
import { ErrorBoundary } from "./ErrorBoundary";
import { GuardPanel } from "./GuardPanel";

export default definePlugin(() => {
  let guard: DownloadGuard | undefined;
  try {
    const client = (
      window as unknown as { SteamClient?: Parameters<typeof steamAdapter>[0] }
    ).SteamClient;
    const service = new DownloadGuard({
      repository,
      runtime,
      steam: steamAdapter(client),
    });
    guard = service;
    const plugin = {
      name: "Wi-Fi Guard",
      titleView: <div className={staticClasses.Title}>Wi-Fi Guard</div>,
      icon: <FaWifi />,
      content: (
        <ErrorBoundary onError={(error) => service.fail(error)}>
          <GuardPanel guard={service} />
        </ErrorBoundary>
      ),
      onDismount() {
        void service
          .stop()
          .catch((error) => runtime.report("Unload failed", error));
      },
    };
    service.start();
    return plugin;
  } catch (error) {
    void guard
      ?.stop()
      .catch((cleanup) =>
        runtime.report("Initialization cleanup failed", cleanup),
      );
    runtime.report("Plugin initialization failed", error);
    return {
      name: "Wi-Fi Guard",
      icon: <span>!</span>,
      content: (
        <div role="alert">
          Wi-Fi Guard could not start. Reload Decky to retry.
        </div>
      ),
    };
  }
});
