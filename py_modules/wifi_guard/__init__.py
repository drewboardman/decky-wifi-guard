"""Backend capability interfaces and their local interpreters."""
import asyncio
import json
import os
from pathlib import Path
from typing import Protocol


def validate_settings(enabled, ssid):
    if type(enabled) is not bool or not isinstance(ssid, str):
        raise ValueError("Invalid settings")
    if len(ssid.encode("utf-8")) > 32 or any(ord(c) < 32 or ord(c) == 127 for c in ssid):
        raise ValueError("Use a Wi-Fi name of up to 32 bytes without control characters")
    return {"enabled": enabled, "ssid": ssid}


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
    if len(networks) > 32:
        raise ValueError("Too many active network interfaces")
    return networks


class SettingsStore(Protocol):
    def load(self) -> dict: ...
    def save(self, value: dict) -> None: ...


class NetworkReader(Protocol):
    async def read(self) -> list: ...


class JsonSettingsStore:
    def __init__(self, path: Path):
        self.path = path

    def load(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            if self.path.stat().st_size > 4096:
                raise ValueError("Settings file is too large")
            saved = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"enabled": True, "ssid": "", "owned_pause": False}
        settings = validate_settings(saved["enabled"], saved["ssid"])
        if type(saved.get("owned_pause")) is not bool:
            raise ValueError("Invalid pause ownership")
        return {**settings, "owned_pause": saved["owned_pause"]}

    def save(self, value):
        temporary = self.path.with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(self.path)
        directory = os.open(self.path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


class NmcliNetworkReader:
    MAX_OUTPUT = 256 * 1024

    async def read(self):
        process = await asyncio.create_subprocess_exec(
            "nmcli", "--terse", "--escape", "yes", "--colors", "no",
            "--fields", "IN-USE,SSID", "device", "wifi", "list", "--rescan", "no",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            env={**os.environ, "LC_ALL": "C"},
        )

        async def collect():
            chunks, length = [], 0
            while True:
                chunk = await process.stdout.read(8192)
                if not chunk:
                    break
                length += len(chunk)
                if length > self.MAX_OUTPUT:
                    raise ValueError("NetworkManager response exceeded the size limit")
                chunks.append(chunk)
            await process.wait()
            if process.returncode:
                raise RuntimeError("NetworkManager could not report the active Wi-Fi network")
            return parse_networks(b"".join(chunks).decode("utf-8", errors="strict"))

        try:
            return await asyncio.wait_for(collect(), timeout=4)
        finally:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                # Bounded cleanup even if the child fails to report exit.
                try:
                    await asyncio.wait_for(process.wait(), timeout=0.5)
                except asyncio.TimeoutError:
                    pass


class GuardService:
    def __init__(self, store: SettingsStore, network: NetworkReader):
        self.store = store
        self.network = network
        self.data = None
        self.lock = asyncio.Lock()

    async def initialize(self):
        self.data = await asyncio.to_thread(self.store.load)

    async def state(self):
        async with self.lock:
            networks, error = [], None
            try:
                networks = await self.network.read()
            except FileNotFoundError:
                error = "Wi-Fi detection requires NetworkManager (nmcli) on SteamOS."
            except asyncio.TimeoutError:
                error = "Wi-Fi detection timed out. Keeping the existing download state."
            except Exception as exc:
                error = str(exc)[:400]
            return {**self.data, "networks": networks, "network_error": error}

    async def configure(self, enabled, ssid):
        settings = validate_settings(enabled, ssid)
        async with self.lock:
            data = {**self.data, **settings}
            await asyncio.to_thread(self.store.save, data)
            self.data = data
        return settings

    async def own(self, owned):
        if type(owned) is not bool:
            raise ValueError("Invalid ownership value")
        async with self.lock:
            data = {**self.data, "owned_pause": owned}
            await asyncio.to_thread(self.store.save, data)
            self.data = data
