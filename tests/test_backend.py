import asyncio
import importlib.util
import json
import logging
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock

sys.modules['decky'] = types.SimpleNamespace(logger=logging.getLogger('test'))
spec = importlib.util.spec_from_file_location('backend', Path(__file__).resolve().parents[1] / 'main.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)

class ParsingTests(unittest.TestCase):
    def test_active_only_and_exact_whitespace(self):
        self.assertEqual(backend.parse_networks(':Other\n*: My Phone \n'), [' My Phone '])
    def test_colons_backslashes_unicode_and_deduplication(self):
        self.assertEqual(backend.parse_networks('*:Drew\\: café\\\\hotspot\n*:Drew\\: café\\\\hotspot\n'), ['Drew: café\\hotspot'])
    def test_multiple_adapters(self):
        self.assertEqual(backend.parse_networks('*:Phone\n*:Home'), ['Phone', 'Home'])
    def test_disconnected(self):
        self.assertEqual(backend.parse_networks(':Home\n:Phone'), [])
    def test_malformed_or_unreadable_active_name_is_not_disconnection(self):
        for data in ['broken', '*:', '*:one:two', '*:trailing\\']:
            with self.assertRaises(ValueError): backend.parse_networks(data)
    def test_validation_preserves_spaces_and_uses_utf8_bytes(self):
        self.assertEqual(backend.validate_settings(True, ' x ')['ssid'], ' x ')
        for value in ['é' * 17, 'x\ny', 'x\x00y']:
            with self.assertRaises(ValueError): backend.validate_settings(True, value)
        with self.assertRaises(ValueError): backend.validate_settings(1, 'x')

class PersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        backend.decky.DECKY_PLUGIN_SETTINGS_DIR = self.temp.name
        self.plugin = backend.Plugin()
        await self.plugin._main()
    async def asyncTearDown(self): self.temp.cleanup()
    async def test_reload_preserves_settings_and_ownership(self):
        await self.plugin.save_settings(True, 'Phone')
        await self.plugin.set_owned_pause(True)
        other = backend.Plugin()
        await other._main()
        self.assertEqual(other._data, {'enabled': True, 'ssid': 'Phone', 'owned_pause': True})
    async def test_settings_do_not_clobber_ownership(self):
        await self.plugin.set_owned_pause(True)
        await self.plugin.save_settings(False, 'Home')
        self.assertTrue(self.plugin._data['owned_pause'])
    async def test_write_failure_does_not_change_memory(self):
        with patch.object(Path, 'replace', side_effect=OSError('disk full')):
            with self.assertRaises(OSError): await self.plugin.set_owned_pause(True)
        self.assertFalse(self.plugin._data['owned_pause'])
    async def test_corrupt_journal_not_overwritten(self):
        self.plugin._path.write_text('bad json')
        with self.assertLogs('test', level='ERROR'): await self.plugin._main()
        with self.assertRaises(RuntimeError): await self.plugin.save_settings(True, 'Home')
        self.assertEqual(self.plugin._path.read_text(), 'bad json')
    async def test_network_error_explicit(self):
        with patch.object(self.plugin, '_networks', side_effect=FileNotFoundError):
            state = await self.plugin.get_state()
        self.assertIn('nmcli', state['network_error'])
    async def test_subprocess_timeout_kills_and_reaps(self):
        process = types.SimpleNamespace(returncode=None, communicate=AsyncMock(side_effect=asyncio.TimeoutError), wait=AsyncMock(), kill=lambda: setattr(process, 'returncode', -9))
        with patch.object(asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)):
            with self.assertRaises(asyncio.TimeoutError): await self.plugin._networks()
        self.assertEqual(process.returncode, -9)
        process.wait.assert_awaited_once()
