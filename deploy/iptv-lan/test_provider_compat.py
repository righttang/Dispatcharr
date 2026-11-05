import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest
from unittest.mock import AsyncMock, patch

import provider_compat


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ('/provider', '/loop'):
            self.send_response(302)
            self.send_header('Location', '/playlist.m3u8' if self.path == '/provider' else '/loop')
            self.send_header('Content-Length', '0')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(b'<html>Redirect</html>')
        else:
            body = b'#EXTM3U\n#EXTINF:6,\nsegment.ts\n' if self.path == '/playlist.m3u8' else b'<html>Not video</html>'
            self.send_response(200)
            self.send_header('Content-Type', 'application/vnd.apple.mpegurl')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, *args):
        pass


class RedirectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_redirect_with_extra_html_does_not_discard_valid_playlist(self):
        self.assertEqual(provider_compat.resolve_playlist(self.base + '/provider'), self.base + '/playlist.m3u8')

    def test_html_is_rejected_even_when_content_type_claims_hls(self):
        with self.assertRaisesRegex(ValueError, 'not an HLS playlist'):
            provider_compat.resolve_playlist(self.base + '/html')

    def test_redirect_loop_is_bounded(self):
        with self.assertRaisesRegex(ValueError, 'Too many playlist redirects'):
            provider_compat.resolve_playlist(self.base + '/loop')


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_configured_provider_is_resolved_and_parameters_are_preserved(self):
        original = AsyncMock(return_value={'speed': 1.0})
        adapted = provider_compat.wrap_get_result(original, {('provider.test', '/live.php')})
        headers = {'User-Agent': 'Player'}
        with patch.object(provider_compat, 'resolve_playlist', return_value='http://cdn.test/live.m3u8') as resolve:
            result = await adapted('http://provider.test/live.php?id=5', headers, None, False, 8)
        self.assertEqual(result['speed'], 1.0)
        resolve.assert_called_once_with('http://provider.test/live.php?id=5', headers, 8)
        original.assert_awaited_once_with('http://cdn.test/live.m3u8', headers, None, False, 8)

    async def test_other_providers_keep_the_original_behavior(self):
        original = AsyncMock(return_value={'speed': 1.0})
        adapted = provider_compat.wrap_get_result(original, {('provider.test', '/live.php')})
        with patch.object(provider_compat, 'resolve_playlist') as resolve:
            await adapted('http://other.test/video', timeout=5)
        resolve.assert_not_called()
        original.assert_awaited_once_with('http://other.test/video', None, timeout=5)

    async def test_resolution_failure_falls_back_without_accepting_the_source(self):
        original = AsyncMock(return_value={'speed': 0.0, 'delay': -1})
        adapted = provider_compat.wrap_get_result(original, {('provider.test', '/live.php')})
        with patch.object(provider_compat, 'resolve_playlist', side_effect=ValueError('not video')):
            with self.assertLogs(provider_compat.LOG, level='WARNING'):
                result = await adapted('http://provider.test/live.php?id=5', timeout=5)
        self.assertEqual(result['speed'], 0.0)
        original.assert_awaited_once_with('http://provider.test/live.php?id=5', None, timeout=5)

    async def test_cancelled_capture_is_not_retried(self):
        original = AsyncMock()
        adapted = provider_compat.wrap_get_result(original, {('provider.test', '/live.php')})
        with patch.object(provider_compat, 'resolve_playlist', side_effect=asyncio.CancelledError):
            with self.assertRaises(asyncio.CancelledError):
                await adapted('http://provider.test/live.php?id=5')
        original.assert_not_called()


if __name__ == '__main__':
    unittest.main()
