# Wi-Fi Download Guard

A Decky plugin that pauses Steam downloads while connected to one chosen Wi-Fi network. The compact Quick Access panel follows the local Decky OptiScaler plugin's native controls, status pills, and notices.

## Use

1. Open **Wi-Fi Download Guard** in Decky.
2. Choose **Use current network**, or enter the exact network name (SSID) and save it.
3. Leave **Pause on this network** enabled.

Steam game updates, game installs, and Workshop downloads pause on that network. Downloads resume after leaving only if the guard paused them. A pause already in effect before protection starts is preserved. To download on the protected network, turn the guard off; otherwise manually resuming Steam downloads causes the guard to pause them again.

The Wi-Fi radio stays on. Games, browser traffic, Steam Cloud, and other apps remain usable. This does not block OS updates, other applications, or Steam's own client updater.

## Event-driven operation

There are **no polling timers, pings, connectivity probes, or forced Wi-Fi scans**.

- `SteamClient.System.Network.RegisterForDeviceChanges` triggers a local SSID snapshot on startup and whenever Steam reports device changes.
- The backend reads NetworkManager's existing access-point state with `nmcli --terse --escape yes --colors no --fields IN-USE,SSID device wifi list --rescan no`. It uses the active SSID, not the editable connection-profile name. Names containing colons, backslashes, Unicode, or spaces are handled exactly.
- `SteamClient.Downloads.RegisterForDownloadOverview` reports pause-state changes. Unchanged download progress and remote PCs' download events are ignored. These events reuse the cached network state rather than launching more network queries.
- `EnableAllDownloads(false, "0")` pauses this Steam client's download queue; `true` restores it.
- Settings changes and **Retry status** request a fresh snapshot. Concurrent events are serialized and coalesced; a newer network event invalidates an in-flight snapshot before it can resume downloads.

Subscriptions belong to the plugin, so closing the Quick Access panel does not stop protection. On an unsupported Steam client, the plugin displays an error instead of falling back to polling.

The native network callback carries a binary protobuf; this first version uses it as a change notification and lets NetworkManager supply the exact SSID. This avoids coupling the plugin to Steam's private protobuf classes.

## Recovery and scope

Settings and pause ownership are saved atomically in Decky's plugin settings directory. Ownership is saved before pausing so reloads can recover. Network lookup errors keep the current download state; disabling the guard still releases a pause it owns. An unreadable settings journal is reported and not overwritten.

Normal plugin unload attempts to restore owned pauses. A forced Steam/Decky exit can interrupt cleanup; reloading the plugin reconciles the saved journal, or you can resume downloads in Steam manually. Steam exposes one global pause flag, so it cannot distinguish an additional manual pause made while the guard already holds that pause.

Protection requires Steam Gaming Mode with Decky running. It is reactive, not a firewall: a small amount of download traffic may pass during startup or a network transition before the event is processed. Desktop Mode and periods when Decky is unavailable are not covered. If multiple Wi-Fi adapters are connected, a match on any adapter activates protection.

## Build and test

Requires Node.js 22.6+ (for the TypeScript test runner), Python 3.9+, and pnpm 9.15.9. No Python packages are required.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
python3 scripts/package.py
```

The installable archive is `out/decky-wifi-toggle-0.1.0.zip`. If your system pnpm/Corepack is unavailable, use `npx --yes pnpm@9.15.9` in place of `pnpm`.

## Install on Steam Deck

Copy the ZIP to the Deck, extract its **Wi-Fi Download Guard** directory into `~/homebrew/plugins/`, then restart Decky Loader (or reboot). If hosting the ZIP at a reachable URL, Decky's developer **Install Plugin from URL** option can install it directly.

## On-device verification

Local tests cover the policy and backend; real SteamOS integration still needs this check:

- Start a download on ordinary Wi-Fi, then connect to the configured network: the queue should pause with the panel closed.
- Switch away: it should resume. Repeat with Steam already manually paused: it should stay paused.
- Try Resume while protected: the guard should pause again. Turn the guard off: an owned pause should release.
- Check sleep/wake, Wi-Fi off/on, plugin reload, and plugin removal.
- Confirm the panel follows network changes and that controller navigation and the on-screen keyboard work.

## API references and attribution

The network callback, local client ID `"0"`, and download calls were checked against [Steam's UI source mirrored by SteamTracking](https://github.com/SteamDatabase/SteamTracking/blob/master/ClientExtracted/steamui/chunk~2dcc5aaf7.js). These are internal Steam interfaces and should be checked again if a Steam update changes them. NetworkManager's read-only flags are documented in the [nmcli manual](https://networkmanager.dev/docs/api/latest/nmcli.html).

`src/Common.tsx` and the initial build configuration were adapted from the existing local `decky-optiscaler` project. Its BSD 3-Clause license and notices are retained in `LICENSE`. No OptiScaler payloads or game-modification code are included.
# decky-wifi-guard
