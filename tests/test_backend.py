import asyncio
import importlib.util
import logging
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock, Mock

sys.modules['decky'] = types.SimpleNamespace(logger=logging.getLogger('test'))
spec = importlib.util.spec_from_file_location('plugin', Path(__file__).resolve().parents[1] / 'main.py')
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
import wifi_guard as backend


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


class BackendTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        plugin.decky.DECKY_PLUGIN_SETTINGS_DIR = self.temp.name
        self.plugin = plugin.Plugin()
        await self.plugin._main()
        self.service = self.plugin._service
        self.path = Path(self.temp.name) / 'settings.json'
    async def asyncTearDown(self): self.temp.cleanup()
    async def test_reload_preserves_settings_and_ownership(self):
        self.assertTrue((await self.plugin.save_settings(True, 'Phone'))['ok'])
        self.assertTrue((await self.plugin.set_owned_pause(True))['ok'])
        other = plugin.Plugin(); await other._main()
        self.assertEqual(other._service.data, {'enabled': True, 'ssid': 'Phone', 'owned_pause': True})
    async def test_settings_do_not_clobber_ownership(self):
        await self.plugin.set_owned_pause(True); await self.plugin.save_settings(False, 'Home')
        self.assertTrue(self.service.data['owned_pause'])
    async def test_write_failure_is_error_value_and_keeps_memory(self):
        with patch.object(Path, 'replace', side_effect=OSError('disk full')):
            response = await self.plugin.set_owned_pause(True)
        self.assertFalse(response['ok']); self.assertIn('disk full', response['error'])
        self.assertFalse(self.service.data['owned_pause'])
    async def test_corrupt_journal_leaves_startup_inert_and_is_not_overwritten(self):
        self.path.write_text('bad json')
        with self.assertLogs('test', level='ERROR'): await self.plugin._main()
        for _ in range(10): self.assertFalse((await self.plugin.get_state())['ok'])
        self.assertFalse((await self.plugin.save_settings(True, 'Home'))['ok'])
        self.assertEqual(self.path.read_text(), 'bad json')
    async def test_unwritable_settings_directory_does_not_escape_startup(self):
        with patch.object(Path, 'mkdir', side_effect=PermissionError('denied')):
            with self.assertLogs('test', level='ERROR'): await self.plugin._main()
        self.assertFalse((await self.plugin.get_state())['ok'])
    async def test_logger_failure_cannot_crash_failed_startup(self):
        with patch.object(Path, 'mkdir', side_effect=PermissionError('denied')):
            with patch.object(plugin.decky.logger, 'exception', side_effect=RuntimeError('logger')):
                await self.plugin._main()
        self.assertFalse((await self.plugin.get_state())['ok'])
    async def test_rpc_before_initialization_returns_failure(self):
        fresh = plugin.Plugin()
        self.assertFalse((await fresh.get_state())['ok'])
    async def test_invalid_rpc_input_is_a_value_not_exception(self):
        self.assertFalse((await self.plugin.save_settings('yes', 'x'))['ok'])
        self.assertFalse((await self.plugin.set_owned_pause(1))['ok'])
    async def test_network_error_explicit(self):
        with patch.object(self.service.network, 'read', side_effect=FileNotFoundError):
            response = await self.plugin.get_state()
        self.assertTrue(response['ok']); self.assertIn('nmcli', response['value']['network_error'])
    async def test_serialized_writes_preserve_both_changes(self):
        await asyncio.gather(self.plugin.set_owned_pause(True), self.plugin.save_settings(False, 'Home'))
        self.assertEqual(self.service.data, {'owned_pause': True, 'enabled': False, 'ssid': 'Home'})
    async def test_oversized_journal_is_rejected_without_replacement(self):
        self.path.write_text(' ' * 4097)
        with self.assertLogs('test', level='ERROR'): await self.plugin._main()
        self.assertFalse((await self.plugin.get_state())['ok'])
        self.assertEqual(self.path.stat().st_size, 4097)


class SubprocessTests(unittest.IsolatedAsyncioTestCase):
    def process(self, chunks):
        process = types.SimpleNamespace(returncode=None, stdout=types.SimpleNamespace(read=AsyncMock(side_effect=chunks)), wait=AsyncMock())
        process.kill = Mock(side_effect=lambda: setattr(process, 'returncode', -9))
        return process
    async def test_timeout_kills_and_reaps(self):
        process = self.process([asyncio.TimeoutError()])
        with patch.object(asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)):
            with self.assertRaises(asyncio.TimeoutError): await backend.NmcliNetworkReader().read()
        process.kill.assert_called_once(); process.wait.assert_awaited_once()
    async def test_oversized_response_is_bounded_and_reaped(self):
        process = self.process([b'x' * 8192] * 33)
        with patch.object(asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)):
            with self.assertRaisesRegex(ValueError, 'size limit'): await backend.NmcliNetworkReader().read()
        process.kill.assert_called_once(); process.wait.assert_awaited_once()
    async def test_cancellation_reaps_child_then_propagates(self):
        process = self.process([asyncio.CancelledError()])
        with patch.object(asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)):
            with self.assertRaises(asyncio.CancelledError): await backend.NmcliNetworkReader().read()
        process.kill.assert_called_once(); process.wait.assert_awaited_once()
    async def test_success_uses_no_shell_no_scan_no_secrets(self):
        process = self.process([b'*:Phone\n:Home\n', b''])
        async def exited(): process.returncode = 0
        process.wait.side_effect = exited
        with patch.object(asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)) as spawn:
            self.assertEqual(await backend.NmcliNetworkReader().read(), ['Phone'])
        self.assertEqual(spawn.call_args.args[-2:], ('--rescan', 'no'))
        self.assertNotIn('--show-secrets', spawn.call_args.args)
        process.kill.assert_not_called()
