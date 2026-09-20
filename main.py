"""Decky composition root. RPC errors are values; startup failures stay inert."""
import os
import sys
from pathlib import Path

import decky

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "py_modules"))
from wifi_guard import GuardService, JsonSettingsStore, NmcliNetworkReader  # noqa: E402


class Plugin:
    _service = None
    _startup_error = "Wi-Fi Guard is still starting. Retry shortly."

    async def _main(self):
        self._service = None
        try:
            service = GuardService(
                JsonSettingsStore(Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / "settings.json"),
                NmcliNetworkReader(),
            )
            await service.initialize()
            self._service = service
            self._startup_error = None
        except Exception:
            self._startup_error = "Wi-Fi Guard could not load its settings. Check the plugin log and settings file, then reload Decky."
            try:
                decky.logger.exception(self._startup_error)
            except Exception:
                pass
            # Do not throw out of _main: Decky must not restart-loop the backend.

    async def _call(self, operation, *args):
        if self._service is None:
            return {"ok": False, "error": self._startup_error}
        try:
            return {"ok": True, "value": await operation(*args)}
        except Exception as exc:
            # Expected invalid input / disk / platform errors do not escape RPC.
            return {"ok": False, "error": str(exc)[:400] or "Backend operation failed"}

    async def get_state(self):
        return await self._call(self._service.state if self._service else None)

    async def save_settings(self, enabled, ssid):
        return await self._call(self._service.configure if self._service else None, enabled, ssid)

    async def set_owned_pause(self, owned):
        return await self._call(self._service.own if self._service else None, owned)

    async def _unload(self):
        pass  # No backend monitor, recurring task, or persistent child process.
