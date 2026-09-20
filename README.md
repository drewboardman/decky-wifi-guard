# Wi-Fi Guard

A Decky Loader plugin that pauses Steam downloads on a Wi-Fi network you choose, then resumes them when you leave. It reacts to Steam's own network and download events, so there is no polling, no pings, and no repeated Wi-Fi scans.

## Install

* Download the [latest release](https://github.com/drewboardman/decky-wifi-guard/releases)

Two ways to install this:

1. In Game Mode, open Decky's settings, turn on Developer mode, and use Install Plugin from URL with the zip's download link;
2. or unpack the zip into `~/homebrew/plugins/` and restart Decky Loader.

## Use

1. Open **Wi-Fi Guard** in the Quick Access menu.
2. Press **Use current network**, or type your network name (SSID) exactly and press **Save network**.
3. Leave **Pause on this network** enabled.

Steam game installs, updates, and Workshop downloads pause on that network and resume after you leave — but only if the guard paused them. A pause you made yourself is left alone, and you can turn the guard off when you want to download on the protected network.

Wi-Fi stays on, so games, browsing, and Steam Cloud keep working. Only Steam downloads are affected; other apps and system updates are untouched. Requires Gaming Mode with Decky running.
