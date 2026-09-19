"""Wi-Fi Download Guard: read NetworkManager state; persist settings and pause ownership."""
import asyncio
import json
import os
from pathlib import Path

import decky


def split_nmcli(line):
    fields, current, escaped = [], [], False
    for char in line:
        if escaped:
            current.append(char)
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == ":":
            fields.append("".join(current))
            current = []
        else:
            current.append(char)
    if escaped:
        raise ValueError("Incomplete NetworkManager response")
    return fields + ["".join(current)]


def parse_networks(output):
    networks = []
    for line in output.splitlines():
        if not line:
            continue
        fields = split_nmcli(line)
        if len(fields) != 2 or fields[0] not in ("", "*", " "):
            raise ValueError("Unexpected NetworkManager response")
        if fields[0] == "*":
            if not fields[1]:
                raise ValueError("Connected Wi-Fi has no readable network name")
            if fields[1] not in networks:
                networks.append(fields[1])
    return networks


def validate_settings(enabled, ssid):
    if type(enabled) is not bool or not isinstance(ssid, str):
        raise ValueError("Invalid settings")
    if len(ssid.encode("utf-8")) > 32 or any(ord(c) < 32 or ord(c) == 127 for c in ssid):
        raise ValueError("Use a Wi-Fi name of up to 32 bytes without control characters")
    return {"enabled": enabled, "ssid": ssid}


class Plugin:
    async def _main(self):
        self._lock = asyncio.Lock()
        self._path = Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / "settings.json"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._data = {"enabled": True, "ssid": "", "owned_pause": False}
        self._load_error = None
        try:
            saved = json.loads(self._path.read_text())
            settings = validate_settings(saved["enabled"], saved["ssid"])
            if type(saved.get("owned_pause")) is not bool:
                raise ValueError("Invalid pause ownership")
            self._data = {**settings, "owned_pause": saved["owned_pause"]}
        except FileNotFoundError:
            pass
        except Exception:
            # Do not overwrite an unreadable journal or guess who paused Steam.
            self._load_error = "Saved settings could not be read. Check settings.json before restarting the plugin."
            decky.logger.exception("Could not load Wi-Fi Download Guard settings")

    def _check(self):
        if self._load_error:
            raise RuntimeError(self._load_error)

    def _save(self, data):
        temporary = self._path.with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(self._path)
        self._data = data

    async def _networks(self):
        process = await asyncio.create_subprocess_exec(
            "nmcli", "--terse", "--escape", "yes", "--colors", "no",
            "--fields", "IN-USE,SSID", "device", "wifi", "list", "--rescan", "no",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "LC_ALL": "C"},
        )
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=4)
        except BaseException:
            if process.returncode is None:
                process.kill()
            await process.wait()
            raise
        if process.returncode:
            raise RuntimeError("NetworkManager could not report the active Wi-Fi network")
        return parse_networks(stdout.decode("utf-8", errors="strict"))

    async def get_state(self):
        self._check()
        networks, error = [], None
        try:
            networks = await self._networks()
        except FileNotFoundError:
            error = "Wi-Fi detection requires NetworkManager (nmcli) on SteamOS."
        except asyncio.TimeoutError:
            error = "Wi-Fi detection timed out. Keeping the existing download state."
        except Exception as exc:
            error = str(exc)
        return {**self._data, "networks": networks, "network_error": error}

    async def save_settings(self, enabled, ssid):
        self._check()
        settings = validate_settings(enabled, ssid)
        async with self._lock:
            self._save({**self._data, **settings})
        return settings

    async def set_owned_pause(self, owned):
        self._check()
        if type(owned) is not bool:
            raise ValueError("Invalid ownership value")
        async with self._lock:
            self._save({**self._data, "owned_pause": owned})

    async def _unload(self):
        pass  # The frontend owns Steam API cleanup; the journal survives crashes.
