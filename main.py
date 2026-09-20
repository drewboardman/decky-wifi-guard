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
    _startup_code = "backend_unavailable"

    def _report_once(self, code, error):
        if code in self._logged_errors:
            return
        self._logged_errors.add(code)
        try:
            decky.logger.error("Wi-Fi Guard: %s", code, exc_info=(type(error), error, error.__traceback__))
        except Exception:
            pass

    async def _main(self):
        self._service = None
        self._logged_errors = set()
        try:
            service = GuardService(
                JsonSettingsStore(Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / "settings.json"),
                NmcliNetworkReader(),
                self._report_once,
            )
            await service.initialize()
            self._service = service
            self._startup_error = None
        except Exception as exc:
            self._startup_error = "Wi-Fi Guard could not load its settings."
            self._startup_code = "settings_unreadable" if isinstance(exc, (OSError, ValueError, KeyError, TypeError)) else "unknown"
            self._report_once(self._startup_code, exc)
            # Do not throw out of _main: Decky must not restart-loop the backend.

    async def _call(self, operation, *args):
        if self._service is None:
            return {"ok": False, "error": self._startup_error, "error_code": self._startup_code}
        try:
            return {"ok": True, "value": await operation(*args)}
        except Exception as exc:
            code = "invalid_settings" if isinstance(exc, ValueError) else "storage_unavailable" if isinstance(exc, OSError) else "unknown"
            self._report_once(code, exc)
            return {"ok": False, "error": str(exc)[:400] or "Backend operation failed", "error_code": code}

    async def get_state(self):
        return await self._call(self._service.state if self._service else None)

    async def save_settings(self, enabled, ssid):
        return await self._call(self._service.configure if self._service else None, enabled, ssid)

    async def set_owned_pause(self, owned):
        return await self._call(self._service.own if self._service else None, owned)

    async def _unload(self):
        pass  # No backend monitor, recurring task, or persistent child process.
