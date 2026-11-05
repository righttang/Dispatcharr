import unittest
from unittest.mock import Mock, patch

from apps.proxy.live_proxy.redis_keys import RedisKeys
from apps.proxy.live_proxy.server import ProxyServer


class HlsOutputStartupTests(unittest.TestCase):
    def server(self, fmt, state):
        server = Mock()
        server.output_managers = {}
        server.worker_id = 'reader'
        server.am_i_owner.return_value = False
        server._parse_output_key.side_effect = ProxyServer._parse_output_key
        server.redis_client.get.side_effect = lambda key: (
            state if key == RedisKeys.output_state('channel', fmt) else 'owner'
        )
        return server

    def test_existing_hls_segmenter_is_usable_before_its_first_segment(self):
        server = self.server('hls:p3', 'initializing')
        self.assertTrue(ProxyServer.ensure_output_format(server, 'channel', 'hls:p3'))
        server.redis_client.publish.assert_not_called()

    def test_owner_started_hls_does_not_wait_for_a_segment_to_be_published(self):
        server = self.server('hls:p3', 'initializing')
        original = server.redis_client.get.side_effect
        calls = 0

        def read(key):
            nonlocal calls
            calls += 1
            return None if calls == 1 else original(key)

        server.redis_client.get.side_effect = read
        with patch('apps.proxy.live_proxy.server.gevent.sleep'):
            self.assertTrue(ProxyServer.ensure_output_format(server, 'channel', 'hls:p3'))
        server.redis_client.publish.assert_called_once()

    def test_initializing_fmp4_still_waits_for_active_output(self):
        server = self.server('fmp4', 'initializing')
        clock = iter([0, 0, 6])
        with patch('apps.proxy.live_proxy.server.time.time', side_effect=lambda: next(clock, 6)), patch('apps.proxy.live_proxy.server.gevent.sleep'):
            self.assertFalse(ProxyServer.ensure_output_format(server, 'channel', 'fmp4'))
