# Wi-Fi Guard

A Decky plugin that automatically pauses Steam downloads on one chosen Wi-Fi network. Its compact Quick Access panel uses native Decky controls, status pills, and notices adapted from the local OptiScaler plugin.

## Install

Download the ZIP from [Releases](https://github.com/drewboardman/decky-wifi-guard/releases). Copy it to the Deck and extract its **Wi-Fi Guard** directory into `~/homebrew/plugins/`, then restart Decky Loader or reboot. Alternatively, enable Decky's developer mode and use **Install Plugin from URL** with the release asset's download URL.

If you previously sideloaded the unpublished **Wi-Fi Download Guard** prototype, remove it before installing **Wi-Fi Guard** so two plugins do not compete for the same download queue. Configure the network again in the renamed plugin.

## Use

1. Open **Wi-Fi Guard** in Decky.
2. Choose **Use current network**, or enter an exact Wi-Fi name (SSID) and save.
3. Leave **Pause on this network** enabled.

Steam game installs, game updates, and Workshop downloads pause on that network. Downloads resume after leaving only if the guard paused them. A pause already in effect before protection starts is preserved. Turn the guard off to download on the protected network; manually resuming while protection is active causes the guard to pause again.

Wi-Fi stays on, so games, browser traffic, Steam Cloud, and other applications remain usable. Other apps, OS updates, and Steam's client updater are not blocked.

## Events, not polling

`SteamClient.System.Network.RegisterForDeviceChanges` drives network updates. On startup or a network event, the backend takes a local, read-only SSID snapshot using NetworkManager's `nmcli ... device wifi list --rescan no`. The network name is matched exactly, including Unicode, capitalization, spaces, colons, and backslashes.

`SteamClient.Downloads.RegisterForDownloadOverview` drives pause-state updates. Unchanged progress events and remote PCs' download events are ignored. `EnableAllDownloads` targets only the local Steam client (`"0"`). Subscriptions stay alive when the panel is closed.

There are no pings, connectivity probes, forced Wi-Fi scans, or recurring polling timers. One-shot timers coalesce event bursts and bound operations; a healthy idle plugin schedules no work. Unsupported Steam APIs produce a visible error rather than a polling fallback.

## Failure handling

Unexpected errors stop automatic processing and show **Retry protection**. The plugin does not automatically restart or retry failed operations. Fault handling covers native callbacks, rejected promises, malformed data, partial initialization, listener failures, UI rendering, cleanup failures, event floods, and feedback loops.

A hung operation has a deadline and remains tracked until it settles, so retrying cannot pile up calls. Retry obtains fresh Steam pause state. An unreadable settings file leaves the backend inactive rather than entering a startup crash loop. Logs are emitted once per supervisor fault; failed view listeners are removed.

Settings and pause ownership are persisted atomically in Decky's plugin settings directory. Ownership is saved before pausing. Failed network detection preserves the existing download state. Normal unload attempts to restore an owned pause; if cleanup fails or an operation is uncertain, the saved journal supports recovery on the next load. Steam's Downloads page remains available for manual recovery.

These protections contain plugin-level failures, but the frontend shares Steam's process and cannot guarantee against native Steam or OS crashes. Architecture, limits, and recovery details are in [docs/architecture.md](docs/architecture.md).

## Scope

Protection requires Gaming Mode with Decky running. It is reactive, not a firewall; some download traffic may pass during startup or a network transition before the event is processed. Desktop Mode is not covered. A matching connection on any Wi-Fi adapter activates protection.

Steam exposes one global pause flag: an additional manual pause made while the guard already holds that pause cannot be distinguished. Network lookup failures preserve the current state; they cannot establish protection on a new, unknown network.

## Development

Requires Node.js 22.6+, Python 3.9+, and pnpm 9.15.9. No Python packages are required.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
python3 scripts/package.py
```

The installable archive is `out/decky-wifi-guard-0.1.0.zip`. If system pnpm/Corepack is unavailable, substitute `npx --yes pnpm@9.15.9` for `pnpm`. CI runs the same checks and packages an artifact.

Tests cover pure policy, native event boundaries, simulated storms/timeouts/failures, actual React error containment, persistence, and subprocess cleanup. Live SteamOS acceptance is still required: switching networks, pre-existing manual pause, manual resume while protected, sleep/wake, panel closed, plugin reload, fault retry, and removal.

## References and attribution

Network/download calls were checked against [Steam's UI source mirrored by SteamTracking](https://github.com/SteamDatabase/SteamTracking/blob/master/ClientExtracted/steamui/chunk~2dcc5aaf7.js). They are internal Steam interfaces, which can change with Steam updates. NetworkManager's flags are described in its [nmcli manual](https://networkmanager.dev/docs/api/latest/nmcli.html).

`src/Common.tsx` and the initial build configuration were adapted from the local `decky-optiscaler` project. Its BSD 3-Clause license and notices are retained in `LICENSE`. No OptiScaler payloads or game-modification code are included.
